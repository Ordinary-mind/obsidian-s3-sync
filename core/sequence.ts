const maxSequence = 18_446_744_073_709_551_615n;

export function nextSequence(sequence: string): string {
  if (!/^[0-9]{20}$/.test(sequence) || sequence === "00000000000000000000") throw new Error("invalid sequence");
  const value = BigInt(sequence);
  if (value >= maxSequence) throw new Error("sequence exhausted");
  return (value + 1n).toString().padStart(20, "0");
}
