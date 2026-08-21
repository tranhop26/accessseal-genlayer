"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AppNavigation, NavigationContractIdentity } from "@/components/navigation/app-navigation";
import { WalletButton } from "./wallet-button";
import styles from "./navigation/navigation.module.css";

function pageTitle(pathname: string) {
  if (pathname === "/cases/new") return "Create case";
  if (pathname === "/cases") return "Cases";
  return "Case workspace";
}

function MarketingHeader() {
  return (
    <header className={styles.marketingHeader}>
      <Link aria-label="AccessSeal home" className={styles.brand} href="/">
        <span aria-hidden="true" className={styles.brandMark}>A</span>
        <span>AccessSeal</span>
      </Link>
      <nav aria-label="Marketing" className={styles.marketingNav}>
        <Link href="/cases">Workspace</Link>
        <Button href="/cases/new" variant="secondary">Create case</Button>
      </nav>
    </header>
  );
}

function WorkspaceHeader({ pathname }: { pathname: string }) {
  return (
    <header className={styles.workspaceHeader}>
      <div>
        <p className={styles.workspaceSubtitle}>AccessSeal workspace</p>
        <p className={styles.workspaceTitle}>{pageTitle(pathname)}</p>
      </div>
      <WalletButton />
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const operational = pathname.startsWith("/cases");

  if (!operational) {
    return (
      <div className={styles.marketingFrame}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <MarketingHeader />
        <main className={styles.marketingMain} id="main-content" tabIndex={-1}>{children}</main>
        <NavigationContractIdentity />
      </div>
    );
  }

  return (
    <div className={styles.operationalFrame}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <AppNavigation pathname={pathname} />
      <div className={styles.workspace}>
        <WorkspaceHeader pathname={pathname} />
        <main className={styles.operationalMain} id="main-content" tabIndex={-1}>{children}</main>
        <NavigationContractIdentity />
      </div>
    </div>
  );
}
