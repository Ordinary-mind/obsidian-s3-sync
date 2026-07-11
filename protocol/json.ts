import { validateParsedJsonLimits } from "./limits";
import { protocolLimits } from "./limits";

export type ProtocolJsonErrorCode =
  | "body-too-large"
  | "utf8-bom"
  | "invalid-utf8"
  | "invalid-json"
  | "duplicate-key"
  | "unpaired-surrogate"
  | "number-not-safe-integer"
  | "root-not-object"
  | "structure-limit"
  | "non-canonical-json";

export class ProtocolJsonError extends Error {
  constructor(readonly code: ProtocolJsonErrorCode, message: string) {
    super(message);
    this.name = "ProtocolJsonError";
  }
}

export type BoundedProtocolObject = "descriptor" | "commit" | "change-chunk" | "config-tree";

export function parseBoundedProtocolJson(
  kind: BoundedProtocolObject,
  bytes: Uint8Array,
): Record<string, unknown> {
  const maxBytes = {
    descriptor: protocolLimits.formatBytes,
    commit: protocolLimits.commitBytes,
    "change-chunk": protocolLimits.changeChunkBytes,
    "config-tree": protocolLimits.configTreeBytes,
  }[kind];
  return parseCanonicalProtocolJson(bytes, maxBytes);
}

export function parseCanonicalProtocolJson(bytes: Uint8Array, maxBytes: number): Record<string, unknown> {
  if (bytes.byteLength > maxBytes) {
    throw new ProtocolJsonError("body-too-large", `JSON body exceeds ${maxBytes} bytes`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new ProtocolJsonError("utf8-bom", "JSON body must not include a UTF-8 BOM");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolJsonError("invalid-utf8", "JSON body is not valid UTF-8");
  }

  const value = new StrictJsonParser(source).parse();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolJsonError("root-not-object", "protocol JSON must have an object root");
  }
  if (validateParsedJsonLimits(value).length > 0) {
    throw new ProtocolJsonError("structure-limit", "JSON body exceeds a protocol structure limit");
  }
  if (canonicalizeProtocolJson(value) !== source) {
    throw new ProtocolJsonError("non-canonical-json", "JSON body is not RFC 8785 canonical");
  }
  return value as Record<string, unknown>;
}

export function canonicalizeProtocolJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ProtocolJsonError("number-not-safe-integer", "protocol numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeProtocolJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeProtocolJson(record[key])}`)
      .join(",")}}`;
  }
  throw new ProtocolJsonError("invalid-json", "protocol JSON contains an unsupported value");
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail("invalid-json", "unexpected trailing JSON content");
    return value;
  }

  private parseValue(): unknown {
    const current = this.source[this.offset];
    if (current === "{") return this.parseObject();
    if (current === "[") return this.parseArray();
    if (current === '"') return this.parseString();
    if (current === "t" && this.consumeLiteral("true")) return true;
    if (current === "f" && this.consumeLiteral("false")) return false;
    if (current === "n" && this.consumeLiteral("null")) return null;
    if (current === "-" || (current >= "0" && current <= "9")) return this.parseNumber();
    this.fail("invalid-json", "expected a JSON value");
  }

  private parseObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume("}")) return result;
    while (true) {
      if (this.source[this.offset] !== '"') this.fail("invalid-json", "object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) this.fail("duplicate-key", `duplicate JSON key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("invalid-json", "expected ':' after object key");
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return result;
      if (!this.consume(",")) this.fail("invalid-json", "expected ',' or '}' in object");
      this.skipWhitespace();
    }
  }

  private parseArray(): unknown[] {
    const result: unknown[] = [];
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume("]")) return result;
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return result;
      if (!this.consume(",")) this.fail("invalid-json", "expected ',' or ']' in array");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    let result = "";
    this.offset += 1;
    while (this.offset < this.source.length) {
      const current = this.source[this.offset++];
      if (current === '"') return result;
      if (current < " ") this.fail("invalid-json", "control character in JSON string");
      if (current !== "\\") {
        result += current;
        continue;
      }
      const escape = this.source[this.offset++];
      if (escape === '"' || escape === "\\" || escape === "/") result += escape;
      else if (escape === "b") result += "\b";
      else if (escape === "f") result += "\f";
      else if (escape === "n") result += "\n";
      else if (escape === "r") result += "\r";
      else if (escape === "t") result += "\t";
      else if (escape === "u") result += this.parseUnicodeEscape();
      else this.fail("invalid-json", "invalid JSON string escape");
    }
    this.fail("invalid-json", "unterminated JSON string");
  }

  private parseUnicodeEscape(): string {
    const codePoint = this.readEscapedCodeUnit();
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      if (this.source.slice(this.offset, this.offset + 2) !== "\\u") {
        this.fail("unpaired-surrogate", "high surrogate must be followed by a low surrogate");
      }
      this.offset += 2;
      const low = this.readEscapedCodeUnit();
      if (low < 0xdc00 || low > 0xdfff) this.fail("unpaired-surrogate", "invalid low surrogate");
      return String.fromCharCode(codePoint, low);
    }
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      this.fail("unpaired-surrogate", "low surrogate must follow a high surrogate");
    }
    return String.fromCharCode(codePoint);
  }

  private readEscapedCodeUnit(): number {
    const hex = this.source.slice(this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid-json", "invalid Unicode escape");
    this.offset += 4;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.offset;
    const literal = match.exec(this.source)?.[0];
    if (!literal) this.fail("invalid-json", "invalid JSON number");
    this.offset += literal.length;
    const value = Number(literal);
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      this.fail("number-not-safe-integer", "protocol numbers must be safe integers");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private consume(value: string): boolean {
    if (this.source.slice(this.offset, this.offset + value.length) !== value) return false;
    this.offset += value.length;
    return true;
  }

  private consumeLiteral(value: string): boolean {
    return this.consume(value);
  }

  private fail(code: ProtocolJsonErrorCode, message: string): never {
    throw new ProtocolJsonError(code, `${message} at offset ${this.offset}`);
  }
}
