import "@/styles/globals.css";

import { type Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { CosmicAmbient } from "@/components/cosmic/cosmic-ambient";
import { AppProviders } from "@/components/providers/app-providers";
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
          "cosmic-ui-body flex min-h-svh flex-col bg-background text-foreground antialiased",
        )}
        suppressHydrationWarning
      >
        <CosmicAmbient />
        <AppProviders>
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            {children}
          </div>
          <Toaster richColors />
          <footer className="relative z-10 shrink-0 py-3 text-center">
            <a
              href="https://github.com/navincodesalot/cryptx/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            >
              built with ❤️ by moonshot
            </a>
          </footer>
        </AppProviders>
      </body>
    </html>
  );
}
