import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { ingestFromHttpPost } from "@/lib/logging/ingest";
import { postLogBodySchema } from "@/lib/logs/types";

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json();
    const parsed = postLogBodySchema.parse(body);

    const result = await ingestFromHttpPost(req, parsed);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 },
      );
    }

    return NextResponse.json(
      { ok: true, id: result.id, hash: result.hash },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: err.flatten() },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
