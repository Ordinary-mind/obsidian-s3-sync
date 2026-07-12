export type RegisterDisposition = "resolved" | "concurrent" | "pending" | "invalid";

export function classifyRegisterState(heads: readonly string[], pending: readonly string[], invalid: readonly string[]): RegisterDisposition {
  if (invalid.length > 0) return "invalid";
  if (pending.length > 0) return "pending";
  return heads.length <= 1 ? "resolved" : "concurrent";
}

export function canApplyRegisterState(disposition: RegisterDisposition): boolean {
  return disposition === "resolved";
}
