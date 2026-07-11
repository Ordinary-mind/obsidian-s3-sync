import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProtocolJsonError,
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
});
