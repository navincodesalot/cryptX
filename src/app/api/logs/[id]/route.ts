import { NextResponse } from "next/server";

import { getLogById, verifyLogHash } from "@/lib/logs/repository";
import { getDb } from "@/lib/mongo/client";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const db = await getDb();
    const doc = await getLogById(db, id);
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { _id, ...rest } = doc;
    return NextResponse.json({
      id: _id.toHexString(),
      ...rest,
      timestamp: rest.timestamp.toISOString(),
      hashValid: verifyLogHash(rest),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
