import english from "./bip39-english.json";

/** BIP-39 English word list (2048 words). Used to map device-reported indices ↔ words. */
export const BIP39_ENGLISH = english as readonly string[];

export function phraseToIndices(phrase: string): number[] | null {
  const parts = phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 12) return null;
  const out: number[] = [];
  for (const w of parts) {
    const i = BIP39_ENGLISH.indexOf(w);
    if (i < 0) return null;
    out.push(i);
  }
  return out;
}

export function indicesToWords(indices: number[]): string[] {
  return indices.map((i) => {
    const w = BIP39_ENGLISH[i];
    if (w === undefined) throw new Error("Invalid word index");
    return w;
  });
}
