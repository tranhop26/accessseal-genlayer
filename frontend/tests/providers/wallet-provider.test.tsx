import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestWalletAccount,
  useWallet,
  WalletProvider,
} from "@/providers/wallet-provider";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock("genlayer-js", () => ({ createClient: createClientMock }));

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const NEXT_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const CONFLICTING_ADDRESS = "0x1111111111111111111111111111111111111111";
const CONFIG = {
  network: "studionet" as const,
  chainId: 61999 as const,
  contractAddress: "0x814726d7a3a2cbc52c8ea622b49af1d6fda300a7" as const,
  explorerBaseUrl: "https://studio.genlayer.com",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function sdk() {
  return { connect: vi.fn().mockResolvedValue(undefined) };
}

function eventProvider(
  request: (args: { method: string }) => Promise<unknown>,
) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    request: vi.fn(request),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      listeners.set(event, listener),
    ),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
  };
}

function WalletHarness({ oldSdk }: { oldSdk: unknown }) {
  const wallet = useWallet();
  return (
    <>
      <button onClick={() => void wallet.connect()} type="button">
        Connect
      </button>
      <button onClick={() => void wallet.changeAccount()} type="button">
        Change
      </button>
      <output data-testid="status">{wallet.status}</output>
      <output data-testid="address">{wallet.address ?? "unavailable"}</output>
      <output data-testid="contract">
        {wallet.contract ? "available" : "unavailable"}
      </output>
      <output data-testid="sdk">
        {wallet.sdk as unknown === oldSdk
          ? "old"
          : wallet.sdk
            ? "fresh"
            : "unavailable"}
      </output>
      {wallet.error && <output data-testid="error">{wallet.error}</output>}
    </>
  );
}

function renderWallet(oldSdk: ReturnType<typeof sdk>) {
  return render(
    <WalletProvider config={CONFIG}>
      <WalletHarness oldSdk={oldSdk} />
    </WalletProvider>,
  );
}

beforeEach(() => {
  createClientMock.mockReset();
  vi.unstubAllGlobals();
});

