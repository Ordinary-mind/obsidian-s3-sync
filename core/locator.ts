import { normalizeProtocolPrefix } from "../protocol/keys";
import { protocolRoot } from "../protocol/keys";
import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";

export interface RepositoryEndpoint {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}

export interface RepositoryLocator extends RepositoryEndpoint {
  normalizedPrefix: string;
}

export function createRepositoryLocator(
  locator: RepositoryEndpoint & { prefix: string },
  allowLoopbackHttp = false,
): Readonly<RepositoryLocator> {
  if (!validateRepositoryEndpoint(locator, allowLoopbackHttp)) throw new Error("invalid repository endpoint");
  if (!isValidBucket(locator.bucket)) throw new Error("invalid repository bucket");
  return Object.freeze({
    endpoint: new URL(locator.endpoint).origin,
    region: locator.region,
    bucket: locator.bucket,
    forcePathStyle: locator.forcePathStyle,
    normalizedPrefix: normalizeProtocolPrefix(locator.prefix),
  });
}

export function repositoryRoot(locator: RepositoryLocator, repositoryId: string): string {
  return protocolRoot(locator.normalizedPrefix, repositoryId);
}

export function repositoryFingerprint(
  locator: RepositoryLocator,
  repositoryId: string,
  descriptorHash: string,
): string {
  const bytes = new TextEncoder().encode(canonicalizeProtocolJson({
    endpoint: locator.endpoint,
    region: locator.region,
    bucket: locator.bucket,
    forcePathStyle: locator.forcePathStyle,
    normalizedPrefix: locator.normalizedPrefix,
    repositoryId,
    descriptorHash,
  }));
  return sha256Hex(bytes);
}

export function validateRepositoryEndpoint(locator: RepositoryEndpoint, allowLoopbackHttp = false): boolean {
  let url: URL;
  try { url = new URL(locator.endpoint); } catch { return false; }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const allowedProtocol = url.protocol === "https:" || allowLoopbackHttp && url.protocol === "http:" && loopback;
  const originOnly = locator.endpoint === url.origin && url.username === "" && url.password === "";
  return allowedProtocol && originOnly && /^[A-Za-z0-9._-]{1,128}$/.test(locator.region) && isValidBucket(locator.bucket);
}

function isValidBucket(bucket: string): boolean {
  return bucket.length >= 1 && bucket.length <= 255 && !/[\u0000-\u001f\u007f/\\]/.test(bucket);
}
