import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getBalance } from "@/lib/solana";

export async function GET() {
  try {
    const pubA = new PublicKey(process.env.WALLET_A_PUBLIC ?? "");
    const pubB = new PublicKey(process.env.WALLET_B_PUBLIC ?? "");

    const [balanceA, balanceB] = await Promise.all([
      getBalance(pubA),
      getBalance(pubB),
    ]);

    return NextResponse.json({
      ledgerA: { address: pubA.toBase58(), balance: balanceA },
      ledgerB: { address: pubB.toBase58(), balance: balanceB },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
