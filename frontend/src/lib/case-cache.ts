import type { AccessSealClient } from "./access-seal";

type StorageTarget = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
export async function finalizeCreatedCase(
  reader: Pick<AccessSealClient, "readCase">,
  storage: StorageTarget,
  caseId: string,
  termsHash: string,
  txId: string,
) {
  const readback = await reader.readCase(caseId);
  if (readback.caseId !== caseId || readback.termsHash !== termsHash)
    throw new Error(
      "Finalized create readback did not match the signed terms.",
    );
  let stored: string[] = [];
  try {
    const value = JSON.parse(storage.getItem("accessseal.case-ids.v1") ?? "[]");
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      stored = value;
  } catch {
    stored = [];
  }
  storage.setItem(
    "accessseal.case-ids.v1",
    JSON.stringify([caseId, ...stored.filter((id) => id !== caseId)]),
  );
  storage.setItem(
    `accessseal.create-tx.v1:${caseId}`,
    JSON.stringify({ txId, caseId, termsHash, method: "create_case" }),
  );
  return readback;
}
