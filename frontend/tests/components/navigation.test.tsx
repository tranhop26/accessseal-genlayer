import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { AppNavigation } from "@/components/navigation/app-navigation";

const mockPathname = vi.fn(() => "/");

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
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

const ADDRESS = "0x814726d7a3a2cbc52c8ea622b49af1d6fda300a7";

describe("route-aware navigation", () => {
  it("shows a marketing header on home and the operational shell on cases", () => {
    mockPathname.mockReturnValue("/");
    const { rerender } = render(
      <AppShell>
        <div>Home content</div>
      </AppShell>,
    );

    expect(screen.getByRole("navigation", { name: "Marketing" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Workspace" })).not.toBeInTheDocument();

    mockPathname.mockReturnValue("/cases");
    rerender(
      <AppShell>
        <div>Cases content</div>
      </AppShell>,
    );

    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeVisible();
    expect(
      within(screen.getByRole("navigation", { name: "Workspace" })).getByRole(
        "link",
        { name: "Overview" },
      ),
    ).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Bradbury Testnet · Simulated GEN")).toBeVisible();
    expect(screen.getByText("0x8147…00A7")).toBeVisible();
  });

  it("provides the four labeled operational destinations on mobile", () => {
    render(<AppNavigation pathname="/cases/case-123" contractAddress={ADDRESS} />);

    expect(
      screen.getByRole("navigation", { name: "Mobile workspace" }),
    ).toBeVisible();
    const mobile = within(
      screen.getByRole("navigation", { name: "Mobile workspace" }),
    );
    for (const name of ["Overview", "Cases", "Activity", "Proofs"])
      expect(mobile.getByRole("link", { name })).toBeVisible();
    expect(mobile.getByRole("link", { name: "Activity" })).toHaveAttribute(
      "href",
      "#activity",
    );
    expect(mobile.getByRole("link", { name: "Proofs" })).toHaveAttribute(
      "href",
      "#proofs",
    );
  });

  it("marks the current tablet-rail destination with the caller pathname", () => {
    render(<AppNavigation pathname="/cases/case-123" contractAddress={ADDRESS} />);

    expect(
      within(screen.getByRole("navigation", { name: "Workspace shortcuts" })).getByRole(
        "link",
        { name: "Open Cases" },
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["/cases", "Overview"],
    ["/cases/case-123", "Cases"],
  ])("marks %s with an active mobile %s destination", (pathname, label) => {
    render(<AppNavigation pathname={pathname} contractAddress={ADDRESS} />);

    expect(
      within(screen.getByRole("navigation", { name: "Mobile workspace" })).getByRole(
        "link",
        { name: label },
      ),
    ).toHaveAttribute("aria-current", "page");
  });
});
