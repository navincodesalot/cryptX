import "@/styles/globals.css";

import { type Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { CosmicAmbient } from "@/components/cosmic/cosmic-ambient";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "cryptX — Ledger Network",
  description: "Hardware wallet operations on Solana testnet",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn("dark cosmic-ui", GeistSans.variable)}
      suppressHydrationWarning
    >
      <body
        className={cn(
          GeistSans.className,
          "cosmic-ui-body bg-background text-foreground antialiased",
        )}
        suppressHydrationWarning
      >
        <CosmicAmbient />
        <div className="relative z-10">{children}</div>
        <Toaster richColors />
      </body>
    </html>
  );
}
