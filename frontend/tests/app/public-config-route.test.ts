import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/.well-known/accessseal/config.json/route";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe("public deployment config endpoint", () => {
  it("renders an exact JSON marker from validated server configuration", async () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "studionet";
    process.env.NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS =
      "0x1234567890ABCDEF1234567890ABCDEF12345678";
    delete process.env.NEXT_PUBLIC_ACCESSSEAL_SAFE_TEST_CONFIG;

    const response = await GET();

    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      schemaVersion: "accessseal-public-config/1",
      network: "studionet",
      chainId: 61999,
      contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
      safeTestConfig: false,
    });
  });

  it("fail-closes when production configuration is missing or placeholder", async () => {
    process.env.NEXT_PUBLIC_GENLAYER_NETWORK = "studionet";
    delete process.env.NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS;
    expect(() => GET()).toThrow(/contract address/i);

    process.env.NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS =
      "0x0000000000000000000000000000000000000001";
    expect(() => GET()).toThrow(/contract address/i);
  });
});
