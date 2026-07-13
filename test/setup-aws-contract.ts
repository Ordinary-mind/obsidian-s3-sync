export {};

const required = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

for (const name of required) {
  if (!process.env[name]) throw new Error(`AWS S3 contract test requires ${name}`);
}

const hostname = new URL(process.env.S3_ENDPOINT!).hostname;
if (!(hostname.endsWith(".amazonaws.com") || hostname.endsWith(".amazonaws.com.cn"))) {
  throw new Error("AWS S3 contract test requires an amazonaws.com or amazonaws.com.cn endpoint");
}

process.env.S3_INTEGRATION = "1";
process.env.S3_FORCE_PATH_STYLE = "false";
process.env.S3_TEST_PROVIDER = "AWS S3";
