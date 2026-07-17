import { readObjectBytes, repeatedContinuationTokenError, type ObjectStore } from "./object-store";
import { verifyRepositoryDescriptorAtKey } from "../protocol/validation";
import { compareUtf8 } from "../protocol/utf8";
import { DiagnosticError } from "./diagnostics";

export interface DiscoveredRepositoryDescriptor {
  key: string;
  repositoryId: string;
  descriptorHash: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export interface RepositoryDiscoveryDiagnostic {
  key: string;
  stage: "candidate" | "read-or-verify";
  cause: unknown;
}

export interface RepositoryDiscoveryResult {
  repositories: DiscoveredRepositoryDescriptor[];
  diagnostics: RepositoryDiscoveryDiagnostic[];
}

export async function discoverRepositoryDescriptors(store: ObjectStore, prefix: string): Promise<DiscoveredRepositoryDescriptor[]> {
  const result = await discoverRepositoryDescriptorsWithDiagnostics(store, prefix);
  if (result.diagnostics.length > 0) {
    throw new DiagnosticError(
      "REPOSITORY_DISCOVERY_INCOMPLETE",
      "integrity",
      `repository discovery rejected ${result.diagnostics.length} descriptor candidate(s); the Prefix was not treated as empty`,
      new AggregateError(result.diagnostics.map((diagnostic) => diagnostic.cause), "repository descriptor discovery failures"),
    );
  }
  return result.repositories;
}

export async function discoverRepositoryDescriptorsWithDiagnostics(store: ObjectStore, prefix: string): Promise<RepositoryDiscoveryResult> {
  const root = [prefix.replace(/\/$/, ""), ".obsidian-s3-sync/v1/repositories"].filter(Boolean).join("/");
  const exactCandidate = new RegExp(`^${escapeRegExp(root)}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/format\\.json$`);
  const candidates = new Set<string>();
  const diagnostics: RepositoryDiscoveryDiagnostic[] = [];
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await store.list(`${root}/`, token);
    for (const key of page.keys) {
      if (exactCandidate.test(key)) candidates.add(key);
      else if (key.endsWith("/format.json")) {
        diagnostics.push({
          key,
          stage: "candidate",
          cause: new DiagnosticError(
            "REPOSITORY_DESCRIPTOR_KEY_INVALID",
            "repository-identity",
            "repository descriptor object key is not canonical",
          ),
        });
      }
    }
    token = page.continuationToken;
    if (token && (seenTokens.has(token) || (seenTokens.add(token), false))) {
      throw repeatedContinuationTokenError();
    }
  } while (token);

  const repositories: DiscoveredRepositoryDescriptor[] = [];
  for (const key of [...candidates].sort()) {
    try {
      const verified = verifyRepositoryDescriptorAtKey(prefix, key, await readObjectBytes(store, key, { maximumBytes: 4 * 1024 }));
      repositories.push({
        key,
        repositoryId: verified.descriptor.repositoryId as string,
        descriptorHash: verified.descriptorHash,
        configDir: verified.descriptor.configDir as string,
        historicalConfigDirs: [...verified.descriptor.historicalConfigDirs as string[]],
      });
    } catch (cause) {
      diagnostics.push({ key, stage: "read-or-verify", cause });
    }
  }
  return {
    repositories,
    diagnostics: diagnostics.sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(left.stage, right.stage)),
  };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
