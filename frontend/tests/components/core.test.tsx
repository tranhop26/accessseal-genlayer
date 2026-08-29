import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { StatusPanel } from "@/components/status-panel";
import { CaseComposer } from "@/components/case-composer";
import { CaseSkeleton } from "@/components/skeletons";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cases",
}));

vi.mock("@/providers/wallet-provider", () => ({
  useWallet: () => ({
    config: {
      network: "testnet_bradbury",
      chainId: 4221,
      contractAddress: "0x814726d7a3a2cbc52c8ea622b49af1d6fda300a7",
      explorerBaseUrl: "https://explorer-bradbury.genlayer.com",
    },
    status: "disconnected",
    address: null,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

describe("accessible core experience", () => {
  it("uses semantic workspace navigation and discloses configured Bradbury simulation value", () => {
    render(
      <AppShell>
        <p>Case content</p>
      </AppShell>,
    );
    expect(
      screen.getByRole("navigation", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bradbury Testnet · Simulated GEN"),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Case content");
    const workspace = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(workspace).getByRole("link", { name: "Overview" })).toBeVisible();
    expect(within(workspace).getByRole("link", { name: "Cases" })).toBeVisible();
    expect(within(workspace).getByText("Activity").parentElement).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(workspace).getByText("Proofs").parentElement).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("does not style ACCEPTED as terminal success", () => {
    const { rerender } = render(
      <StatusPanel
        state={{
          phase: "ACCEPTED",
          hash: `0x${"a".repeat(64)}`,
          message: "Accepted, awaiting finality",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText(/not final/i)).toBeInTheDocument();
    rerender(
      <StatusPanel
        state={{
          phase: "RECONCILING",
          hash: `0x${"a".repeat(64)}`,
          message: "Finalized",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "pending");
  });

  it("exposes named loading state and labeled composer validation", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { rerender } = render(<CaseSkeleton />);
    expect(
      screen.getByRole("status", { name: /loading case/i }),
    ).toBeInTheDocument();
    rerender(<CaseComposer onCreate={onCreate} authority={null} />);
    await user.click(
      screen.getByRole("button", { name: /continue to terms/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /review locked terms/i }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /complete the required/i,
    );
    expect(screen.getByLabelText(/vendor wallet/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("invalidates a signed preview on form or wallet-domain mutation", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const authority = {
      buyer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: 61999,
      network: "studionet" as const,
      contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
    };
    const { rerender } = render(
      <CaseComposer onCreate={onCreate} authority={authority} />,
    );
    fireEvent.change(screen.getByLabelText(/vendor wallet/i), {
      target: { value: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    });
    await user.click(
      screen.getByRole("button", { name: /continue to terms/i }),
    );
    fireEvent.change(screen.getByLabelText(/website origin/i), {
      target: { value: "https://product.example" },
    });
    fireEvent.change(screen.getByLabelText(/profile hash/i), {
      target: { value: `0x${"c".repeat(64)}` },
    });
    for (const input of screen.getAllByLabelText(/critical flow/i))
      fireEvent.change(input, { target: { value: "flow" } });
    fireEvent.change(screen.getByLabelText(/simulated escrow/i), {
      target: { value: "1" },
    });
    await user.click(
      screen.getByRole("button", { name: /review locked terms/i }),
    );
    expect(
      await screen.findByText(/ready for wallet signature/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back to terms/i }));
    await user.type(screen.getByLabelText(/website origin/i), "x");
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();
    rerender(
      <CaseComposer
        onCreate={onCreate}
        authority={{ ...authority, chainId: 61127 }}
      />,
    );
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["0x0000000000000000000000000000000000000000", "1"],
    ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1"],
    ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", (1n << 256n).toString()],
  ])(
    "rejects contract-invalid vendor or u256 before preview",
    async (vendor, escrow) => {
      const user = userEvent.setup();
      render(
        <CaseComposer
          onCreate={vi.fn()}
          authority={{
            buyer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            chainId: 61999,
            network: "studionet",
            contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
          }}
        />,
      );
      fireEvent.change(screen.getByLabelText(/vendor wallet/i), {
        target: { value: vendor },
      });
      await user.click(
        screen.getByRole("button", { name: /continue to terms/i }),
      );
      fireEvent.change(screen.getByLabelText(/website origin/i), {
        target: { value: "https://product.example" },
      });
      fireEvent.change(screen.getByLabelText(/profile hash/i), {
        target: { value: `0x${"c".repeat(64)}` },
      });
      for (const input of screen.getAllByLabelText(/critical flow/i))
        fireEvent.change(input, { target: { value: "flow" } });
      fireEvent.change(screen.getByLabelText(/simulated escrow/i), {
        target: { value: escrow },
      });
      await user.click(
        screen.getByRole("button", { name: /review locked terms/i }),
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.queryByText(/ready for wallet signature/i),
      ).not.toBeInTheDocument();
    },
  );
});
