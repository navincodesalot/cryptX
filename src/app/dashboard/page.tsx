import { redirect } from "next/navigation";

import { auth0 } from "@/lib/auth0";

import LedgerDashboard from "./ledger-dashboard";

export default async function DashboardPage() {
  const session = await auth0.getSession();
  if (!session) {
    redirect("/auth/login?returnTo=/dashboard");
  }

  return <LedgerDashboard />;
}
