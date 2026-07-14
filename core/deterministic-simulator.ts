import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { InMemoryRepositoryCore } from "./repository";
import type { RegisterVersion } from "./register";

export type SimulatedValue = { kind: "put"; hash: string; size: number } | { kind: "delete" };

export const simulatedLocalIoBoundaries = [
  "state-read",
  "state-write",
  "scan-list",
  "capture-read",
  "staging-write",
  "preimage-check",
  "recovery-move",
  "recovery-hash",
  "install",
  "projection-account",
] as const;

export type SimulatedLocalIoBoundary = typeof simulatedLocalIoBoundaries[number];

export class SimulatedOfflineError extends Error {
  constructor(readonly clientId: string) {
    super(`simulator client is offline: ${clientId}`);
    this.name = "SimulatedOfflineError";
  }
}

export class SimulatedLocalIoError extends Error {
  constructor(readonly clientId: string, readonly boundary: SimulatedLocalIoBoundary) {
    super(`simulated local I/O failure at ${boundary}`);
    this.name = "SimulatedLocalIoError";
  }
}

interface SimulatedDirtyRecord {
  channel: "vault" | "config";
  logicalKey: string;
  value: SimulatedValue;
  basisHeads: string[];
  localPredecessorVersion?: string;
  generation: number;
}

export interface SimulatedOutbox {
  writerId: string;
  sequence: number;
  channel: "vault" | "config";
  logicalKey: string;
  value: SimulatedValue;
  parents: string[];
  versionId: string;
  commitHash: string;
  bytes: Uint8Array;
  state: "frozen" | "published";
}

interface SimulatedProjection {
  heads: string[];
  value: SimulatedValue;
}

interface SimulatedRemoteVersion {
  version: RegisterVersion;
  visibleAt: number;
}

interface SimulatedClient {
  id: string;
  writerId: string;
  nextSequence: number;
  core: InMemoryRepositoryCore;
  dirty: Map<string, SimulatedDirtyRecord>;
  outbox: SimulatedOutbox[];
  projections: Map<string, SimulatedProjection>;
  localValues: Map<string, SimulatedValue>;
  conflicts: Set<string>;
  pendingApply: Set<string>;
  online: boolean;
  ioFaults: Map<SimulatedLocalIoBoundary, number>;
  ioTrace: SimulatedLocalIoBoundary[];
}

export interface SimulatedClientSnapshot {
  id: string;
  writerId: string;
  nextSequence: number;
  versions: RegisterVersion[];
  dirty: Array<[string, SimulatedDirtyRecord]>;
  outbox: SimulatedOutbox[];
  projections: Array<[string, SimulatedProjection]>;
  localValues: Array<[string, SimulatedValue]>;
  conflicts: string[];
  pendingApply: string[];
  online: boolean;
}

export class DeterministicSyncSimulator {
  private readonly remote = new Map<string, SimulatedRemoteVersion>();
  private readonly clients = new Map<string, SimulatedClient>();
  private remoteClock = 0;

  constructor(readonly repositoryId = "123e4567-e89b-42d3-a456-426614174000") {}

  createClient(id: string): void {
    if (this.clients.has(id)) throw new Error("simulator client already exists");
    this.clients.set(id, {
      id,
      writerId: deterministicId(`writer:${id}`),
      nextSequence: 1,
      core: new InMemoryRepositoryCore(),
      dirty: new Map(),
      outbox: [],
      projections: new Map(),
      localValues: new Map(),
      conflicts: new Set(),
      pendingApply: new Set(),
      online: true,
      ioFaults: new Map(),
      ioTrace: [],
    });
  }

  disconnect(clientId: string): void { this.client(clientId).online = false; }
  reconnect(clientId: string): void { this.client(clientId).online = true; }
  isOnline(clientId: string): boolean { return this.client(clientId).online; }
  advanceRemoteVisibility(ticks = 1): void {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error("simulator visibility ticks are invalid");
    this.remoteClock += ticks;
  }

  injectLocalIoFailure(clientId: string, boundary: SimulatedLocalIoBoundary, count = 1): void {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("simulator I/O fault count is invalid");
    const client = this.client(clientId);
    client.ioFaults.set(boundary, (client.ioFaults.get(boundary) ?? 0) + count);
  }

  localIoTrace(clientId: string): SimulatedLocalIoBoundary[] {
    return [...this.client(clientId).ioTrace];
  }

