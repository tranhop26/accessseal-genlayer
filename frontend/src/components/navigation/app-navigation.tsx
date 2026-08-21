"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { type PublicConfig } from "@/lib/config";
import { useWallet } from "@/providers/wallet-provider";
import { TransactionToast } from "@/components/transaction-toast";
import styles from "./navigation.module.css";

type IconName = "overview" | "cases" | "create" | "contract";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <path d="M4 5.5h6.5V12H4zM13.5 5.5H20V9h-6.5zM13.5 12H20v6.5h-6.5zM4 15h6.5v3.5H4z" />,
    cases: <path d="M4 6.5h5l1.5 1.75H20v9.25A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5zM4 6.5A1.5 1.5 0 0 1 5.5 5h3.25l1.5 1.75" />,
    create: <path d="M12 5v14M5 12h14" />,
    contract: <path d="M8.25 4.5 4.5 8.25l3.75 3.75M15.75 12l3.75-3.75-3.75-3.75M13.5 4.5l-3 15" />,
  };

  return (
    <svg aria-hidden="true" className={styles.icon} fill="none" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  );
}

function networkLabel(network: PublicConfig["network"]) {
  if (network === "testnet_bradbury") return "Bradbury Testnet · Simulated GEN";
  if (network === "studionet") return "Studionet · Simulated GEN";
  return "Localnet · Simulated GEN";
}

export function shortenAddress(address: `0x${string}`) {
  return `${address.slice(0, 6)}…${address.slice(-4).toUpperCase()}`;
}

export function ContractIdentity({ config }: { config: PublicConfig | null }) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  if (!config) return null;
  const { contractAddress, explorerBaseUrl, network } = config;

  async function copyAddress() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(contractAddress);
    setToastMessage("Contract address copied.");
  }

  return (
    <section className={styles.contractIdentity} id="contract-status" aria-labelledby="contract-status-title">
      <div>
        <p className={styles.utilityLabel}>Contract status</p>
        <h2 id="contract-status-title">Configured contract</h2>
      </div>
      <Badge tone="info">{networkLabel(network)}</Badge>
      <code className={styles.contractAddress}>{shortenAddress(contractAddress)}</code>
      <div className={styles.contractActions}>
        <button aria-label={`Copy full contract address ${contractAddress}`} className={styles.copyButton} onClick={copyAddress} type="button">
          Copy address
        </button>
        {explorerBaseUrl && (
          <a aria-label={`Open contract ${contractAddress} in explorer`} className={styles.explorerLink} href={`${explorerBaseUrl}/address/${contractAddress}`} rel="noreferrer" target="_blank">
            Explorer
          </a>
        )}
      </div>
      {toastMessage && (
        <TransactionToast
          message={toastMessage}
          onDismiss={() => setToastMessage(null)}
        />
      )}
    </section>
  );
}

type NavigationItem = {
  href: string;
  label: string;
  icon: IconName;
  current: (pathname: string) => boolean;
};

function isCaseOverview(pathname: string) {
  return pathname !== "/cases/new" && (pathname === "/cases" || /^\/cases\/[^/]+$/.test(pathname));
}

const desktopItems: readonly NavigationItem[] = [
  { href: "/cases", label: "Overview", icon: "overview", current: () => false },
  { href: "/cases", label: "Cases", icon: "cases", current: isCaseOverview },
  { href: "/cases/new", label: "Create case", icon: "create", current: (pathname) => pathname === "/cases/new" },
  { href: "#contract-status", label: "Contract status", icon: "contract", current: () => false },
];

const mobileItems: readonly NavigationItem[] = [
  { ...desktopItems[0], current: isCaseOverview },
  desktopItems[2],
  desktopItems[3],
];

function NavigationLinks({ items, pathname, compact = false }: { items: readonly NavigationItem[]; pathname: string; compact?: boolean }) {
  return (
    <ul className={compact ? styles.compactLinks : styles.navigationLinks}>
      {items.map((item) => {
        const active = item.current(pathname);
        return (
          <li key={item.label}>
            <Link aria-current={active ? "page" : undefined} className={active ? styles.activeLink : styles.navigationLink} href={item.href} title={compact ? item.label : undefined}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AppNavigation({ pathname, contractAddress }: { pathname: string; contractAddress?: `0x${string}` }) {
  return (
    <>
      <aside className={styles.sidebar} data-contract-address={contractAddress ?? ""}>
        <Link aria-label="AccessSeal home" className={styles.brand} href="/">
          <span aria-hidden="true" className={styles.brandMark}>A</span>
          <span>AccessSeal</span>
        </Link>
        <nav aria-label="Workspace">
          <NavigationLinks items={desktopItems} pathname={pathname} />
        </nav>
      </aside>
      <nav aria-label="Workspace shortcuts" className={styles.tabletRail}>
        <NavigationLinks items={desktopItems.map((item) => ({ ...item, label: `Open ${item.label}` }))} pathname={pathname} compact />
      </nav>
      <nav aria-label="Mobile workspace" className={styles.mobileNavigation}>
        <NavigationLinks items={mobileItems} pathname={pathname} compact />
      </nav>
    </>
  );
}

export function NavigationContractIdentity() {
  const { config } = useWallet();
  return <ContractIdentity config={config} />;
}
