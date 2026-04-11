import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getWalletA, getWalletB, sendTransfer } from "@/lib/solana";
import { z } from "zod";

const schema = z.object({
  from: z.enum(["A", "B"]),
  amount: z.number().positive().max(10),
});

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json();
    const { from, amount } = schema.parse(body);

    const walletA = getWalletA();
    const walletB = getWalletB();

    const sender    = from === "A" ? walletA : walletB;
    const recipient = from === "A" ? walletB.publicKey : walletA.publicKey;

    const sig = await sendTransfer(sender, new PublicKey(recipient), amount);

    return NextResponse.json({ signature: sig, from, amount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