  edit(clientId: string, logicalKey: string, value: SimulatedValue, channel: "vault" | "config" = "vault"): void {
    const client = this.client(clientId);
    const registerKey = key(channel, logicalKey);
    const existing = client.dirty.get(registerKey);
    if (existing) {
      client.dirty.set(registerKey, { ...existing, value: { ...value }, generation: existing.generation + 1 });
    } else {
      const predecessor = [...client.outbox].reverse().find((entry) => entry.channel === channel && entry.logicalKey === logicalKey);
      client.dirty.set(registerKey, {
        channel,
        logicalKey,
        value: { ...value },
        basisHeads: predecessor ? [] : [...(client.projections.get(registerKey)?.heads ?? [])],
        ...(predecessor ? { localPredecessorVersion: predecessor.versionId } : {}),
        generation: 1,
      });
    }
    client.localValues.set(registerKey, { ...value });
  }

  rename(clientId: string, from: string, to: string, value: Extract<SimulatedValue, { kind: "put" }>): void {
    this.edit(clientId, from, { kind: "delete" });
    this.edit(clientId, to, value);
  }

  freeze(clientId: string, channel: "vault" | "config", logicalKey: string): SimulatedOutbox {
    const client = this.client(clientId);
    const registerKey = key(channel, logicalKey);
    const dirty = client.dirty.get(registerKey);
    if (!dirty) throw new Error("simulator has no dirty record to freeze");
    const parents = dirty.localPredecessorVersion ? [dirty.localPredecessorVersion] : [...dirty.basisHeads];
    if (dirty.value.kind === "delete" && parents.length === 0) throw new Error("simulator refuses a root tombstone");
    if (dirty.value.kind === "delete" && dirty.localPredecessorVersion) {
      const predecessor = client.outbox.find((entry) => entry.versionId === dirty.localPredecessorVersion);
      if (predecessor?.parents.length === 0 && predecessor.state !== "published") throw new Error("root put must be verified published before its delete freezes");
    }
    this.crossLocalIoBoundary(client, "capture-read");
    this.crossLocalIoBoundary(client, "staging-write");
    this.crossLocalIoBoundary(client, "state-write");
    const sequence = client.nextSequence;
    const body = {
      repositoryId: this.repositoryId,
      writerId: client.writerId,
      sequence,
      channel,
      logicalKey,
      value: dirty.value,
      parents,
    };
    const bytes = new TextEncoder().encode(canonicalizeProtocolJson(body));
    const commitHash = sha256Hex(bytes);
    const versionId = `${commitHash}:0:0`;
    const entry: SimulatedOutbox = {
      writerId: client.writerId,
      sequence,
      channel,
      logicalKey,
      value: { ...dirty.value },
      parents,
      versionId,
      commitHash,
      bytes,
      state: "frozen",
    };
    client.outbox.push(entry);
    client.nextSequence += 1;
    client.dirty.delete(registerKey);
    return copyOutbox(entry);
  }

  publishNext(clientId: string, options: { visibleAfter?: number } = {}): SimulatedOutbox | undefined {
    const client = this.client(clientId);
    this.assertOnline(client);
    const visibleAfter = options.visibleAfter ?? 0;
    if (!Number.isSafeInteger(visibleAfter) || visibleAfter < 0) throw new Error("simulator visibility delay is invalid");
    const entry = client.outbox.find((candidate) => candidate.state === "frozen");
    if (!entry) return undefined;
    if (entry.parents.some((parent) => !this.remote.has(parent))) throw new Error("simulator Outbox parent is not remotely visible yet");
    const version: RegisterVersion = {
      versionId: entry.versionId,
      repositoryId: this.repositoryId,
      channel: entry.channel,
      logicalKey: entry.logicalKey,
      parents: [...entry.parents],
      ...(entry.value.kind === "put" ? { blob: { hash: entry.value.hash, size: entry.value.size } } : {}),
      ...(entry.channel === "config" ? { configTree: { items: entry.value.kind === "put" ? [{ path: "snapshot", kind: "put" }] : [{ path: "snapshot", kind: "delete" }] } } : {}),
    };
    this.remote.set(version.versionId, { version, visibleAt: this.remoteClock + visibleAfter });
    entry.state = "published";
    client.core.ingest(version);
    const registerKey = key(entry.channel, entry.logicalKey);
    if (!client.dirty.has(registerKey) && sameValue(client.localValues.get(registerKey), entry.value)) {
      client.projections.set(registerKey, { heads: [entry.versionId], value: { ...entry.value } });
    }
    return copyOutbox(entry);
  }

