import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generateMnemonic } from "bip39";

const DATA_DIR = join(process.cwd(), "data");
const SEEDS_PATH = join(DATA_DIR, "seeds.json");

type SeedStore = Record<string, string>;

async function readStore(): Promise<SeedStore> {
  try {
    const raw = await readFile(SEEDS_PATH, "utf-8");
    return JSON.parse(raw) as SeedStore;
  } catch {
    return {};
  }
}

async function writeStore(store: SeedStore) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SEEDS_PATH, JSON.stringify(store, null, 2));
}

function hashPhrase(phrase: string): string {
  return createHash("sha256").update(phrase.trim().toLowerCase()).digest("hex");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action: string;
      wallet?: string;
      phrase?: string;
    };
    const { action, wallet, phrase } = body;

    if (wallet !== "A" && wallet !== "B") {
      return NextResponse.json(
        { error: "wallet must be A or B" },
        { status: 400 },
      );
    }

    if (action === "generate") {
      const mnemonic = generateMnemonic(128);
      const store = await readStore();
      store[wallet] = hashPhrase(mnemonic);
      await writeStore(store);
      return NextResponse.json({ words: mnemonic.split(" ") });
    }

    if (action === "verify") {
      if (!phrase || typeof phrase !== "string") {
        return NextResponse.json(
          { error: "phrase is required" },
          { status: 400 },
        );
      }
      const store = await readStore();
      const stored = store[wallet];
      if (!stored) {
        return NextResponse.json(
          { error: "No seed phrase registered for this wallet" },
          { status: 404 },
        );
      }
      const valid = hashPhrase(phrase) === stored;
      return NextResponse.json({ valid });
    }

    return NextResponse.json(
      { error: "action must be generate or verify" },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
