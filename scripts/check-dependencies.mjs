import { readFile, stat } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const support = JSON.parse(await readFile("protocol/support-matrix.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const bundle = await stat("main.js");

if (bundle.size > 2 * 1024 * 1024) throw new Error(`main.js exceeds the reviewed 2 MiB ceiling: ${bundle.size}`);
const mobile = support.runtimes.find((runtime) => runtime.name === "Obsidian mobile");
if (manifest.isDesktopOnly === true && mobile?.status !== "not-supported-in-v1-desktop-only") {
  throw new Error("manifest and mobile support matrix disagree");
}
if (manifest.isDesktopOnly !== true && mobile?.status !== "verified-runtime-contract-tests") {
  throw new Error("mobile release requires a verified runtime contract");
}

const allowedLicense = /^(?:MIT|ISC|Apache-2\.0|BSD-(?:2|3)-Clause|CC0-1\.0|0BSD|Unlicense)(?: OR (?:MIT|ISC|Apache-2\.0|BSD-(?:2|3)-Clause))*$/;
const unreviewed = [];
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (path === "" || metadata.dev || metadata.optional) continue;
  if (typeof metadata.license !== "string" || !allowedLicense.test(metadata.license)) {
    unreviewed.push(`${path}:${metadata.license ?? "missing"}`);
  }
}
if (unreviewed.length > 0) throw new Error(`production dependency licenses need review: ${unreviewed.join(", ")}`);

process.stdout.write(`dependency check passed; bundle=${bundle.size} bytes; mobile=${mobile?.status}\n`);
