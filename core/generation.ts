export type Generation = number;

export interface PublishedReconcile {
  publishedVersionId: string;
  publishedValueHash: string;
}

export function reconcilePublishedValue(reconcile: PublishedReconcile, currentValueHash: string | undefined): "adopt" | "create-next-generation" | "keep-pending" {
  if (currentValueHash === undefined) return "keep-pending";
  return currentValueHash === reconcile.publishedValueHash ? "adopt" : "create-next-generation";
}
