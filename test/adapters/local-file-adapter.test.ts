import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeLocalFileAdapter } from "../../adapters/node-local-file-adapter";
import { ConservativeLocalFileAdapter } from "../../adapters/conservative-local-file-adapter";
import { ObsidianLocalFileAdapter, type ObsidianLocalFilePort } from "../../adapters/obsidian-local-file-adapter";
import { localApplyMode } from "../../core/local-file";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local file adapter contracts", () => {
  for (const platform of ["windows", "macos", "linux"] as const) {
    it(`${platform} declares and enforces byte-preserving desktop operations`, async () => {
      const root = await mkdtemp(join(tmpdir(), "obsidian-s3-sync-local-"));
      temporaryRoots.push(root);
      await mkdir(join(root, "active"), { recursive: true });
      await mkdir(join(root, "staged"), { recursive: true });
      await writeFile(join(root, "active", "a.md"), "old");
      await writeFile(join(root, "staged", "remote"), "remote");
      const adapter = new NodeLocalFileAdapter({ root, platform, domain: "vault", eventsObservable: true });
      expect(localApplyMode(adapter.capabilities)).toBe("destructive");
      expect(adapter.capabilities).toMatchObject({
        accessMethod: "node-fs",
        renameAtomicity: "link-unlink",
        overwritePolicy: "no-clobber",
        occupiedFileBehavior: "preserve-and-error",
      });

      const oldHandle = await open(join(root, "active", "a.md"), "r+");
      await adapter.moveToRecovery("active/a.md", "recovery/op/a.md");
      await oldHandle.truncate(0);
      await oldHandle.writeFile("edited-after-move");
      await oldHandle.close();
      expect(await adapter.observe("active/a.md")).toEqual({ kind: "absent" });
      expect(await readFile(join(root, "recovery", "op", "a.md"), "utf8")).toBe("edited-after-move");

      expect(await adapter.installStagedNoClobber("staged/remote", "active/a.md")).toBe(true);
      expect(await adapter.installStagedNoClobber("staged/remote", "active/a.md")).toBe(false);
      expect(await readFile(join(root, "active", "a.md"), "utf8")).toBe("remote");
      expect(await readFile(join(root, "staged", "remote"), "utf8")).toBe("remote");

      await mkdir(join(root, "empty"));
      expect(await adapter.removeEmptyDirectoryNoFollow("empty")).toBe("removed");
      await mkdir(join(root, "nonempty"));
      await writeFile(join(root, "nonempty", "child"), "user");
      expect(await adapter.removeEmptyDirectoryNoFollow("nonempty")).toBe("not-empty");
      expect(await readFile(join(root, "nonempty", "child"), "utf8")).toBe("user");
    });
  }

  it("rejects path escape and uses conservative-only materialization on mobile", async () => {
    const root = await mkdtemp(join(tmpdir(), "obsidian-s3-sync-local-"));
    temporaryRoots.push(root);
    const desktop = new NodeLocalFileAdapter({ root, platform: "linux", domain: "config", eventsObservable: true });
    await expect(desktop.observe("../outside")).rejects.toThrow("escapes");

    const writes: string[] = [];
    const mobile = new ConservativeLocalFileAdapter({
      observe: async () => ({ kind: "absent" }),
      writeCandidateNoClobber: async (_source, target) => { writes.push(target); },
    }, { platform: "mobile", domain: "vault", eventsObservable: true });
    expect(localApplyMode(mobile.capabilities)).toBe("conservative");
    await mobile.materializeConservativeCandidate("staged/a", "excluded/a");
    expect(writes).toEqual(["excluded/a"]);
    await expect(mobile.installStagedNoClobber("staged/a", "a")).rejects.toThrow("does not install");
  });

  it("routes Vault and config domains through distinct Obsidian access contracts", async () => {
    const calls: string[] = [];
    const port = (name: string): ObsidianLocalFilePort => ({
      observe: async (path) => { calls.push(`${name}:observe:${path}`); return { kind: "absent" }; },
      observeRecovery: async () => ({ kind: "absent" }),
      moveToRecovery: async () => { calls.push(`${name}:move`); },
      installStagedNoClobber: async () => true,
      restoreRecoveryNoClobber: async () => true,
      materializeConservativeCandidate: async () => { calls.push(`${name}:candidate`); },
      removeEmptyDirectoryNoFollow: async () => "absent",
    });
    const verified = {
      renameToRecovery: true,
      noClobberInstall: true,
      recoveryObservation: true,
      eventsObservable: true,
      renameAtomicity: "atomic" as const,
      occupiedFileBehavior: "preserve-and-error" as const,
    };
    const vault = new ObsidianLocalFileAdapter(port("vault"), { platform: "windows", domain: "vault", verification: verified });
    const config = new ObsidianLocalFileAdapter(port("config"), { platform: "macos", domain: "config", verification: verified });
    expect(vault.capabilities.accessMethod).toBe("obsidian-vault-api");
    expect(config.capabilities.accessMethod).toBe("obsidian-adapter");
    await vault.observe("notes/a.md");
    await config.observe("plugins/p/data.json");
    expect(calls).toEqual(["vault:observe:notes/a.md", "config:observe:plugins/p/data.json"]);

    const mobile = new ObsidianLocalFileAdapter(port("mobile"), {
      platform: "mobile",
      domain: "vault",
      verification: { ...verified, renameToRecovery: false, noClobberInstall: false, recoveryObservation: false, renameAtomicity: "unsupported" },
    });
    expect(localApplyMode(mobile.capabilities)).toBe("conservative");
    await expect(mobile.moveToRecovery("a", "recovery/a")).rejects.toThrow("lacks verified");
    await mobile.materializeConservativeCandidate("staged/a", "candidate/a");
    expect(calls).toContain("mobile:candidate");
  });
});
