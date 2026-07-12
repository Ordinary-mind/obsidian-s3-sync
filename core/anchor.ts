export type AnchorRead = "unknown-empty" | "temporary-missing" | "integrity-stopped" | "available";

export function classifyAnchorRead(input: { hasObservedAnchor: boolean; directlyReadable: boolean; retryExhausted: boolean }): AnchorRead {
  if (input.directlyReadable) return "available";
  if (!input.hasObservedAnchor) return "unknown-empty";
  return input.retryExhausted ? "integrity-stopped" : "temporary-missing";
}
