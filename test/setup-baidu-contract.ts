export {};

const required = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

for (const name of required) {
  if (!process.env[name]) throw new Error(`Baidu Cloud BOS contract test requires ${name}`);
}

const hostname = new URL(process.env.S3_ENDPOINT!).hostname;
if (!hostname.endsWith(".bcebos.com")) throw new Error("Baidu Cloud BOS contract test requires a bcebos.com endpoint");

process.env.S3_INTEGRATION = "1";
process.env.S3_FORCE_PATH_STYLE ??= "true";
process.env.S3_TEST_PROVIDER = "Baidu Cloud BOS";
