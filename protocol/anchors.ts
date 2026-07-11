export type AnchorReadState = "readable" | "transient-missing" | "missing-after-retry";

export function classifyAnchorRead(attempts: Array<"readable" | "missing">): AnchorReadState {
  if (attempts.includes("readable")) return "readable";
  return attempts.length > 1 ? "missing-after-retry" : "transient-missing";
}
