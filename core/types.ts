export type Channel = "vault" | "config";
export type CommitKind = "change" | "bootstrap" | "conflict-resolution" | "parent-reduction";

export interface RepositoryLocator {
  repositoryId: string;
  descriptorHash: string;
}

export interface RepositoryDescriptor {
  repositoryId: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export interface BlobRef {
  hash: string;
  size: number;
}

export interface ConfigProfile {
  baseFiles: string[];
  syncThemes: boolean;
  syncSnippets: boolean;
  portablePluginIds: string[];
  pluginPackages: string[];
  pluginData: string[];
  minimumTargetAppVersion?: string;
}

export interface ConfigTree {
  repositoryId: string;
  descriptorHash: string;
  profile: ConfigProfile;
  enabledCommunityPlugins: string[];
  items: Array<{ path: string; kind: "put" | "delete"; blob?: BlobRef }>;
}

export interface VaultMutation {
  path: string;
  kind: "put" | "delete";
  blob?: BlobRef;
  parents: string[];
}

export interface ConfigSnapshotMutation {
  key: "portable";
  kind: "snapshot";
  treeHash: string;
  parents: string[];
}

export type Mutation = VaultMutation | ConfigSnapshotMutation;

export interface ChangeChunk {
  channel: Channel;
  chunkIndex: number;
  chunkCount: number;
  mutations: Mutation[];
}

export interface Commit {
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  channel: Channel;
  kind: CommitKind;
  changeChunkHashes: string[];
}
