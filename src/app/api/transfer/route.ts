import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { safeIngestLedgerEvent } from "@/lib/logging/ingest";
import { getWalletA, getWalletB, sendTransfer } from "@/lib/solana";
import { getAuditDeviceId, isRequestBlocked } from "@/lib/security/requestGate";

const schema = z.object({
  from: z.enum(["A", "B"]),
  amount: z.number().positive().max(10),
});

export async function POST(req: Request) {
  const { ip, deviceId } = await getAuditDeviceId(req);
  if (await isRequestBlocked(ip, deviceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body: unknown = await req.json();
    const { from, amount } = schema.parse(body);

    const walletA = getWalletA();
    const walletB = getWalletB();

    const sender = from === "A" ? walletA : walletB;
    const recipient = from === "A" ? walletB.publicKey : walletA.publicKey;

    const sig = await sendTransfer(sender, new PublicKey(recipient), amount);

    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "SEND_TX",
        status: "SUCCESS",
        metadata: {
          route: "/api/transfer",
          from,
          amount,
          solanaSignature: sig,
          recipient: recipient.toBase58(),
          cluster: "testnet",
        },
        signatureMaterial: `solana:${sig}`,
      },
      { ingestion: "server" },
    );

    return NextResponse.json({ signature: sig, from, amount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "SEND_TX",
        status: "FAIL",
        metadata: { route: "/api/transfer", error: message },
      },
      { ingestion: "server" },
    );
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
