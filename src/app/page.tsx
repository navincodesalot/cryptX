import { redirect } from "next/navigation";
import { Cpu, Shield, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { auth0 } from "@/lib/auth0";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
              A DIY hardware wallet network on Solana. Sign in to open the
              dashboard, connect your Arduinos, and move test SOL with PIN
              protection.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <a
              href="/auth/login?screen_hint=signup&returnTo=/dashboard"
              className={cn(
                buttonVariants({ size: "lg" }),
                "inline-flex w-full justify-center sm:w-auto",
              )}
            >
              Create account
            </a>
            <a
              href="/auth/login?returnTo=/dashboard"
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
                Universal Login handles sign-up and sign-in. Your session is
                stored in an encrypted cookie.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="text-primary size-4" />
                Hardware path
              </CardTitle>
              <CardDescription>
                Optional Web Serial flow for Arduino-ledgers, PIN entry, and
                signing windows that mirror real devices.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="text-primary size-4" />
                Testnet only
              </CardTitle>
              <CardDescription>
                Balances, airdrops, and transfers use Solana testnet — no mainnet
                funds involved.
              </CardDescription>
            </CardHeader>
          </Card>
        </section>

        <Card className="mt-12 border-dashed">
          <CardContent className="text-muted-foreground flex flex-col gap-4 py-8 md:flex-row md:items-center md:justify-between">
            <p className="text-sm">
              Already have an account? Use Log in. New here? Create account sends
              you to Auth0&apos;s sign-up experience.
            </p>
            <a
              href="/auth/login?returnTo=/dashboard"
              className={cn(
                buttonVariants({ variant: "secondary", size: "default" }),
                "inline-flex justify-center",
              )}
            >
              Continue to dashboard
            </a>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
