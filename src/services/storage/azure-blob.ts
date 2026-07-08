import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  BlobClient,
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { ModelError, ValidationError } from "../../utils/errors.js";
import { redactUrlForLogs } from "../download-auth.js";
import type { StorageUploadResult, StorageUploadSource } from "./types.js";
import { safeErrorDetails, withPrefix } from "./utils.js";

const AZURE_BLOB_HOST_SUFFIX = ".blob.core.windows.net";
const AZURE_ACCOUNT_RE = /^[a-z0-9]{3,24}$/;

export function isAzureBlobUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && accountFromBlobHost(parsed.hostname) !== undefined;
  } catch {
    return false;
  }
}

function hasQuery(url: string): boolean {
  try {
    return new URL(url).search.length > 1;
  } catch {
    return false;
  }
}

function accountFromBlobHost(hostname: string): string | undefined {
  if (!hostname.endsWith(AZURE_BLOB_HOST_SUFFIX)) return undefined;
  const account = hostname.slice(0, -AZURE_BLOB_HOST_SUFFIX.length);
  return AZURE_ACCOUNT_RE.test(account) ? account : undefined;
}

function accountFromConnectionString(connectionString: string): string | undefined {
  const account = /(?:^|;)AccountName=([^;]+)/i.exec(connectionString)?.[1];
  if (account) return account.toLowerCase();

  const endpoint = /(?:^|;)BlobEndpoint=([^;]+)/i.exec(connectionString)?.[1];
  if (!endpoint) return undefined;
  try {
    return accountFromBlobHost(new URL(endpoint).hostname);
  } catch {
    return undefined;
  }
}

function blobServiceClientFromEnv(): { account?: string; client: BlobServiceClient } | undefined {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    return {
      account: accountFromConnectionString(connectionString),
      client: BlobServiceClient.fromConnectionString(connectionString),
    };
  }

  const account = process.env.AZURE_STORAGE_ACCOUNT;
  const key = process.env.AZURE_STORAGE_KEY;
  if (account && key) {
    const normalizedAccount = account.toLowerCase();
    return {
      account: normalizedAccount,
      client: new BlobServiceClient(
        `https://${normalizedAccount}.blob.core.windows.net`,
        new StorageSharedKeyCredential(normalizedAccount, key),
      ),
    };
  }

  return undefined;
}

function parseAzureBlobUrl(url: string): { account: string; container: string; blob: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid Azure Blob URL.");
  }
  const account = accountFromBlobHost(parsed.hostname);
  if (parsed.protocol !== "https:" || !account) {
    throw new ValidationError(
      "Invalid Azure Blob URL. Expected https://<account>.blob.core.windows.net/<container>/<blob>.",
    );
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new ValidationError(
      "Invalid Azure Blob URL. Expected https://<account>.blob.core.windows.net/<container>/<blob>.",
    );
  }
  return { account, container: parts[0], blob: parts.slice(1).join("/") };
}

function blobClientForDownload(url: string): BlobClient {
  const parsed = parseAzureBlobUrl(url);
  if (hasQuery(url)) {
    return new BlobClient(url);
  }

  const envClient = blobServiceClientFromEnv();
  if (envClient) {
    if (!envClient.account || envClient.account !== parsed.account) {
      throw new ValidationError("Azure Blob URL account must match configured Azure storage account.");
    }
    return envClient.client.getContainerClient(parsed.container).getBlobClient(parsed.blob);
  }
  return new BlobClient(url);
}

function blobServiceClientForUpload(): BlobServiceClient {
  const envClient = blobServiceClientFromEnv();
  if (!envClient) {
    throw new ValidationError(
      "Azure upload requires AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT plus AZURE_STORAGE_KEY.",
    );
  }
  return envClient.client;
}

export async function downloadAzureBlobToFile(url: string, targetPath: string): Promise<void> {
  try {
    const response = await blobClientForDownload(url).download();
    if (!response.readableStreamBody) {
      throw new ModelError("Azure Blob download response has no body", {
        url: redactUrlForLogs(url),
      });
    }
    await pipeline(response.readableStreamBody, createWriteStream(targetPath));
  } catch (err) {
    if (err instanceof ModelError || err instanceof ValidationError) throw err;
    throw new ModelError("Azure Blob download failed", {
      url: redactUrlForLogs(url),
      ...safeErrorDetails(err),
    });
  }
}

export async function uploadAzureBlobFile(
  source: StorageUploadSource,
  destination: { container: string; blob_prefix?: string },
): Promise<StorageUploadResult> {
  const blobName = withPrefix(destination.blob_prefix, source.filename);
  try {
    const blockBlobClient = blobServiceClientForUpload()
      .getContainerClient(destination.container)
      .getBlockBlobClient(blobName);
    const options = source.contentType
      ? { blobHTTPHeaders: { blobContentType: source.contentType } }
      : undefined;
    if (source.path) {
      await blockBlobClient.uploadStream(createReadStream(source.path), undefined, undefined, options);
    } else {
      await blockBlobClient.uploadData(source.data ?? Buffer.alloc(0), options);
    }
    return { provider: "azure", url: redactUrlForLogs(blockBlobClient.url) };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ModelError("Azure Blob upload failed", safeErrorDetails(err));
  }
}
