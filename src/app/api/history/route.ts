import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { safeIngestLedgerEvent } from "@/lib/logging/ingest";
import { getConnection } from "@/lib/solana";
import { getAuditDeviceId, isRequestBlocked } from "@/lib/security/requestGate";

export interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  status: "success" | "failed";
  from: string;
  to: string;
  amount: number;
  fee: number;
}

async function getHistory(pubkey: PublicKey, limit = 10): Promise<TxRecord[]> {
  const connection = getConnection();

  const sigs = await connection.getSignaturesForAddress(pubkey, { limit });
  if (sigs.length === 0) return [];

  const parsed = await connection.getParsedTransactions(
    sigs.map((s) => s.signature),
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  );

  const records: TxRecord[] = [];

  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const tx = parsed[i];
    if (!tx || !sig) continue;

    const fee = (tx.meta?.fee ?? 0) / LAMPORTS_PER_SOL;
    const status: "success" | "failed" =
      tx.meta?.err ? "failed" : "success";

    let from = "";
    let to = "";
    let amount = 0;

    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (!("parsed" in ix) || ix.program !== "system") continue;
      const raw: unknown = ix.parsed;
      if (raw === null || typeof raw !== "object") continue;
      const body = raw as Record<string, unknown>;
      if (body.type !== "transfer") continue;
      const infoVal = body.info;
      if (infoVal === null || typeof infoVal !== "object") continue;
      const info = infoVal as {
        source: unknown;
        destination: unknown;
        lamports: unknown;
      };
      if (
        typeof info.source === "string" &&
        typeof info.destination === "string" &&
        typeof info.lamports === "number"
      ) {
        from = info.source;
        to = info.destination;
        amount = info.lamports / LAMPORTS_PER_SOL;
        break;
      }
    }

    records.push({
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? null,
      status,
      from,
      to,
      amount,
      fee,
    });
  }

  return records;
}

export async function GET(req: Request) {
  const { ip, deviceId } = await getAuditDeviceId(req);
  if (await isRequestBlocked(ip, deviceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const pubA = new PublicKey(process.env.WALLET_A_PUBLIC ?? "");
    const pubB = new PublicKey(process.env.WALLET_B_PUBLIC ?? "");

    const [histA, histB] = await Promise.all([
      getHistory(pubA, 8),
      getHistory(pubB, 8),
    ]);

    const seen = new Set<string>();
    const merged: TxRecord[] = [];
    for (const tx of [...histA, ...histB]) {
      if (!seen.has(tx.signature)) {
        seen.add(tx.signature);
        merged.push(tx);
      }
    }
    merged.sort((a, b) => b.slot - a.slot);

    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "HISTORY_FETCH",
        status: "SUCCESS",
        metadata: {
          route: "/api/history",
          count: merged.length,
        },
      },
      { ingestion: "server" },
    );

    return NextResponse.json({ transactions: merged.slice(0, 12) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "HISTORY_FETCH",
        status: "FAIL",
        metadata: { route: "/api/history", error: message },
      },
      { ingestion: "server" },
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
