import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProtocolJsonError,
  canonicalizeProtocolJson,
  parseBoundedProtocolJson,
  parseCanonicalProtocolJson,
} from "../../protocol/json";
import { protocolLimits } from "../../protocol/limits";

const encoder = new TextEncoder();

function expectCode(source: Uint8Array, code: ProtocolJsonError["code"]) {
  expect(() => parseCanonicalProtocolJson(source, protocolLimits.formatBytes)).toThrow(
    expect.objectContaining({ code }),
  );
}

function expectConfigCode(source: Uint8Array, code: ProtocolJsonError["code"]) {
  expect(() => parseCanonicalProtocolJson(source, protocolLimits.configTreeBytes)).toThrow(
    expect.objectContaining({ code }),
  );
}

describe("strict v1 protocol JSON", () => {
  it("accepts the fixed canonical descriptor bytes", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url),
        "utf8",
      ),
    );
    expect(parseCanonicalProtocolJson(encoder.encode(vector.canonicalJson), protocolLimits.formatBytes)).toEqual(
      vector.object,
    );
  });

  it("rejects BOM, invalid UTF-8, duplicate keys and unpaired surrogates", () => {
    expectCode(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "utf8-bom");
    expectCode(new Uint8Array([0xc3]), "invalid-utf8");
    expectCode(encoder.encode('{"a":1,"a":1}'), "duplicate-key");
    expectCode(encoder.encode('{"a":"\\uD800"}'), "unpaired-surrogate");
  });

  it("rejects non-canonical member order and non-safe protocol numbers", () => {
    expectCode(encoder.encode('{"z":1,"a":2}'), "non-canonical-json");
    expectCode(encoder.encode('{"a":-0}'), "number-not-safe-integer");
    expectCode(encoder.encode('{"a":9007199254740992}'), "number-not-safe-integer");
  });

  it("replays the versioned invalid JSON byte vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/invalid-json.json", import.meta.url), "utf8"),
    ) as Array<{ hex?: string; utf8?: string; error: ProtocolJsonError["code"] }>;
    for (const vector of vectors) {
      const bytes = vector.hex ? Uint8Array.from(Buffer.from(vector.hex, "hex")) : encoder.encode(vector.utf8!);
      expectCode(bytes, vector.error);
    }
  });

  it("applies the object-specific byte bounds before parsing", () => {
    const oversizedDescriptor = encoder.encode(`{"a":"${"a".repeat(protocolLimits.formatBytes)}"}`);
    expect(() => parseBoundedProtocolJson("descriptor", oversizedDescriptor)).toThrow(
      expect.objectContaining({ code: "body-too-large" }),
    );
    expect(
      parseBoundedProtocolJson("commit", encoder.encode('{"a":1}')),
    ).toEqual({ a: 1 });
  });

  it("rejects one byte beyond every object body limit before JSON parsing", () => {
    const limits = {
      descriptor: protocolLimits.formatBytes,
      commit: protocolLimits.commitBytes,
      "change-chunk": protocolLimits.changeChunkBytes,
      "config-tree": protocolLimits.configTreeBytes,
    } as const;
    for (const [kind, limit] of Object.entries(limits) as Array<
      [keyof typeof limits, number]
    >) {
      const atLimit = encoder.encode(`{}${" ".repeat(limit - 2)}`);
      expect(atLimit).toHaveLength(limit);
      expect(() => parseBoundedProtocolJson(kind, atLimit)).toThrow(
        expect.objectContaining({ code: "non-canonical-json" }),
      );
      expect(() => parseBoundedProtocolJson(kind, new Uint8Array(limit + 1))).toThrow(
        expect.objectContaining({ code: "body-too-large" }),
      );
    }
  });

  it("reports the first deterministic parsed-value resource violation", () => {
    let tooDeep: unknown = null;
    for (let index = 0; index < protocolLimits.jsonDepth; index += 1) tooDeep = [tooDeep];
    expectCode(encoder.encode(JSON.stringify({ value: tooDeep })), "json-depth-exceeded");
    expect(() =>
      parseBoundedProtocolJson(
        "config-tree",
        encoder.encode(`{"value":"${"a".repeat(protocolLimits.jsonStringUtf8Bytes + 1)}"}`),
      ),
    ).toThrow(expect.objectContaining({ code: "json-string-bytes-exceeded" }));
  });

  it("rejects excessive nesting while parsing rather than after building the object graph", () => {
    let nested = "null";
    for (let index = 0; index < 16; index += 1) nested = `[${nested}]`;
    expectCode(encoder.encode(`{"value":${nested}}`), "json-depth-exceeded");
  });

  it("rejects an oversized array while parsing", () => {
    const oversized = `{\"items\":[${"null,".repeat(100000)}null]}`;
    expect(() => parseBoundedProtocolJson("config-tree", encoder.encode(oversized))).toThrow(
      expect.objectContaining({ code: "json-array-items-exceeded" }),
    );
  });

  it("rejects protocol-specific arrays before parsing the first excess element", () => {
    for (const [field, limit] of [
      ["parents", protocolLimits.mutationParents],
      ["changeChunkHashes", protocolLimits.commitChunks],
      ["mutations", protocolLimits.chunkMutations],
    ] as const) {
      const entries = `${"null,".repeat(limit)}null`;
      expectConfigCode(encoder.encode(`{"${field}":[${entries}]}`), "json-array-items-exceeded");
    }
  });

  it("stops escaped and raw strings at the first UTF-8 byte beyond the limit", () => {
    const raw = "é".repeat(protocolLimits.jsonStringUtf8Bytes / 2 + 1);
    expectConfigCode(encoder.encode(`{"value":"${raw}"}`), "json-string-bytes-exceeded");
    const escaped = "\\u00e9".repeat(protocolLimits.jsonStringUtf8Bytes / 2 + 1);
    expectConfigCode(encoder.encode(`{"value":"${escaped}"}`), "json-string-bytes-exceeded");
  });

  it("uses RFC 8785 member-name ordering independently from protocol array ordering", () => {
    expect(canonicalizeProtocolJson({ "😀": 1, "\ufffd": 2 })).toBe('{"😀":1,"�":2}');
    expectCode(encoder.encode('{"�":2,"😀":1}'), "non-canonical-json");
  });

  it("does not canonicalize direct JavaScript strings with unpaired surrogates", () => {
    expect(() => canonicalizeProtocolJson({ value: "\ud800" })).toThrow(
      expect.objectContaining({ code: "unpaired-surrogate" }),
    );
    expect(() => canonicalizeProtocolJson({ "\ud800": "value" })).toThrow(
      expect.objectContaining({ code: "unpaired-surrogate" }),
    );
  });
});
