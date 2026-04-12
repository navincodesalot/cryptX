import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { safeIngestLedgerEvent } from "@/lib/logging/ingest";
import { getBalance } from "@/lib/solana";
import { getAuditDeviceId, isRequestBlocked } from "@/lib/security/requestGate";

export async function GET(req: Request) {
  const { ip, deviceId } = await getAuditDeviceId(req);
  if (await isRequestBlocked(ip, deviceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const pubA = new PublicKey(process.env.WALLET_A_PUBLIC ?? "");
    const pubB = new PublicKey(process.env.WALLET_B_PUBLIC ?? "");

    const [balanceA, balanceB] = await Promise.all([
      getBalance(pubA),
      getBalance(pubB),
    ]);

    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "BALANCE_FETCH",
        status: "SUCCESS",
        metadata: {
          route: "/api/balance",
          ledgerA: pubA.toBase58(),
          ledgerB: pubB.toBase58(),
        },
      },
      { ingestion: "server" },
    );

    return NextResponse.json({
      ledgerA: { address: pubA.toBase58(), balance: balanceA },
      ledgerB: { address: pubB.toBase58(), balance: balanceB },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "BALANCE_FETCH",
        status: "FAIL",
        metadata: { route: "/api/balance", error: message },
      },
      { ingestion: "server" },
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
