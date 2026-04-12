import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import type { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export function getConnection(): Connection {
  const rpc =
    process.env.SOLANA_RPC_URL ?? clusterApiUrl("testnet");
  return new Connection(rpc, "confirmed");
}

function loadKeypair(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret));
}

export function getWalletA(): Keypair {
  const secret = process.env.WALLET_A_SECRET;
  if (!secret) throw new Error("WALLET_A_SECRET not set");
  return loadKeypair(secret);
}

export function getWalletB(): Keypair {
  const secret = process.env.WALLET_B_SECRET;
  if (!secret) throw new Error("WALLET_B_SECRET not set");
  return loadKeypair(secret);
}

export async function getBalance(pubkey: PublicKey): Promise<number> {
  const connection = getConnection();
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function sendTransfer(
  from: Keypair,
  to: PublicKey,
  solAmount: number,
): Promise<string> {
  const connection = getConnection();
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: from.publicKey,
  }).add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports,
    }),
  );

  tx.sign(from);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return sig;
}
