export interface RepositoryEndpoint {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function validateRepositoryEndpoint(locator: RepositoryEndpoint, allowLoopbackHttp = false): boolean {
  let url: URL;
  try { url = new URL(locator.endpoint); } catch { return false; }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  return (url.protocol === "https:" || allowLoopbackHttp && url.protocol === "http:" && loopback) && /^[A-Za-z0-9._-]{1,128}$/.test(locator.region) && locator.bucket.length > 0;
}
