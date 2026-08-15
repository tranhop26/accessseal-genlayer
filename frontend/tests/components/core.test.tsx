import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { StatusPanel } from "@/components/status-panel";
import { CaseComposer } from "@/components/case-composer";
import { CaseSkeleton } from "@/components/skeletons";

describe("accessible core experience", () => {
  it("uses semantic navigation and always discloses simulated Studionet value", () => {
    render(
      <AppShell>
        <p>Case content</p>
      </AppShell>,
    );
    expect(
      screen.getByRole("navigation", { name: /primary/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Studionet GEN is simulated/i)).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Case content");
    expect(screen.getByRole("link", { name: "Cases" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Create case" })).toBeVisible();
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
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "pending");
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
      screen.getByRole("button", { name: /preview locked terms/i }),
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
    await user.type(
      screen.getByLabelText(/vendor wallet/i),
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    await user.type(
      screen.getByLabelText(/website origin/i),
      "https://product.example",
    );
    await user.type(
      screen.getByLabelText(/profile hash/i),
      `0x${"c".repeat(64)}`,
    );
    for (const input of screen.getAllByLabelText(/critical flow/i))
      await user.type(input, "flow");
    await user.type(screen.getByLabelText(/simulated escrow/i), "1");
    await user.click(
      screen.getByRole("button", { name: /preview locked terms/i }),
    );
    expect(
      await screen.findByText(/ready for wallet signature/i),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/website origin/i), "x");
    expect(
      screen.queryByText(/ready for wallet signature/i),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /preview locked terms/i }),
    );
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
      await user.type(screen.getByLabelText(/vendor wallet/i), vendor);
      await user.type(
        screen.getByLabelText(/website origin/i),
        "https://product.example",
      );
      await user.type(
        screen.getByLabelText(/profile hash/i),
        `0x${"c".repeat(64)}`,
      );
      for (const input of screen.getAllByLabelText(/critical flow/i))
        await user.type(input, "flow");
      await user.type(screen.getByLabelText(/simulated escrow/i), escrow);
      await user.click(
        screen.getByRole("button", { name: /preview locked terms/i }),
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.queryByText(/ready for wallet signature/i),
      ).not.toBeInTheDocument();
    },
  );
});