describe("requestWalletAccount", () => {
  it("requests account permission before reading the changed wallet account", async () => {
    const provider = {
      request: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce([ADDRESS]),
    };

    await expect(requestWalletAccount(provider, "change")).resolves.toBe(ADDRESS);

    expect(provider.request).toHaveBeenNthCalledWith(1, {
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
    expect(provider.request).toHaveBeenNthCalledWith(2, {
      method: "eth_accounts",
    });
  });

  it("requests accounts directly during ordinary connection", async () => {
    const provider = {
      request: vi.fn().mockResolvedValue([
        "0x1234567890ABCDEF1234567890abcdef12345678",
      ]),
    };

    await expect(requestWalletAccount(provider, "connect")).resolves.toBe(ADDRESS);

    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
  });

  it.each<unknown>([[], [123], ["0x1234"]])(
    "rejects an unavailable wallet account (%j)",
    async (accounts) => {
      const provider = { request: vi.fn().mockResolvedValue(accounts) };

      await expect(requestWalletAccount(provider, "connect")).rejects.toThrow(
        "wallet account unavailable",
      );
    },
  );
});

describe("WalletProvider account changes", () => {
  it("removes the writable contract while a replacement signer is pending", async () => {
    const permission = deferred<void>();
    const readSdk = sdk();
    const oldSdk = sdk();
    const newSdk = sdk();
    createClientMock
      .mockReturnValueOnce(readSdk)
      .mockReturnValueOnce(oldSdk)
      .mockReturnValueOnce(newSdk);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "wallet_requestPermissions") return permission.promise;
        if (method === "eth_accounts")
          return ["0xABCDEFabcdefabcdefabcdefabcdefabcdefabcd"];
        throw new Error(`unexpected method: ${method}`);
      }),
    };
    vi.stubGlobal("ethereum", provider);

    renderWallet(oldSdk);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByTestId("address");
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("connected"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    expect(screen.getByTestId("status")).toHaveTextContent("switching");
    expect(screen.getByTestId("contract")).toHaveTextContent("unavailable");

    permission.resolve();
    await waitFor(() =>
      expect(screen.getByTestId("address")).toHaveTextContent(NEXT_ADDRESS),
    );
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(screen.getByTestId("sdk")).toHaveTextContent("fresh");
    expect(newSdk.connect).toHaveBeenCalledWith("studionet");
    expect(createClientMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ account: NEXT_ADDRESS }),
    );
  });

  it("keeps the selected account connected when accountsChanged arrives before listener handoff", async () => {
    const freshConnection = deferred<void>();
    const readSdk = sdk();
    const oldSdk = sdk();
    const newSdk = { connect: vi.fn().mockReturnValue(freshConnection.promise) };
    createClientMock
      .mockReturnValueOnce(readSdk)
      .mockReturnValueOnce(oldSdk)
      .mockReturnValueOnce(newSdk);
    const provider = eventProvider(async ({ method }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "wallet_requestPermissions") return undefined;
      if (method === "eth_accounts") return [NEXT_ADDRESS];
      throw new Error(`unexpected method: ${method}`);
    });
    vi.stubGlobal("ethereum", provider);

    renderWallet(oldSdk);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("connected"),
    );
    await waitFor(() =>
      expect(provider.removeListener).toHaveBeenCalledTimes(3),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(newSdk.connect).toHaveBeenCalledWith("studionet"));

    await act(async () => {
      freshConnection.resolve();
      await Promise.resolve();
      provider.emit("accountsChanged", [NEXT_ADDRESS]);
    });

    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(screen.getByTestId("address")).toHaveTextContent(NEXT_ADDRESS);
    expect(screen.getByTestId("sdk")).toHaveTextContent("fresh");
  });

  it("restores the prior signer when an account change is cancelled", async () => {
    const readSdk = sdk();
    const oldSdk = sdk();
    createClientMock.mockReturnValueOnce(readSdk).mockReturnValueOnce(oldSdk);
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "wallet_requestPermissions") throw { code: 4001 };
        throw new Error(`unexpected method: ${method}`);
      }),
    };
    vi.stubGlobal("ethereum", provider);

    renderWallet(oldSdk);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("connected"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent(
        "Wallet change was cancelled. The previous wallet remains connected.",
      ),
    );
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(screen.getByTestId("address")).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId("sdk")).toHaveTextContent("old");
  });

  it("retains the prior signer when account selection emits accountsChanged before cancellation", async () => {
    const permission = deferred<void>();
    const readSdk = sdk();
    const oldSdk = sdk();
    createClientMock.mockReturnValueOnce(readSdk).mockReturnValueOnce(oldSdk);
    const provider = eventProvider(async ({ method }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "wallet_requestPermissions") return permission.promise;
      throw new Error(`unexpected method: ${method}`);
    });
    vi.stubGlobal("ethereum", provider);

    renderWallet(oldSdk);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("connected"),
    );
    await waitFor(() =>
      expect(provider.removeListener).toHaveBeenCalledTimes(3),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    act(() => provider.emit("accountsChanged", [NEXT_ADDRESS]));

    expect(screen.getByTestId("status")).toHaveTextContent("switching");
    expect(screen.getByTestId("address")).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId("sdk")).toHaveTextContent("old");

    permission.reject({ code: 4001 });
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent(
        "Wallet change was cancelled. The previous wallet remains connected.",
      ),
    );
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
    expect(screen.getByTestId("address")).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId("sdk")).toHaveTextContent("old");
  });

  it.each(["chainChanged", "disconnect"])(
    "does not restore a signer after %s invalidates a pending replacement",
    async (event) => {
      const permission = deferred<void>();
      const freshConnection = deferred<void>();
      const readSdk = sdk();
      const oldSdk = sdk();
      const newSdk = { connect: vi.fn().mockReturnValue(freshConnection.promise) };
      createClientMock
        .mockReturnValueOnce(readSdk)
        .mockReturnValueOnce(oldSdk)
        .mockReturnValueOnce(newSdk);
      const provider = eventProvider(async ({ method }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "wallet_requestPermissions") return permission.promise;
        if (method === "eth_accounts") return [NEXT_ADDRESS];
        throw new Error(`unexpected method: ${method}`);
      });
      vi.stubGlobal("ethereum", provider);

      renderWallet(oldSdk);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent("connected"),
      );
      await waitFor(() =>
        expect(provider.removeListener).toHaveBeenCalledTimes(3),
      );

      fireEvent.click(screen.getByRole("button", { name: "Change" }));
      permission.resolve();
      await waitFor(() => expect(newSdk.connect).toHaveBeenCalledWith("studionet"));

      act(() =>
        provider.emit(event, event === "chainChanged" ? "0x1" : undefined),
      );
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent("disconnected"),
      );
      expect(screen.getByTestId("address")).toHaveTextContent("unavailable");
      expect(screen.getByTestId("sdk")).toHaveTextContent("unavailable");

      freshConnection.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
      expect(screen.getByTestId("address")).toHaveTextContent("unavailable");
      expect(screen.getByTestId("sdk")).toHaveTextContent("unavailable");
    },
  );

  it.each([
    ["empty", []],
    ["conflicting", [CONFLICTING_ADDRESS]],
  ])(
    "does not restore a signer after a %s accountsChanged payload invalidates a pending replacement",
    async (_kind, accounts) => {
      const permission = deferred<void>();
      const freshConnection = deferred<void>();
      const readSdk = sdk();
      const oldSdk = sdk();
      const newSdk = { connect: vi.fn().mockReturnValue(freshConnection.promise) };
      createClientMock
        .mockReturnValueOnce(readSdk)
        .mockReturnValueOnce(oldSdk)
        .mockReturnValueOnce(newSdk);
      const provider = eventProvider(async ({ method }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "wallet_requestPermissions") return permission.promise;
        if (method === "eth_accounts") return [NEXT_ADDRESS];
        throw new Error(`unexpected method: ${method}`);
      });
      vi.stubGlobal("ethereum", provider);

      renderWallet(oldSdk);
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent("connected"),
      );
      await waitFor(() =>
        expect(provider.removeListener).toHaveBeenCalledTimes(3),
      );

      fireEvent.click(screen.getByRole("button", { name: "Change" }));
      permission.resolve();
      await waitFor(() => expect(newSdk.connect).toHaveBeenCalledWith("studionet"));

      act(() => provider.emit("accountsChanged", accounts));
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent("disconnected"),
      );
      expect(screen.getByTestId("address")).toHaveTextContent("unavailable");
      expect(screen.getByTestId("sdk")).toHaveTextContent("unavailable");

      freshConnection.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(screen.getByTestId("status")).toHaveTextContent("disconnected");
      expect(screen.getByTestId("address")).toHaveTextContent("unavailable");
      expect(screen.getByTestId("sdk")).toHaveTextContent("unavailable");
    },
  );
});
