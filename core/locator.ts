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

export type RepositoryConfigurationField =
  | "endpoint"
  | "region"
  | "bucket"
  | "prefix"
  | "access-key-id"
  | "secret-access-key";
export type RepositoryConfigurationIssue =
  | "required"
  | "invalid-url"
  | "https-required"
  | "origin-only"
  | "invalid-region"
  | "invalid-bucket"
  | "invalid-prefix";

export class RepositoryConfigurationError extends Error {
  readonly kind = "connection-configuration";

  constructor(
    readonly field: RepositoryConfigurationField,
    readonly issue: RepositoryConfigurationIssue,
  ) {
    super("repository connection configuration is invalid");
    this.name = "RepositoryConfigurationError";
  }
}

export function createRepositoryLocator(
  locator: RepositoryEndpoint & { prefix: string },
  allowLoopbackHttp = false,
): Readonly<RepositoryLocator> {
  const issue = repositoryEndpointConfigurationIssue(locator, allowLoopbackHttp);
  if (issue) throw new RepositoryConfigurationError(issue.field, issue.issue);
  let normalizedPrefix: string;
  try {
    normalizedPrefix = normalizeProtocolPrefix(locator.prefix);
  } catch {
    throw new RepositoryConfigurationError("prefix", "invalid-prefix");
  }
  return Object.freeze({
    endpoint: new URL(locator.endpoint).origin,
    region: locator.region,
    bucket: locator.bucket,
    forcePathStyle: locator.forcePathStyle,
    normalizedPrefix,
  });
}

export function repositoryRoot(locator: RepositoryLocator, repositoryId: string): string {
  return protocolRoot(locator.normalizedPrefix, repositoryId);
}

export function repositoryFingerprint(
  scope: Pick<RepositoryLocator, "bucket" | "normalizedPrefix">,
  repositoryId: string,
  descriptorHash: string,
): string {
  const bytes = new TextEncoder().encode(canonicalizeProtocolJson({
    bucket: scope.bucket,
    normalizedPrefix: scope.normalizedPrefix,
    repositoryId,
    descriptorHash,
  }));
  return sha256Hex(bytes);
}

export function validateRepositoryEndpoint(locator: RepositoryEndpoint, allowLoopbackHttp = false): boolean {
  return repositoryEndpointConfigurationIssue(locator, allowLoopbackHttp) === undefined;
}

export function repositoryEndpointConfigurationIssue(
  locator: RepositoryEndpoint,
  allowLoopbackHttp = false,
): { field: RepositoryConfigurationField; issue: RepositoryConfigurationIssue } | undefined {
  if (locator.endpoint.length === 0) return { field: "endpoint", issue: "required" };
  let url: URL;
  try { url = new URL(locator.endpoint); } catch { return { field: "endpoint", issue: "invalid-url" }; }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const allowedProtocol = url.protocol === "https:" || allowLoopbackHttp && url.protocol === "http:" && loopback;
  if (!allowedProtocol) return { field: "endpoint", issue: "https-required" };
  const originOnly = locator.endpoint === url.origin && url.username === "" && url.password === "";
  if (!originOnly) return { field: "endpoint", issue: "origin-only" };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(locator.region)) return { field: "region", issue: "invalid-region" };
  if (!isValidBucket(locator.bucket)) return { field: "bucket", issue: locator.bucket.length === 0 ? "required" : "invalid-bucket" };
  return undefined;
}

function isValidBucket(bucket: string): boolean {
  return bucket.length >= 1 && bucket.length <= 255 && !/[\u0000-\u001f\u007f/\\]/.test(bucket);
}
