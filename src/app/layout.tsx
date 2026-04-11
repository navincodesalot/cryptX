import "@/styles/globals.css";

import { type Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "cryptX — Ledger Network",
  description: "DIY hardware wallet demo on Solana testnet",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn("dark", GeistSans.variable)}
      suppressHydrationWarning
    >
      <body
        className={cn(
          GeistSans.className,
          "bg-background text-foreground antialiased",
        )}
        suppressHydrationWarning
      >
        {children}
        <Toaster richColors />
      </body>
    </html>
  );
}
