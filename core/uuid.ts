export interface RandomBytes {
  getRandomValues(target: Uint8Array): Uint8Array;
}

export function createUuidV4(random: RandomBytes): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  if (bytes.byteLength !== 16) throw new Error("CSPRNG must fill 16 bytes");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
