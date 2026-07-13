import { sha256Hex } from "../protocol/hash";

export type StableCaptureRead =
  | { type: "file"; bytes: Uint8Array }
  | { type: "missing" | "other" };

export interface StableCapture {
  bytes: Uint8Array;
  hash: string;
  size: number;
}

export async function captureStableBytes(
  read: () => Promise<StableCaptureRead>,
): Promise<StableCapture | undefined> {
  const first = await read();
  if (first.type !== "file") return undefined;
  const captured = new Uint8Array(first.bytes);
  const hash = sha256Hex(captured);
  const second = await read();
  if (second.type !== "file" || second.bytes.byteLength !== captured.byteLength || sha256Hex(second.bytes) !== hash) {
    return undefined;
  }
  return { bytes: captured, hash, size: captured.byteLength };
}
