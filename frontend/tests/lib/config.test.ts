import { describe, expect, it, vi } from "vitest";
import { parsePublicConfig, sdkNetworkName } from "@/lib/config";
import {
  classifyWalletError,
  selectGenLayerChain,
  subscribeWalletProvider,
} from "@/providers/wallet-provider";

const realAddress = "0x1234567890abcdef1234567890abcdef12345678";

describe("public configuration", () => {
  it.each([
    undefined,
    "",
    "0x0000000000000000000000000000000000000000",
    "REPLACE_WITH_DEPLOYED_CONTRACT_ADDRESS",
    "0x1111111111111111111111111111111111111111",
  ])(
    "rejects an unavailable or placeholder contract address (%s)",
    (address) => {
      expect(() =>
        parsePublicConfig(
          {
            NEXT_PUBLIC_GENLAYER_NETWORK: "studionet",
            NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: address,
          },
          "production",
        ),
      ).toThrow(/contract address/i);
    },
  );

  it("rejects private credentials even if a public configuration is otherwise valid", () => {
    expect(() =>
      parsePublicConfig(
        {
          NEXT_PUBLIC_GENLAYER_NETWORK: "studionet",
          NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: realAddress,
          PRIVATE_KEY: "secret",
        },
        "production",
      ),
    ).toThrow(/private key/i);
  });

  it("subscribes and cleans up account, chain, and disconnect invalidation", () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider = {
      request: vi.fn(),
      on: vi.fn((event: string, fn: (value?: unknown) => void) =>
        listeners.set(event, fn),
      ),
      removeListener: vi.fn(),
    };
    const account = vi.fn();
    const invalidate = vi.fn();
    const cleanup = subscribeWalletProvider(provider, account, invalidate);
    listeners.get("accountsChanged")?.([realAddress]);
    listeners.get("chainChanged")?.("0x1");
    listeners.get("disconnect")?.();
    expect(account).toHaveBeenCalledWith([realAddress]);
    expect(invalidate).toHaveBeenCalledTimes(2);
    cleanup();
    expect(provider.removeListener).toHaveBeenCalledTimes(3);
  });

  it("accepts only supported public networks and derives the explorer safely", () => {
    const config = parsePublicConfig(
      {
        NEXT_PUBLIC_GENLAYER_NETWORK: "studionet",
        NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: realAddress,
      },
      "production",
    );
    expect(config).toEqual({
      network: "studionet",
      chainId: 61999,
      contractChainId: 1,
      contractAddress: realAddress,
      explorerBaseUrl: "https://studio.genlayer.com",
    });
    expect(() =>
      parsePublicConfig(
        {
          NEXT_PUBLIC_GENLAYER_NETWORK: "ethereum",
          NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: realAddress,
        },
        "production",
      ),
    ).toThrow(/network/i);
  });

  it("binds the Bradbury testnet config to the official chain and explorer", () => {
    const config = parsePublicConfig(
      {
        NEXT_PUBLIC_GENLAYER_NETWORK: "testnet_bradbury",
        NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS: realAddress,
      },
      "production",
    );
    expect(config).toEqual({
      network: "testnet_bradbury",
      chainId: 4221,
      contractChainId: 1,
      contractAddress: realAddress,
      explorerBaseUrl: "https://explorer-bradbury.genlayer.com",
    });
    const chain = selectGenLayerChain(config.network);
    expect(chain.id).toBe(4221);
    expect(chain.name).toBe("Genlayer Bradbury Testnet");
    expect(chain.rpcUrls.default.http).toEqual([
      "https://rpc-bradbury.genlayer.com",
    ]);
    expect(sdkNetworkName(config.network)).toBe("testnetBradbury");
  });

  it("allows one explicit non-production test address without weakening production", () => {
    expect(
      parsePublicConfig(
        {
          NEXT_PUBLIC_GENLAYER_NETWORK: "localnet",
          NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS:
            "0x0000000000000000000000000000000000000001",
        },
        "test",
      ).chainId,
    ).toBe(61127);
    expect(() =>
      parsePublicConfig(
        {
          NEXT_PUBLIC_GENLAYER_NETWORK: "localnet",
          NEXT_PUBLIC_ACCESSSEAL_CONTRACT_ADDRESS:
            "0x0000000000000000000000000000000000000001",
        },
        "production",
      ),
    ).toThrow(/contract address/i);
  });

  it("keeps wallet rejection distinct from wrong-network and provider errors", () => {
    expect(classifyWalletError({ code: 4001 })).toEqual({
      status: "disconnected",
      message: "Wallet connection was rejected. No transaction was sent.",
    });
    expect(classifyWalletError(new Error("wallet chain mismatch"))).toEqual({
      status: "wrong-network",
      message:
        "Wallet is on the wrong network. Switch to the configured GenLayer network.",
    });
    expect(classifyWalletError(new Error("offline"))).toEqual({
      status: "disconnected",
      message: "Wallet connection failed. Check the wallet and try again.",
    });
  });
});
