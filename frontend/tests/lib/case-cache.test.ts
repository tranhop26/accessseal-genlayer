import { describe, expect, it, vi } from "vitest";
import { finalizeCreatedCase } from "@/lib/case-cache";

describe("finalized case discovery", () => {
  it("caches only the deterministic case ID after matching authoritative readback", async () => {
    const caseId = `0x${"a".repeat(64)}`;
    const termsHash = `0x${"b".repeat(64)}`;
    const txId = `0x${"c".repeat(64)}`;
    const storage = new Map<string, string>();
    const target = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    };
    await finalizeCreatedCase(
      { readCase: vi.fn().mockResolvedValue({ caseId, termsHash }) } as never,
      target,
      caseId,
      termsHash,
      txId,
    );
    expect(JSON.parse(storage.get("accessseal.case-ids.v1")!)).toEqual([
      caseId,
    ]);
    expect(storage.get("accessseal.case-ids.v1")).not.toContain(txId);
  });
  it("does not cache when finalized readback does not match", async () => {
    const storage = { getItem: () => null, setItem: vi.fn() };
    await expect(
      finalizeCreatedCase(
        {
          readCase: vi
            .fn()
            .mockResolvedValue({ caseId: "wrong", termsHash: "wrong" }),
        } as never,
        storage,
        `0x${"a".repeat(64)}`,
        `0x${"b".repeat(64)}`,
        `0x${"c".repeat(64)}`,
      ),
    ).rejects.toThrow(/did not match/i);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
