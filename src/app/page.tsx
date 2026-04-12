import { Cpu, Shield, Zap } from "lucide-react";
import { redirect } from "next/navigation";

import { auth0 } from "@/lib/auth0";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default async function LandingPage() {
  const session = await auth0.getSession();
  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-16 md:px-10 md:py-24">
        <header className="mb-16 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <Badge variant="outline" className="w-fit gap-1.5">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
              Solana testnet demo
            </Badge>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              crypt<span className="text-primary">X</span>
            </h1>
            <p className="text-muted-foreground max-w-xl text-lg">
              DIY hardware wallet network on Solana. Sign in with Auth0, then open
              the dashboard at the home page.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <a
              href="/auth/login?screen_hint=signup&returnTo=/"
              className={cn(
                buttonVariants({ size: "lg" }),
                "inline-flex w-full justify-center sm:w-auto",
              )}
            >
              Create account
            </a>
            <a
              href="/auth/login?returnTo=/"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "inline-flex w-full justify-center sm:w-auto",
              )}
            >
              Log in
            </a>
          </div>
        </header>

        <section className="grid flex-1 gap-6 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="text-primary size-4" />
                Auth0
              </CardTitle>
              <CardDescription>
                Universal Login for sign-up and sign-in; session cookies are
                encrypted by the SDK.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="text-primary size-4" />
                Dashboard
              </CardTitle>
              <CardDescription>
                The main app lives at <span className="font-mono">/</span> — the
                same experience before and after you authenticate.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="text-primary size-4" />
                Testnet
              </CardTitle>
              <CardDescription>
                Balances and transfers use Solana testnet only; no mainnet
                funds.
              </CardDescription>
            </CardHeader>
          </Card>
        </section>

        <footer className="text-muted-foreground mt-16 flex flex-col items-center gap-3 text-center text-sm sm:flex-row sm:justify-center sm:gap-6">
          <a href="/" className="text-primary underline-offset-4 hover:underline">
            Open dashboard (home)
          </a>
          <span className="hidden sm:inline">·</span>
          <a
            href="/auth/logout"
            className="underline-offset-4 hover:underline"
          >
            Sign out
          </a>
        </footer>
      </div>
    </main>
  );
}
