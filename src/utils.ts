import { normalizePath, TAbstractFile, TFile, Vault } from "obsidian";

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${id}`;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied.buffer;
}

export function textToArrayBuffer(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value));
}

export function arrayBufferToText(value: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(value);
}

export function encodePathForKey(path: string): string {
  return normalizePath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? `${trimmed}/` : "";
}

export function getTFile(vault: Vault, path: string): TFile | null {
  const file: TAbstractFile | null = vault.getAbstractFileByPath(normalizePath(path));
  return file instanceof TFile ? file : null;
}

export async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  parts.pop();

  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.adapter.exists(current))) {
      await vault.createFolder(current);
    }
  }
}

export function createConflictPath(path: string, deviceId: string): string {
  const safeDevice = deviceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  const folder = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : "";
  const name = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const dotIndex = name.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${folder}${name}.conflict-${safeDevice}-${stamp}`;
  }

  return `${folder}${name.slice(0, dotIndex)}.conflict-${safeDevice}-${stamp}${name.slice(dotIndex)}`;
}

export function wildcardToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern.trim());
  let source = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}

export function parseIgnorePatterns(patterns: string): RegExp[] {
  return patterns
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(wildcardToRegExp);
}

export function isIgnored(path: string, patterns: RegExp[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => pattern.test(normalized));
}

export async function bodyToArrayBuffer(body: unknown): Promise<ArrayBuffer> {
  if (!body) {
    return new ArrayBuffer(0);
  }

  const bodyWithTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof bodyWithTransform.transformToByteArray === "function") {
    return toArrayBuffer(await bodyWithTransform.transformToByteArray());
  }

  if (body instanceof Uint8Array) {
    return toArrayBuffer(body);
  }

  if (body instanceof ArrayBuffer) {
    return body;
  }

  const bodyWithArrayBuffer = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof bodyWithArrayBuffer.arrayBuffer === "function") {
    return await bodyWithArrayBuffer.arrayBuffer();
  }

  const readable = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of readable) {
    chunks.push(chunk);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return toArrayBuffer(merged);
}
