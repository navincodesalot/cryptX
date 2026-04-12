import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { safeIngestLedgerEvent } from "@/lib/logging/ingest";
import { getConnection } from "@/lib/solana";
import { getAuditDeviceId, isRequestBlocked } from "@/lib/security/requestGate";

const schema = z.object({
  wallet: z.enum(["A", "B"]),
});

export async function POST(req: Request) {
  const { ip, deviceId } = await getAuditDeviceId(req);
  if (await isRequestBlocked(ip, deviceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body: unknown = await req.json();
    const { wallet } = schema.parse(body);

    const pubkey = new PublicKey(
      wallet === "A"
        ? (process.env.WALLET_A_PUBLIC ?? "")
        : (process.env.WALLET_B_PUBLIC ?? ""),
    );

    const connection = getConnection();
    const sig = await connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "AIRDROP",
        status: "SUCCESS",
        metadata: {
          route: "/api/airdrop",
          wallet,
          address: pubkey.toBase58(),
          solanaSignature: sig,
          cluster: "testnet",
        },
        signatureMaterial: `airdrop:${sig}`,
      },
      { ingestion: "server" },
    );

    return NextResponse.json({ signature: sig, wallet });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await safeIngestLedgerEvent(
      {
        ipAddress: ip,
        deviceId,
        action: "AIRDROP",
        status: "FAIL",
        metadata: { route: "/api/airdrop", error: message },
      },
      { ingestion: "server" },
    );
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
