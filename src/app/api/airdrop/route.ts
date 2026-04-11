import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getConnection } from "@/lib/solana";
import { z } from "zod";

const schema = z.object({
  wallet: z.enum(["A", "B"]),
});

export async function POST(req: Request) {
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

    return NextResponse.json({ signature: sig, wallet });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
