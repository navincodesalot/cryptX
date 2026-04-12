import { NextResponse } from "next/server";

import {
  LEDGER_DEVICES_COLLECTION,
  SESSION_AUDIT_DEVICES_COLLECTION,
} from "@/lib/logs/ledgerCollection";
import { getDb } from "@/lib/mongo/client";
import { getMongoDbName } from "@/lib/mongo/env";

/**
 * Confirms server env + Atlas connectivity and reports database name / collection counts.
 */
export async function GET() {
  try {
    const dbName = getMongoDbName();
    const db = await getDb();
    const [ping, ledgerHwCount, sessionAuditCount, blacklistCount] =
      await Promise.all([
        db.command({ ping: 1 }),
        db.collection(LEDGER_DEVICES_COLLECTION).estimatedDocumentCount(),
        db.collection(SESSION_AUDIT_DEVICES_COLLECTION).estimatedDocumentCount(),
        db.collection("blacklist").estimatedDocumentCount(),
      ]);

    return NextResponse.json({
      ok: true,
      database: dbName,
      ping,
      collections: {
        [LEDGER_DEVICES_COLLECTION]: ledgerHwCount,
        [SESSION_AUDIT_DEVICES_COLLECTION]: sessionAuditCount,
        blacklist: blacklistCount,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: message,
        hint:
          "Check MONGO_URI / MONGODB_URI, Atlas Network Access (your IP or 0.0.0.0/0), and restart `pnpm dev` after editing .env.",
      },
      { status: 503 },
    );
  }
}
