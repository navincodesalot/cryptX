import type { WithId } from "mongodb";
import { NextResponse } from "next/server";

import { getDb } from "@/lib/mongo/client";
import { ensureIndexes } from "@/lib/mongo/indexes";
import {
  getBlacklistCollection,
  type BlacklistEntry,
} from "@/lib/security/blacklist";

export async function GET() {
  try {
    const db = await getDb();
    await ensureIndexes(db);
    const col = getBlacklistCollection(db);
    const rows = await col
      .find({})
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    const entries = rows.map((e: WithId<BlacklistEntry>) => ({
      id: e._id.toHexString(),
      type: e.type,
      value: e.value,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      expiresAt: e.expiresAt?.toISOString(),
    }));

    return NextResponse.json({ entries, count: entries.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
