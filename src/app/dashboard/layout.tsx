import { auth0 } from "@/lib/auth0";
import { getIpFromIncomingHeaders } from "@/lib/http/serverIp";
import { safeIngestLedgerEvent } from "@/lib/logging/ingest";

import { DashboardChrome } from "./dashboard-chrome";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth0.getSession();
  if (session?.user?.sub) {
    const ip = await getIpFromIncomingHeaders();
    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId: `user:${session.user.sub}`,
        action: "AUTH_SUCCESS",
        status: "SUCCESS",
        metadata: {
          event: "dashboard_access",
          route: "/dashboard",
        },
      },
      { ingestion: "server" },
    );
  }

  return <DashboardChrome>{children}</DashboardChrome>;
}
