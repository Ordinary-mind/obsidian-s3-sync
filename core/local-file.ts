import type { LocalPresence } from "./presence";
import type { StableReadObservation } from "./stable-read";

export interface LocalFileAdapter {
  observe(path: string): Promise<StableReadObservation & { presence: LocalPresence }>;
  moveToRecovery(path: string, recoveryPath: string): Promise<void>;
  installNoClobber(path: string, bytes: Uint8Array): Promise<boolean>;
}

export function canPerformDestructiveApply(capabilities: { renameToRecovery: boolean; noClobberInstall: boolean }): boolean {
  return capabilities.renameToRecovery && capabilities.noClobberInstall;
}
