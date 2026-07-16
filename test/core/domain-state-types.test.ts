import { describe, expectTypeOf, it } from "vitest";
import type { DirtyIntent, DirtyRecord, LocalConcurrentRecord } from "../../core/dirty-record";
import type { Generation } from "../../core/generation";
import type { RemoteRegisterState } from "../../core/register";

describe("core local causal state contracts", () => {
  it("exposes the frozen protocol state vocabulary", () => {
    expectTypeOf<Generation>().toEqualTypeOf<number>();
    expectTypeOf<DirtyRecord>().toMatchTypeOf<DirtyIntent>();
    expectTypeOf<RemoteRegisterState["heads"]>().toEqualTypeOf<string[]>();
    expectTypeOf<LocalConcurrentRecord["basisHeads"]>().toEqualTypeOf<string[]>();
  });
});
