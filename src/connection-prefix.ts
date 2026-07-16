export function resolveEffectivePrefix(prefix: string, vaultName: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length > 0) return trimmed;

  // Prefix 留空时用 Vault 名称隔离远端数据，并保留便于在 S3 控制台识别的原名。
  const safeVaultName = (vaultName.trim() || "vault").replace(/^\/+|\/+$/g, "");
  return `obsidian-s3-sync/${safeVaultName}`;
}
