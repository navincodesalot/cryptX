import type { ObjectId } from "mongodb";
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
  limit: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

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
      limit: q.limit,
      skip: q.skip,
    });

    const serialized = logs.map((doc) => {
      const { _id, ...rest } = doc as typeof doc & { _id: ObjectId };
      return {
        id: _id.toHexString(),
        ...rest,
        timestamp: rest.timestamp.toISOString(),
      };
    });

    return NextResponse.json({ logs: serialized, count: serialized.length });
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
