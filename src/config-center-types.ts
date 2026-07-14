import type { ConfigBatchConfirmation, ConfigBatchJournal, ConfigBatchPlan, ConfigBatchResult } from "../core/config-batch-apply";
import type { ConfigDirtyIntent } from "../core/config-causality";
import type { ConfigTreeCompatibility } from "../core/config-compatibility";
import type { ConfigDiffEntry } from "../core/config-diff";
import type { LocalPluginInventoryEntry } from "../core/config-local-inspection";
import type { ConfigPluginChange, ConfigRegisterUiState, ConfigTrustRequirements, ConfigUiStatus } from "../core/config-ui-state";
import type { ManagedConfigItem } from "../core/config-snapshot-builder";
import type { ProtocolConfigTree } from "../core/config-tree";

export interface PersistedConfigSyncState {
  status: ConfigUiStatus;
  projectedHeads: string[];
  projectedTreeHash: string | null;
  projectedTree?: ProtocolConfigTree;
  generation: number;
  dirtyIntent?: ConfigDirtyIntent;
  batchJournal?: ConfigBatchJournal;
  batchTargetTree?: ProtocolConfigTree;
  publication?: PersistedConfigPublication;
  lastError?: string;
  recoveryLocation?: string;
  reloadRequired: boolean;
}

export interface PersistedConfigPublication {
  outboxId: string;
  treeHash: string;
  tree: ProtocolConfigTree;
  projectLocal: boolean;
}

export interface ConfigTreeSourceView {
  id: string;
  kind: "local" | "remote";
  label: string;
  treeHash: string;
  versionIds: string[];
  writerIds: string[];
  tree: ProtocolConfigTree;
  items: ManagedConfigItem[];
  bytesByPath: Map<string, Uint8Array>;
  compatibility: ConfigTreeCompatibility;
  pluginChanges: ConfigPluginChange[];
}

export interface ConfigCenterSnapshot {
  state: ConfigRegisterUiState;
  local?: ConfigTreeSourceView;
  remote: ConfigTreeSourceView[];
  resolvedRemoteId?: string;
  diff: ConfigDiffEntry[];
  inventory: LocalPluginInventoryEntry[];
  allLocalEnabledPluginIds: string[];
  projectedHeads: string[];
  projectedTreeHash: string | null;
  recoveryLocation: string;
  blockedDetails: string[];
}

export interface ConfigApplyPreview {
  plan: ConfigBatchPlan;
  planHash: string;
  currentTreeHash: string;
  target: ConfigTreeSourceView;
  requirements: ConfigTrustRequirements;
  recoveryLocation: string;
}

export interface ConfigApplyOutcome {
  result: ConfigBatchResult;
  state: PersistedConfigSyncState;
}

export interface ConfigPublicationConfirmation {
  treeHash: string;
  acceptPluginCode: boolean;
  acceptSensitiveData: boolean;
}

export type ConfigApplyTrustConfirmation = ConfigBatchConfirmation;

export function createDefaultConfigSyncState(): PersistedConfigSyncState {
  return {
    status: "disabled",
    projectedHeads: [],
    projectedTreeHash: null,
    generation: 0,
    reloadRequired: false,
  };
}
