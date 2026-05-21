import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";

export interface ViewImageResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}

const SUPPORTED_IMAGE_MIME_PREFIX = "image/";

/**
 * Fetch a registered asset's bytes and return them as an MCP image content
 * block so the agent can see the actual image. Throws on missing/expired
 * assets and on non-image mime types (audio/video are not viewable inline).
 */
export async function viewAssetImage(assetId: string): Promise<ViewImageResult> {
  const record = AssetRegistry.get(assetId);
  if (!record) {
    throw new Error(
      `No asset found for id "${assetId}". It may have expired or never been registered.`,
    );
  }

  const validType = record.type === "output" || record.type === "input" || record.type === "temp";
  const fetchType: "output" | "input" | "temp" = validType
    ? (record.type as "output" | "input" | "temp")
    : "output";

  const { base64, mimeType } = await getOutputImage(
    record.filename,
    fetchType,
    record.subfolder,
  );

  if (!mimeType.startsWith(SUPPORTED_IMAGE_MIME_PREFIX)) {
    throw new Error(
      `Asset "${assetId}" is not an image (mime: ${mimeType}). view_image only supports PNG/JPEG/WebP.`,
    );
  }

  return {
    content: [
      {
        type: "text",
        text: `Asset ${assetId} — ${record.filename} (${mimeType})`,
      },
      {
        type: "image",
        data: base64,
        mimeType,
      },
    ],
  };
}
