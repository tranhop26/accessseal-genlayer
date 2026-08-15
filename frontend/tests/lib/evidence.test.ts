import { describe, expect, it } from "vitest";
import {
  canonicalizeEvidence,
  hashEvidence,
  validateEvidenceForCase,
  type EvidenceEnvelopeV1,
} from "@/lib/evidence";

const fixture: EvidenceEnvelopeV1 = {
  schemaVersion: "accessseal-evidence/1",
  chainId: "61127",
  contract: "0x0000000000000000000000000000000000000001",
  caseId: "case-1",
  epoch: 0,
  action: "OPEN_RELEASE",
  subjectOrigin: "https://fixture.accessseal.local",
  profileVersion: "accessseal-static/1",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  evidenceType: "RELEASE_MANIFEST",
  issuer: "0x0000000000000000000000000000000000000002",
  payloadUri:
    "https://fixture.accessseal.local/.well-known/accessseal/release-manifest.json",
  payloadSha256: `sha256:${"a".repeat(64)}`,
  mediaType: "application/json",
  observedAt: 1000,
  submittedAt: 1010,
  expiresAt: 1600,
  nonce: "release-0",
};

describe("browser evidence preview", () => {
  it("matches the contract/script canonical fixture digest", async () => {
    expect(canonicalizeEvidence(fixture)).toBe(
      '{"action":"OPEN_RELEASE","caseId":"case-1","chainId":"61127","contract":"0x0000000000000000000000000000000000000001","epoch":0,"evidenceType":"RELEASE_MANIFEST","expiresAt":1600,"issuer":"0x0000000000000000000000000000000000000002","mediaType":"application/json","nonce":"release-0","observedAt":1000,"payloadSha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payloadUri":"https://fixture.accessseal.local/.well-known/accessseal/release-manifest.json","profileVersion":"accessseal-static/1","releaseDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schemaVersion":"accessseal-evidence/1","subjectOrigin":"https://fixture.accessseal.local","submittedAt":1010}',
    );
    await expect(hashEvidence(fixture)).resolves.toBe(
      "sha256:1516fe2a20fe0fd13a08f2ede25e091b9b4ca9a54f5f2162f84f28f7190ca4b9",
    );
  });

  it("blocks stale, mismatched, and cross-origin evidence before signing", () => {
    expect(
      validateEvidenceForCase(fixture, {
        caseId: "case-1",
        epoch: 0,
        subjectOrigin: fixture.subjectOrigin,
        profileHash: "0xabc",
        chainId: 61127,
        contract: fixture.contract,
        issuer: fixture.issuer,
        action: "OPEN_RELEASE",
        releaseDigest: fixture.releaseDigest,
        evidenceWindow: 86400,
        currentTimestamp: 1500,
      }),
    ).toEqual({ ok: true, issues: [] });
    const result = validateEvidenceForCase(
      { ...fixture, caseId: "wrong", expiresAt: 1499 },
      {
        caseId: "case-1",
        epoch: 0,
        subjectOrigin: fixture.subjectOrigin,
        profileHash: "0xabc",
        chainId: 61127,
        contract: fixture.contract,
        issuer: fixture.issuer,
        action: "OPEN_RELEASE",
        releaseDigest: fixture.releaseDigest,
        evidenceWindow: 86400,
        currentTimestamp: 1500,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "Case binding does not match.",
        "Evidence has expired.",
      ]),
    );
    expect(() =>
      canonicalizeEvidence({
        ...fixture,
        payloadUri: "https://attacker.example/proof.json",
      }),
    ).toThrow(/origin/i);
  });

  it("rejects wrong numeric chain, contract, issuer, action, release, freshness, and invalid Unicode", () => {
    const expected = {
      caseId: "case-1",
      epoch: 0,
      subjectOrigin: fixture.subjectOrigin,
      profileHash: "0xabc",
      currentTimestamp: 1500,
      chainId: 61127,
      contract: fixture.contract,
      issuer: fixture.issuer,
      action: "OPEN_RELEASE" as const,
      releaseDigest: fixture.releaseDigest,
      evidenceWindow: 600,
    };
    for (const changed of [
      { chainId: "61999" },
      { contract: `0x${"f".repeat(40)}` },
      { issuer: `0x${"e".repeat(40)}` },
      { action: "APPEND_EVIDENCE" },
      { releaseDigest: `sha256:${"b".repeat(64)}` },
      { observedAt: 899 },
    ])
      expect(
        validateEvidenceForCase(
          { ...fixture, ...changed } as EvidenceEnvelopeV1,
          expected,
        ).ok,
      ).toBe(false);
    expect(() => canonicalizeEvidence({ ...fixture, nonce: "\ud800" })).toThrow(
      /Unicode scalar/i,
    );
  });

  it.each([
    [{ observedAt: 1020 }, "timestamps are not ordered"],
    [{ submittedAt: 1501 }, "submission is in the future"],
    [
      {
        action: "OPEN_RELEASE",
        evidenceType: "DOM_FACTS",
        mediaType: "application/json",
      },
      "release manifest",
    ],
    [
      { action: "APPEND_EVIDENCE", evidenceType: "RELEASE_MANIFEST" },
      "allowlisted",
    ],
    [
      { contract: "0x000000000000000000000000000000000000000A" },
      "Contract binding",
    ],
  ])(
    "matches contract evidence-domain rejection for %o",
    (changed, message) => {
      const expected = {
        caseId: "case-1",
        epoch: 0,
        subjectOrigin: fixture.subjectOrigin,
        profileHash: "0xabc",
        currentTimestamp: 1500,
        chainId: 61127,
        contract: fixture.contract,
        issuer: fixture.issuer,
        action: ((changed as Partial<EvidenceEnvelopeV1>).action ??
          "OPEN_RELEASE") as "OPEN_RELEASE" | "APPEND_EVIDENCE",
        releaseDigest: fixture.releaseDigest,
        evidenceWindow: 86400,
      };
      const result = validateEvidenceForCase(
        { ...fixture, ...changed } as EvidenceEnvelopeV1,
        expected,
      );
      expect(result.ok).toBe(false);
      expect(result.issues.join(" ")).toMatch(new RegExp(message, "i"));
    },
  );
});
