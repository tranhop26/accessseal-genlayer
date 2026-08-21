import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { WalletProvider } from "@/providers/wallet-provider";
import { parsePublicConfig } from "@/lib/config";

export const metadata: Metadata = {
  applicationName: "AccessSeal",
  title: {
    default: "AccessSeal — Evidence-bound acceptance",
    template: "%s · AccessSeal",
  },
  description:
    "GenLayer-powered accessibility release acceptance with evidence-bound validator review.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const mode =
    process.env.NEXT_PUBLIC_ACCESSSEAL_SAFE_TEST_CONFIG === "1"
      ? "test"
      : "production";
  const config = parsePublicConfig(process.env, mode);
  return (
    <html lang="en">
      <body>
        <WalletProvider config={config}>
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
