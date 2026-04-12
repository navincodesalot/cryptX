import { NextResponse } from "next/server";
import { z } from "zod";

import { queryLogs } from "@/lib/logs/repository";
import { LOG_ACTIONS, LOG_STATUSES } from "@/lib/logs/types";
import { getDb } from "@/lib/mongo/client";

const iso = z
  .string()
  .optional()
  .refine((s) => s === undefined || !Number.isNaN(Date.parse(s)), {
    message: "Expected ISO 8601 date string",
  });

const querySchema = z.object({
  deviceId: z.string().optional(),
  action: z.enum(LOG_ACTIONS).optional(),
  status: z.enum(LOG_STATUSES).optional(),
  from: iso,
  to: iso,
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Recent ledger rows for review (no external AI — data is batched into MongoDB).
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = Object.fromEntries(searchParams.entries());
    const q = querySchema.parse(raw);

    const db = await getDb();
    const logs = await queryLogs(db, {
      deviceId: q.deviceId,
      action: q.action,
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit ?? 80,
    });

    const lines = logs.map(
      (l) =>
        `${l.timestamp.toISOString()} | ${l.deviceId} | ${l.ipAddress} | ${l.action} | ${l.status}`,
    );

    return NextResponse.json({
      logCount: logs.length,
      lines,
      note: "Ledger events are written in batches (see LEDGER_LOG_FLUSH_MIN_MS / LEDGER_LOG_FLUSH_MAX_MS in env).",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid query", details: err.flatten() },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
