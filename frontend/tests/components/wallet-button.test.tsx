import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WalletButton } from "@/components/wallet-button";
import { useWallet } from "@/providers/wallet-provider";

vi.mock("@/providers/wallet-provider", () => ({ useWallet: vi.fn() }));

const ADDRESS = "0x814726d7a3a2cbc52c8ea622b49af1d6fda300a7" as const;
const changeAccount = vi.fn();

function mockWallet(status: "connected" | "switching") {
  vi.mocked(useWallet).mockReturnValue({
    status,
    address: ADDRESS,
    error: null,
    contract: null,
    readContract: null,
    sdk: null,
    config: null,
    connect: vi.fn(),
    changeAccount,
    disconnect: vi.fn(),
  });
}

describe("wallet button", () => {
  it("offers a separate change-wallet action for a connected wallet", async () => {
    mockWallet("connected");
    const user = userEvent.setup();

    render(<WalletButton />);

    expect(
      screen.getByRole("button", { name: /disconnect wallet 0x/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Change wallet" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Change wallet" }));

    expect(changeAccount).toHaveBeenCalledOnce();
  });

  it("shows switching as a busy state that disables both wallet actions", () => {
    mockWallet("connected");
    const { rerender } = render(<WalletButton />);

    mockWallet("switching");
    rerender(<WalletButton />);

    const changeButton = screen.getByRole("button", {
      name: "Changing wallet…",
    });
    expect(changeButton).toHaveAttribute("aria-busy", "true");
    expect(changeButton).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /disconnect wallet 0x/i }),
    ).toBeDisabled();
  });
});
