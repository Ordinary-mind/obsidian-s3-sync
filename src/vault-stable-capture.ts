import { createReadStream } from "node:fs";
import { FileSystemAdapter, TFile, Vault } from "obsidian";
import type { ImmutableContentStaging } from "../core/content-staging";
import { captureStableBytes, type StableCapture } from "../core/stable-capture";
import {
  captureStableStreamHash,
  captureStableStreamToStaging,
  type StableStreamCaptureResult,
  type StreamReadObservation,
} from "../core/streaming-capture";
import { protocolLimits } from "../protocol/limits";
import { repositoryPerformanceProfile } from "../core/performance-profile";

export type StableVaultFileCapture = Pick<StableCapture, "hash" | "size">;

export async function captureStableVaultFile(vault: Vault, path: string): Promise<StableVaultFileCapture | undefined> {
  if (vault.adapter instanceof FileSystemAdapter) {
    const result = await captureStableStreamHash({
      read: () => readVaultFileStream(vault, path),
      quietWindow: yieldToEventLoop,
      maxBytes: protocolLimits.blobBytes,
    });
    return result.status === "captured" ? { hash: result.hash, size: result.size } : undefined;
  }
  const captured = await captureStableBytes(async () => {
    const entry = vault.getAbstractFileByPath(path);
    if (!entry) return { type: "missing" };
    if (!(entry instanceof TFile)) return { type: "other" };
    return { type: "file", bytes: new Uint8Array(await vault.readBinary(entry)) };
  });
  return captured ? { hash: captured.hash, size: captured.size } : undefined;
}

export async function captureStableVaultFileToStaging(
  vault: Vault,
  path: string,
  staging: ImmutableContentStaging,
  signal?: AbortSignal,
): Promise<StableStreamCaptureResult> {
  const entry = vault.getAbstractFileByPath(path);
  const estimatedBytes = entry instanceof TFile ? entry.stat.size : undefined;
  return captureStableStreamToStaging({
    read: () => readVaultFileStream(vault, path),
    staging,
    quietWindow: yieldToEventLoop,
    estimatedBytes,
    maxBytes: protocolLimits.blobBytes,
    signal,
  });
}

async function readVaultFileStream(vault: Vault, path: string): Promise<StreamReadObservation> {
  const entry = vault.getAbstractFileByPath(path);
  if (!entry) return { type: "missing" };
  if (!(entry instanceof TFile)) return { type: "other" };
  if (vault.adapter instanceof FileSystemAdapter) {
    return {
      type: "file",
      chunks: createReadStream(vault.adapter.getFullPath(path), {
        highWaterMark: repositoryPerformanceProfile.streamChunkBytes,
      }),
    };
  }
  return { type: "file", chunks: oneChunk(new Uint8Array(await vault.readBinary(entry))) };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
