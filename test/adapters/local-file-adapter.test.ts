import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeLocalFileAdapter } from "../../adapters/node-local-file-adapter";
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

  it("rejects paths that escape the desktop Vault root", async () => {
    const root = await mkdtemp(join(tmpdir(), "obsidian-s3-sync-local-"));
    temporaryRoots.push(root);
    const desktop = new NodeLocalFileAdapter({ root, platform: "linux", domain: "config", eventsObservable: true });
    await expect(desktop.observe("../outside")).rejects.toThrow("escapes");
  });
});
