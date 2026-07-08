import { ValidationError } from "../../utils/errors.js";
import { isAzureBlobUrl, downloadAzureBlobToFile, uploadAzureBlobFile } from "./azure-blob.js";
import { uploadHfFile } from "./hf.js";
import { isHttpUrl, uploadHttpFile } from "./http.js";
import { downloadS3ToFile, isS3Url, uploadS3File } from "./s3.js";
import type {
  CloudStorageAuth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

export type UploadDestination =
  | { s3: { bucket: string; prefix?: string; async?: boolean } }
  | { azure: { container: string; blob_prefix?: string } }
  | { http: { url: string } }
  | { hf: { repo: string; repo_type?: "model" | "dataset" | "space"; path?: string } };

export function supportsCloudDownload(url: string): boolean {
  return isS3Url(url) || isAzureBlobUrl(url);
}

export async function downloadCloudUrlToFile(
  url: string,
  targetPath: string,
  auth: CloudStorageAuth = {},
): Promise<void> {
  if (isS3Url(url)) {
    await downloadS3ToFile(url, targetPath, auth.s3);
    return;
  }
  if (isAzureBlobUrl(url)) {
    await downloadAzureBlobToFile(url, targetPath);
    return;
  }
  throw new ValidationError(
    "Unsupported cloud storage download URL. Expected s3://bucket/key or an Azure Blob URL.",
  );
}

export async function uploadToStorage(
  source: StorageUploadSource,
  destination: UploadDestination,
  auth: CloudStorageAuth = {},
): Promise<StorageUploadResult> {
  const keys = Object.keys(destination);
  if (keys.length !== 1) {
    throw new ValidationError("Provide exactly one upload destination: s3, azure, http, or hf.");
  }

  if ("s3" in destination) {
    return uploadS3File(source, destination.s3, auth.s3);
  }
  if ("azure" in destination) {
    return uploadAzureBlobFile(source, destination.azure);
  }
  if ("http" in destination) {
    if (!isHttpUrl(destination.http.url)) {
      throw new ValidationError("http.url must start with http:// or https://.");
    }
    return uploadHttpFile(source, destination.http);
  }
  if ("hf" in destination) {
    return uploadHfFile(source, destination.hf);
  }

  throw new ValidationError("Unsupported upload destination. Expected s3, azure, http, or hf.");
}

export type {
  CloudStorageAuth,
  S3Auth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

