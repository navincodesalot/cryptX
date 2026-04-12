"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart2, LayoutDashboard, LogOut } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DashboardChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWallet =
    pathname === "/dashboard" || pathname === "/dashboard/";
  const isInsights = pathname.startsWith("/dashboard/insights");

  return (
    <div className="bg-background min-h-screen">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-40 border-b border-border/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-4">
            <Link
              href="/dashboard"
              className="text-lg font-bold tracking-tight shrink-0"
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
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors md:px-4 md:py-2.5 md:text-base",
                  isWallet
                    ? "bg-primary/12 text-primary ring-1 ring-primary/25"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <LayoutDashboard className="size-4 shrink-0 md:size-4.5" />
                Wallet
              </Link>
              <Link
                href="/dashboard/insights"
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors md:px-4 md:py-2.5 md:text-base",
                  isInsights
                    ? "bg-primary/12 text-primary ring-1 ring-primary/25"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
