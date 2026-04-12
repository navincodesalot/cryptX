/**
 * Mongo connection string — set MONGO_URI or MONGODB_URI (not hardcoded).
 */
export function getMongoUri(): string {
  const u = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  if (!u?.trim()) {
    throw new Error("Set MONGO_URI or MONGODB_URI in the environment.");
  }
  return u.trim();
}

export function getMongoDbName(): string {
  const n = process.env.MONGODB_DB_NAME?.trim();
  return n ? n : "cryptx";
}

/**
 * Batched ledger log flush delay (ms). Random uniform in [min, max] to spread writes.
 * Defaults: 60_000–120_000 (1–2 minutes).
 */
export function getLedgerLogFlushMinMs(): number {
  const raw = process.env.LEDGER_LOG_FLUSH_MIN_MS?.trim();
  const n = raw ? Number(raw) : 60_000;
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : 60_000;
}

export function getLedgerLogFlushMaxMs(): number {
  const raw = process.env.LEDGER_LOG_FLUSH_MAX_MS?.trim();
  const n = raw ? Number(raw) : 120_000;
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : 120_000;
}

/** Call after reading env; ensures min <= max. */
export function getLedgerLogFlushBoundsMs(): { min: number; max: number } {
  let min = getLedgerLogFlushMinMs();
  let max = getLedgerLogFlushMaxMs();
  if (min > max) [min, max] = [max, min];
  return { min, max };
}
