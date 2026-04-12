import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/http/clientIp";
import { getDb } from "@/lib/mongo/client";
import { ensureIndexes } from "@/lib/mongo/indexes";
import {
  getBlacklistCollection,
  isBlacklisted,
} from "@/lib/security/blacklist";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const deviceId = searchParams.get("deviceId") ?? "";

    if (!deviceId) {
      return NextResponse.json(
        { error: "deviceId query param required" },
        { status: 400 },
      );
    }

    const ip = getClientIp(req);
    const db = await getDb();
    await ensureIndexes(db);

    const blacklisted = await isBlacklisted(db, ip, deviceId);

    if (!blacklisted) {
      return NextResponse.json({ blacklisted: false });
    }

    const col = getBlacklistCollection(db);
    const now = new Date();
    const entry = await col.findOne({
      $and: [
        {
          $or: [
            { type: "ip" as const, value: ip },
            { type: "device" as const, value: deviceId },
          ],
        },
        {
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: now } },
          ],
        },
      ],
    });

    return NextResponse.json({
      blacklisted: true,
      reason: entry?.reason ?? "Blocked by security policy",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
