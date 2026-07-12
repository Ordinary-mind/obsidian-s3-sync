import type { ObjectStore } from "./object-store";
import { verifyRepositoryDescriptorAtKey } from "../protocol/validation";

export async function discoverRepositoryDescriptors(store: ObjectStore, prefix: string): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string }>> {
  const root = [prefix.replace(/\/$/, ""), ".obsidian-s3-sync/v1/repositories"].filter(Boolean).join("/");
  const candidates: string[] = [];
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await store.list(`${root}/`, token);
    candidates.push(...page.keys.filter((key) => new RegExp(`^${escapeRegExp(root)}/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/format\\.json$`).test(key)));
    token = page.continuationToken;
    if (token && (seenTokens.has(token) || (seenTokens.add(token), false))) throw new Error("ObjectStore returned a repeated continuation token");
  } while (token);
  const descriptors = await Promise.all([...new Set(candidates)].sort().map(async (key) => {
    const verified = verifyRepositoryDescriptorAtKey(prefix, key, await store.get(key));
    return { key, repositoryId: verified.descriptor.repositoryId as string, descriptorHash: verified.descriptorHash };
  }));
  return descriptors;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
