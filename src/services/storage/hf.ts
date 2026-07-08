import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { ModelError, ValidationError } from "../../utils/errors.js";
import type { StorageUploadResult, StorageUploadSource } from "./types.js";
import { withPrefix } from "./utils.js";

const execFileAsync = promisify(execFile);
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/;

async function findHfCli(): Promise<"hf" | "huggingface-cli"> {
  for (const command of ["hf", "huggingface-cli"] as const) {
    try {
      await execFileAsync(command, ["--version"]);
      return command;
    } catch {
      // Try the next known CLI name.
    }
  }
  throw new ValidationError(
    "hf upload requires the hf CLI. Install and authenticate `hf` or `huggingface-cli` first.",
  );
}

function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
    throw new ValidationError("hf.repo must be in owner/name format.");
  }
}

function validateRemotePath(path: string): void {
  if (ASCII_CONTROL_RE.test(path)) {
    throw new ValidationError("hf remote path cannot contain ASCII control characters.");
  }

  for (const segment of path.split("/")) {
    if (segment === "..") {
      throw new ValidationError("hf remote path cannot contain '..' segments.");
    }
    if (segment.startsWith("-")) {
      throw new ValidationError("hf remote path segments cannot start with '-'.");
    }
  }
}

export async function uploadHfFile(
  source: StorageUploadSource,
  destination: { repo: string; repo_type?: "model" | "dataset" | "space"; path?: string },
): Promise<StorageUploadResult> {
  validateRepo(destination.repo);
  const repoType = destination.repo_type ?? "model";
  const remotePath = withPrefix(destination.path, source.filename);
  validateRemotePath(remotePath);
  const command = await findHfCli();
  let tempDir: string | undefined;
  let localPath = source.path;
  try {
    if (!localPath) {
      tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-hf-upload-"));
      localPath = join(tempDir, basename(source.filename));
      await writeFile(localPath, source.data ?? Buffer.alloc(0));
    }

    const args = ["upload"];
    if (repoType !== "model") args.push("--repo-type", repoType);
    args.push("--", destination.repo, localPath, remotePath);
    await execFileAsync(command, args);

    const prefix = repoType === "dataset" ? "datasets/" : repoType === "space" ? "spaces/" : "";
    return {
      provider: "hf",
      url: `https://huggingface.co/${prefix}${destination.repo}/blob/main/${remotePath}`,
    };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ModelError("hf upload failed", {
      name: err instanceof Error ? err.name : undefined,
      code: typeof (err as { code?: unknown })?.code === "string"
        ? (err as { code: string }).code
        : undefined,
    });
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
