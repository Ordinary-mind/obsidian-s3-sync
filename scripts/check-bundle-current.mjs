import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const before = await readFile(new URL("../main.js", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(npm, ["run", "build"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const after = await readFile(new URL("../main.js", import.meta.url));
if (!before.equals(after)) {
  console.error("main.js was stale and has been regenerated; review it and run the check again.");
  process.exit(1);
}

console.log("main.js matches a fresh production build.");
