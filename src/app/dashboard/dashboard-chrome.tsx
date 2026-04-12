"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BarChart2, LayoutDashboard, LogOut } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DashboardChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [headerSolid, setHeaderSolid] = useState(false);

  const isWallet =
    pathname === "/dashboard" || pathname === "/dashboard/";
  const isInsights = pathname.startsWith("/dashboard/insights");

  useEffect(() => {
    const onScroll = () => {
      setHeaderSolid(window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen bg-transparent">
      <header
        className={cn(
          "sticky top-0 z-40 border-b transition-[background-color,backdrop-filter,box-shadow,border-color] duration-300",
          headerSolid
            ? "border-border/70 bg-background shadow-sm backdrop-blur-0"
            : "border-primary/12 bg-background/45 shadow-[0_8px_32px_-16px_oklch(0.12_0.055_285/88%)] backdrop-blur-md",
        )}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-4">
            <Link
              href="/dashboard"
              className="shrink-0 text-lg font-bold tracking-tight"
            >
              crypt<span className="text-primary">X</span>
            </Link>

            <nav
              className="flex items-center gap-1"
              aria-label="Dashboard sections"
            >
              <Link
                href="/dashboard"
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 md:px-4 md:py-2.5 md:text-base",
                  isWallet
                    ? "bg-primary/15 text-primary shadow-[0_0_24px_-8px_oklch(0.65_0.15_230/45%)] ring-1 ring-cyan-400/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_-10px_oklch(0.5_0.1_270/40%)]",
                )}
              >
                <LayoutDashboard className="size-4 shrink-0 md:size-4.5" />
                Wallet
              </Link>
              <Link
                href="/dashboard/insights"
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 md:px-4 md:py-2.5 md:text-base",
                  isInsights
                    ? "bg-primary/15 text-primary shadow-[0_0_24px_-8px_oklch(0.65_0.15_230/45%)] ring-1 ring-cyan-400/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_-10px_oklch(0.5_0.1_270/40%)]",
                )}
              >
                <BarChart2 className="size-4 shrink-0 md:size-4.5" />
                Insights
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden gap-1.5 sm:inline-flex">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
              Testnet
            </Badge>
            <a
              href="/auth/logout"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "inline-flex gap-1.5",
              )}
              onClick={() => {
                void fetch("/api/session/log", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ event: "logout" }),
                });
              }}
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Log out</span>
            </a>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
