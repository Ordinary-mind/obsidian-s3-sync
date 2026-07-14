export function validateConfigDeleteParents(deletePaths: readonly string[], parents: readonly (ReadonlySet<string> | undefined)[]): "valid" | "pending" | "invalid" {
  if (deletePaths.length === 0) return "valid";
  if (parents.length === 0) return "invalid";
  if (parents.some((items) => items === undefined)) return "pending";
  return deletePaths.every((path) => parents.some((items) => items?.has(path))) ? "valid" : "invalid";
}
