export interface S3ConnectionHints {
  provider?: "aws" | "baidu" | "local";
  region?: string;
  forcePathStyle?: boolean;
}

export function inferS3ConnectionHints(endpoint: string): S3ConnectionHints {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return { provider: "local", region: "us-east-1", forcePathStyle: true };
  }
  const baidu = /^s3\.([a-z0-9-]+)\.bcebos\.com$/.exec(host);
  if (baidu) return { provider: "baidu", region: baidu[1], forcePathStyle: true };

  const awsHost = host === "s3.amazonaws.com"
    || host.endsWith(".amazonaws.com")
    || host.endsWith(".amazonaws.com.cn");
  if (!awsHost || !/(^|\.)s3[.-]/.test(host)) return {};
  const regional = /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host)
    ?? /(?:^|\.)s3\.dualstack\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  return {
    provider: "aws",
    region: regional?.[1] ?? (host === "s3.amazonaws.com" ? "us-east-1" : undefined),
    forcePathStyle: false,
  };
}
