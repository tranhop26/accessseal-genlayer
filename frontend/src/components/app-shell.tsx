import Link from "next/link";
import type { ReactNode } from "react";
import { WalletButton } from "./wallet-button";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="AccessSeal home">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>AccessSeal</span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="/cases">Cases</Link>
          <Link href="/cases/new">Create case</Link>
        </nav>
        <WalletButton />
      </header>
      <div className="simulation-banner" role="note">
        <span aria-hidden="true">◇</span>
        <span>
          <strong>Simulation environment.</strong> Studionet GEN is simulated
          value—not real money.
        </span>
      </div>
      <main id="main-content">{children}</main>
      <footer>
        <span>Evidence-bound accessibility acceptance</span>
        <span>Intentionally frozen contract</span>
      </footer>
    </div>
  );
}
