"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "genlayer-js";
import { localnet, studionet, testnetBradbury } from "genlayer-js/chains";
import { AccessSealClient } from "@/lib/access-seal";
import {
  sdkNetworkName,
  type PublicConfig,
  type PublicNetwork,
} from "@/lib/config";

export function selectGenLayerChain(network: PublicNetwork) {
  if (network === "testnet_bradbury") return testnetBradbury;
  if (network === "studionet") return studionet;
  return localnet;
}

type WalletStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "switching"
  | "wrong-network";
export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
export async function requestWalletAccount(
  provider: Provider,
  mode: "connect" | "change",
): Promise<`0x${string}`> {
  if (mode === "change") {
    await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  }
  const accounts = (await provider.request({
    method: mode === "change" ? "eth_accounts" : "eth_requestAccounts",
  })) as unknown;
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account))
    throw new Error("wallet account unavailable");
  return account.toLowerCase() as `0x${string}`;
}
export function subscribeWalletProvider(
  provider: Provider,
  onAccounts: (accounts: unknown) => void,
  onInvalidate: () => void,
) {
  provider.on?.("accountsChanged", onAccounts);
  provider.on?.("chainChanged", onInvalidate);
  provider.on?.("disconnect", onInvalidate);
  return () => {
    provider.removeListener?.("accountsChanged", onAccounts);
    provider.removeListener?.("chainChanged", onInvalidate);
    provider.removeListener?.("disconnect", onInvalidate);
  };
}
type WalletContextValue = {
  status: WalletStatus;
  address: `0x${string}` | null;
  error: string | null;
  contract: AccessSealClient | null;
  readContract: AccessSealClient | null;
  sdk: ReturnType<typeof createClient> | null;
  config: PublicConfig | null;
  connect(): Promise<void>;
  changeAccount(): Promise<void>;
  disconnect(): void;
};
const empty: WalletContextValue = {
  status: "disconnected",
  address: null,
  error: null,
  contract: null,
  readContract: null,
  sdk: null,
  config: null,
  connect: async () => undefined,
  changeAccount: async () => undefined,
  disconnect: () => undefined,
};
const WalletContext = createContext<WalletContextValue>(empty);

export function classifyWalletError(error: unknown): {
  status: "disconnected" | "wrong-network";
  message: string;
} {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === 4001
  )
    return {
      status: "disconnected",
      message: "Wallet connection was rejected. No transaction was sent.",
    };
  if (error instanceof Error && /chain|network/i.test(error.message))
    return {
      status: "wrong-network",
      message:
        "Wallet is on the wrong network. Switch to the configured GenLayer network.",
    };
  return {
    status: "disconnected",
    message: "Wallet connection failed. Check the wallet and try again.",
  };
}

export function WalletProvider({
  config,
  children,
}: {
  config: PublicConfig;
  children: ReactNode;
}) {
  const chain = selectGenLayerChain(config.network);
  const readSdk = useMemo(() => createClient({ chain }), [chain]);
  const readContract = useMemo(
    () => new AccessSealClient(readSdk as never, config.contractAddress),
    [config.contractAddress, readSdk],
  );
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sdk, setSdk] = useState<ReturnType<typeof createClient> | null>(null);
  const switchVersion = useRef(0);
  const switching = useRef(false);
  const switchCandidate = useRef<`0x${string}` | null>(null);
  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const provider = (window as unknown as { ethereum?: Provider }).ethereum;
      if (!provider) throw new Error("wallet provider unavailable");
      const account = await requestWalletAccount(provider, "connect");
      const next = createClient({
        chain,
        account: account as `0x${string}`,
        provider: provider as never,
      });
      await next.connect(sdkNetworkName(config.network));
      setSdk(next);
      setAddress(account);
      setStatus("connected");
    } catch (cause) {
      const classified = classifyWalletError(cause);
      setStatus(classified.status);
      setError(classified.message);
    }
  }, [chain, config.network]);
  const changeAccount = useCallback(async () => {
    const previousSdk = sdk;
    const previousAddress = address;
    const version = switchVersion.current + 1;
    switchVersion.current = version;
    switching.current = true;
    switchCandidate.current = null;
    setStatus("switching");
    setError(null);
    try {
      const provider = (window as unknown as { ethereum?: Provider }).ethereum;
      if (!provider) throw new Error("wallet provider unavailable");
      const account = await requestWalletAccount(provider, "change");
      if (switchVersion.current !== version) return;
      switchCandidate.current = account;
      const next = createClient({
        chain,
        account,
        provider: provider as never,
      });
      await next.connect(sdkNetworkName(config.network));
      if (switchVersion.current !== version) return;
      switching.current = false;
      switchCandidate.current = null;
      setSdk(next);
      setAddress(account);
      setStatus("connected");
    } catch (cause) {
      if (switchVersion.current !== version) return;
      switching.current = false;
      switchCandidate.current = null;
      setSdk(previousSdk);
      setAddress(previousAddress);
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        (cause as { code: unknown }).code === 4001
      ) {
        setStatus("connected");
        setError("Wallet change was cancelled. The previous wallet remains connected.");
        return;
      }
      const classified = classifyWalletError(cause);
      setStatus(previousSdk && previousAddress ? "connected" : classified.status);
      setError(classified.message);
    }
  }, [address, chain, config.network, sdk]);
  const disconnect = useCallback(() => {
    switchVersion.current += 1;
    switching.current = false;
    switchCandidate.current = null;
    setSdk(null);
    setAddress(null);
    setError(null);
    setStatus("disconnected");
  }, []);
  useEffect(() => {
    const provider = (window as unknown as { ethereum?: Provider }).ethereum;
    if (!provider?.on) return;
    const invalidate = () => disconnect();
    const accountsChanged = (value: unknown) => {
      const accounts = Array.isArray(value) ? value : [];
      const next = accounts[0];
      if (switching.current) {
        if (
          typeof next !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(next) ||
          (switchCandidate.current &&
            next.toLowerCase() !== switchCandidate.current)
        )
          invalidate();
        return;
      }
      if (typeof next !== "string" || next.toLowerCase() !== address)
        invalidate();
    };
    return subscribeWalletProvider(provider, accountsChanged, invalidate);
  }, [address, disconnect]);
  const contract = useMemo(
    () =>
      status === "connected" && sdk
        ? new AccessSealClient(
            sdk as never,
            config.contractAddress,
            sdkNetworkName(config.network),
          )
        : null,
    [config, sdk, status],
  );
  return (
    <WalletContext.Provider
      value={{
        status,
        address,
        error,
        contract,
        readContract,
        sdk,
        config,
        connect,
        changeAccount,
        disconnect,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
export function useWallet() {
  return useContext(WalletContext);
}