  pull(clientId: string, options: { order?: "forward" | "reverse" | "hash"; duplicate?: number; visibleVersionIds?: ReadonlySet<string> } = {}): void {
    const client = this.client(clientId);
    this.assertOnline(client);
    this.crossLocalIoBoundary(client, "scan-list");
    let versions = [...this.remote.values()]
      .filter((remote) => remote.visibleAt <= this.remoteClock)
      .map((remote) => remote.version)
      .filter((version) => !options.visibleVersionIds || options.visibleVersionIds.has(version.versionId));
    if (options.order === "reverse") versions.reverse();
    else if (options.order === "hash") versions.sort((left, right) => left.versionId < right.versionId ? -1 : 1);
    const duplicate = options.duplicate ?? 1;
    for (let count = 0; count < duplicate; count += 1) for (const version of versions) client.core.ingest(version);
    this.refreshClientRegisters(client);
  }

  resolve(clientId: string, channel: "vault" | "config", logicalKey: string, value: SimulatedValue): SimulatedOutbox {
    const client = this.client(clientId);
    const state = client.core.register(this.repositoryId, channel, logicalKey);
    if (state.disposition !== "concurrent") throw new Error("simulator resolution requires a conflict");
    const registerKey = key(channel, logicalKey);
    client.dirty.set(registerKey, { channel, logicalKey, value: { ...value }, basisHeads: [...state.heads], generation: 1 });
    client.localValues.set(registerKey, { ...value });
    return this.freeze(clientId, channel, logicalKey);
  }

  snapshotClient(clientId: string): SimulatedClientSnapshot {
    const client = this.client(clientId);
    this.crossLocalIoBoundary(client, "state-read");
    return {
      id: client.id,
      writerId: client.writerId,
      nextSequence: client.nextSequence,
      versions: client.core.snapshotVersions(),
      dirty: [...client.dirty].map(([name, dirty]) => [name, structuredClone(dirty)]),
      outbox: client.outbox.map(copyOutbox),
      projections: [...client.projections].map(([name, projection]) => [name, structuredClone(projection)]),
      localValues: [...client.localValues].map(([name, value]) => [name, { ...value }]),
      conflicts: [...client.conflicts],
      pendingApply: [...client.pendingApply],
      online: client.online,
    };
  }

  restoreClient(snapshot: SimulatedClientSnapshot): void {
    const core = new InMemoryRepositoryCore();
    core.restoreVersions(snapshot.versions);
    this.clients.set(snapshot.id, {
      id: snapshot.id,
      writerId: snapshot.writerId,
      nextSequence: snapshot.nextSequence,
      core,
      dirty: new Map(snapshot.dirty.map(([name, value]) => [name, structuredClone(value)])),
      outbox: snapshot.outbox.map(copyOutbox),
      projections: new Map(snapshot.projections.map(([name, value]) => [name, structuredClone(value)])),
      localValues: new Map(snapshot.localValues.map(([name, value]) => [name, { ...value }])),
      conflicts: new Set(snapshot.conflicts),
      pendingApply: new Set(snapshot.pendingApply),
      online: snapshot.online,
      ioFaults: new Map(),
      ioTrace: [],
    });
  }

  registerHeads(clientId: string, channel: "vault" | "config", logicalKey: string): string[] {
    return this.client(clientId).core.register(this.repositoryId, channel, logicalKey).heads;
  }

  dirtyBasis(clientId: string, channel: "vault" | "config", logicalKey: string): string[] | undefined {
    return this.client(clientId).dirty.get(key(channel, logicalKey))?.basisHeads.slice();
  }

  outbox(clientId: string): SimulatedOutbox[] { return this.client(clientId).outbox.map(copyOutbox); }
  conflicts(clientId: string): string[] { return [...this.client(clientId).conflicts].sort(); }
  pendingApply(clientId: string): string[] { return [...this.client(clientId).pendingApply].sort(); }
  dirtyRegisters(clientId: string): string[] { return [...this.client(clientId).dirty.keys()].sort(); }
  remoteVersions(): RegisterVersion[] { return [...this.remote.values()].map(({ version }) => structuredClone(version)); }

  assertInvariants(): void {
    for (const client of this.clients.values()) {
      const sequences = client.outbox.map((entry) => entry.sequence);
      if (new Set(sequences).size !== sequences.length) throw new Error("simulator reused an Outbox sequence");
      if (sequences.some((sequence, index) => sequence !== index + 1) || client.nextSequence !== sequences.length + 1) {
        throw new Error("simulator Outbox sequence is not contiguous");
      }
      for (const entry of client.outbox) {
        if (sha256Hex(entry.bytes) !== entry.commitHash) throw new Error("simulator Outbox bytes changed");
        if (entry.state === "published" && !this.remote.has(entry.versionId)) throw new Error("published simulator content is unreachable");
      }
    }
    for (const { version } of this.remote.values()) {
      if (version.parents.some((parent) => !this.remote.has(parent))) throw new Error("published simulator parent is unreachable");
    }
  }

