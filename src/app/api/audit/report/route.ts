import { NextResponse } from "next/server";

import { queryLogs } from "@/lib/logs/repository";
import { getDb } from "@/lib/mongo/client";

/**
 * Plain-text export of recent ledger lines. Query: optional `limit` (default 100).
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(
      200,
      Math.max(1, Number(searchParams.get("limit")) || 100),
    );

    const db = await getDb();
    const logs = await queryLogs(db, { limit });

    const lines = logs.map(
      (l) =>
        `${l.timestamp.toISOString()} | ${l.deviceId} | ${l.ipAddress} | ${l.action} | ${l.status}`,
    );

    const report = [
      "CryptX — Ledger export",
      `Generated: ${new Date().toISOString()}`,
      `Events: ${logs.length}`,
      "",
      "Note: New events appear after the next batched flush (LEDGER_LOG_FLUSH_* env).",
      "",
      ...lines,
    ].join("\n");

    return new NextResponse(report, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="cryptx-audit-${Date.now()}.txt"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
