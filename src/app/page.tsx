import { Cpu, Fingerprint, Usb, Zap } from "lucide-react";
import { redirect } from "next/navigation";

import { auth0 } from "@/lib/auth0";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POST_LOGIN = "/dashboard";

const HOW_IT_WORKS = [
  {
    icon: Usb,
    step: "1",
    title: "Connect over USB",
    description: "Web Serial to the Arduino. No bridge.",
  },
  {
    icon: Cpu,
    step: "2",
    title: "Device authenticates",
    description: "SipHash challenge-response each session.",
  },
  {
    icon: Fingerprint,
    step: "3",
    title: "Physical approval",
    description: "LCD + buttons confirm or reject.",
  },
  {
    icon: Zap,
    step: "4",
    title: "Signed payload relayed",
    description: "Bytes go to Solana; seed stays on device.",
  },
] as const;

export default async function LandingPage() {
  const session = await auth0.getSession();
  if (session) {
    redirect(POST_LOGIN);
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col justify-center bg-transparent text-foreground">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-5 py-6 md:gap-12 md:px-10 md:py-8">
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-8">
          <div className="space-y-4">
            <a href="/" className="block">
              <h1 className="text-5xl font-semibold tracking-tight md:text-6xl">
                crypt
                <span className="from-primary via-primary/85 to-muted-foreground bg-linear-to-r bg-clip-text text-transparent">
                  X
                </span>
              </h1>
            </a>
            <p className="text-muted-foreground max-w-xl text-base leading-snug md:text-lg md:leading-relaxed">
              A reverse-engineered hardware wallet for Solana: PIN, BIP-39 seeds,
              physical approval, AI fraud detection — without the $150 price tag.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
            <a
              href={`/auth/login?screen_hint=signup&returnTo=${encodeURIComponent(POST_LOGIN)}`}
              className={cn(
                buttonVariants({ size: "lg" }),
                "inline-flex w-full justify-center sm:w-auto",
              )}
            >
              Create account
            </a>
            <a
              href={`/auth/login?returnTo=${encodeURIComponent(POST_LOGIN)}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "inline-flex w-full justify-center sm:w-auto",
              )}
            >
              Log in
            </a>
          </div>
        </header>

        <section className="space-y-5">
          <div>
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
              How it works
            </h2>
            <p className="text-muted-foreground mt-1 text-sm md:text-base">
              USB to signed transaction on-chain.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-5 md:grid-cols-4 md:gap-x-8">
            {HOW_IT_WORKS.map(({ icon: Icon, step, title, description }) => (
              <div key={step} className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="border-primary/45 bg-primary/18 text-primary flex size-9 shrink-0 items-center justify-center rounded-full border text-base font-semibold tabular-nums md:size-10 md:text-lg">
                    {step}
                  </span>
                  <Icon className="text-primary size-4 shrink-0 md:size-4.5" />
                </div>
                <p className="text-base font-medium leading-tight">{title}</p>
                <p className="text-muted-foreground text-sm leading-snug">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