  assertConvergedHeads(clientIds: readonly string[] = [...this.clients.keys()]): void {
    const expected = new InMemoryRepositoryCore();
    for (const { version } of this.remote.values()) expected.ingest(version);
    const expectedRegisters = expected.allRegisters(this.repositoryId);
    for (const clientId of clientIds) {
      const client = this.client(clientId);
      const actual = client.core.allRegisters(this.repositoryId);
      const registerKeys = new Set([...expectedRegisters.keys(), ...actual.keys()]);
      for (const registerKey of registerKeys) {
        const [channel, ...logicalKeyParts] = registerKey.split(":");
        const logicalKey = logicalKeyParts.join(":");
        const expectedState = expected.register(this.repositoryId, channel as "vault" | "config", logicalKey);
        const actualState = client.core.register(this.repositoryId, channel as "vault" | "config", logicalKey);
        if (!sameStrings(actualState.heads, expectedState.heads)
          || !sameStrings(actualState.pending, expectedState.pending)
          || !sameStrings(actualState.invalid, expectedState.invalid)) {
          throw new Error(`simulator client ${clientId} did not converge at ${registerKey}`);
        }
      }
    }
  }

  private refreshClientRegisters(client: SimulatedClient): void {
    for (const [registerKey, state] of client.core.allRegisters(this.repositoryId)) {
      if (state.disposition === "concurrent") {
        client.conflicts.add(registerKey);
        client.pendingApply.delete(registerKey);
        continue;
      }
      if (state.disposition !== "resolved" || state.heads.length !== 1) {
        client.pendingApply.add(registerKey);
        continue;
      }
      if (client.dirty.has(registerKey)) {
        client.pendingApply.add(registerKey);
        continue;
      }
      const version = client.core.version(state.heads[0])!;
      const value: SimulatedValue = version.blob ? { kind: "put", hash: version.blob.hash, size: version.blob.size } : { kind: "delete" };
      client.pendingApply.add(registerKey);
      if (sameValue(client.localValues.get(registerKey), value)) {
        this.crossLocalIoBoundary(client, "projection-account");
        client.projections.set(registerKey, { heads: [...state.heads], value });
        client.pendingApply.delete(registerKey);
        client.conflicts.delete(registerKey);
        continue;
      }
      this.crossLocalIoBoundary(client, "preimage-check");
      this.crossLocalIoBoundary(client, "recovery-move");
      this.crossLocalIoBoundary(client, "recovery-hash");
      this.crossLocalIoBoundary(client, "install");
      client.localValues.set(registerKey, value);
      this.crossLocalIoBoundary(client, "projection-account");
      client.projections.set(registerKey, { heads: [...state.heads], value });
      client.pendingApply.delete(registerKey);
      client.conflicts.delete(registerKey);
    }
  }

  private assertOnline(client: SimulatedClient): void {
    if (!client.online) throw new SimulatedOfflineError(client.id);
  }

  private crossLocalIoBoundary(client: SimulatedClient, boundary: SimulatedLocalIoBoundary): void {
    client.ioTrace.push(boundary);
    const remaining = client.ioFaults.get(boundary) ?? 0;
    if (remaining <= 0) return;
    if (remaining === 1) client.ioFaults.delete(boundary);
    else client.ioFaults.set(boundary, remaining - 1);
    throw new SimulatedLocalIoError(client.id, boundary);
  }

  private client(id: string): SimulatedClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`unknown simulator client: ${id}`);
    return client;
  }
}

function key(channel: "vault" | "config", logicalKey: string): string { return `${channel}:${logicalKey}`; }
function deterministicId(source: string): string { return sha256Hex(new TextEncoder().encode(source)).slice(0, 32); }
function copyOutbox(entry: SimulatedOutbox): SimulatedOutbox { return { ...entry, value: { ...entry.value }, parents: [...entry.parents], bytes: new Uint8Array(entry.bytes) }; }
function sameValue(left: SimulatedValue | undefined, right: SimulatedValue): boolean { return !!left && left.kind === right.kind && (left.kind === "delete" || right.kind === "delete" || left.hash === right.hash && left.size === right.size); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
