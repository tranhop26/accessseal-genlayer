import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { LandingPage } from "@/components/marketing/landing-page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/providers/wallet-provider", () => ({
  useWallet: () => ({
    config: null,
    status: "disconnected",
    address: null,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

describe("LandingPage", () => {
  it("explains the actual lock-verify-settle workflow without crypto spectacle", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /accessibility acceptance/i,
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /create case/i })).toHaveAttribute(
      "href",
      "/cases/new",
    );
    expect(
      screen.getByRole("region", { name: "AccessSeal workflow preview" }),
    ).toBeVisible();
    expect(screen.getByText("Evidence fetched by validators")).toBeVisible();
    expect(screen.getByText("Finalized readback")).toBeVisible();
    expect(screen.queryByText(/orbit/i)).not.toBeInTheDocument();
  });

  it("keeps one main landmark and treats accepted as awaiting finality", () => {
    render(
      <AppShell>
        <LandingPage />
      </AppShell>,
    );

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByText("ACCEPTED", { exact: true })).toHaveAttribute(
      "data-tone",
      "warning",
    );
    expect(screen.getByText(/awaiting protocol finality/i)).toBeVisible();
  });

  it("gives both local action wrappers full-width children on narrow screens", () => {
    const marketingStyles = readFileSync(
      resolve(
        import.meta.dirname,
        "../../src/components/marketing/marketing.module.css",
      ),
      "utf8",
    );

    expect(marketingStyles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.actions > \*[\s\S]*\.finalCtaAction > \*[\s\S]*width: 100%/,
    );
  });
});
