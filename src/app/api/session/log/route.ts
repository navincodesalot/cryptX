import { NextResponse } from "next/server";
import { z } from "zod";

import { safeIngestLedgerEvent } from "@/lib/logging/ingest";
import { getAuditDeviceId } from "@/lib/security/requestGate";

const bodySchema = z.object({
  event: z.enum(["logout"]),
});

/**
 * Call before `/auth/logout` so SESSION_LOGOUT is stored with a valid Auth0 session.
 */
export async function POST(req: Request) {
  try {
    const raw: unknown = await req.json().catch(() => ({}));
    const { event } = bodySchema.parse(raw);
    const { ip, deviceId } = await getAuditDeviceId(req);

    if (event === "logout") {
      await safeIngestLedgerEvent(
        {
          ipAddress: ip,
          deviceId,
          action: "SESSION_LOGOUT",
          status: "SUCCESS",
          metadata: { route: "/api/session/log" },
        },
        { ingestion: "server" },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
