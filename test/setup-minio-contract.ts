process.env.S3_INTEGRATION = "1";
process.env.S3_ENDPOINT ??= "http://127.0.0.1:9000";
process.env.S3_REGION ??= "us-east-1";
process.env.S3_BUCKET ??= "obsidian-sync-test";
process.env.S3_ACCESS_KEY_ID ??= "minioadmin";
process.env.S3_SECRET_ACCESS_KEY ??= "minioadmin";
process.env.S3_FORCE_PATH_STYLE ??= "true";
process.env.S3_TEST_VERSIONING ??= "1";
