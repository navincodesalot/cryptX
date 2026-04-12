/**
 * IMF = structured hardware payload. Extract common fields into a flat summary
 * while preserving the original object under metadata.imf / metadata.imfRaw.
 */
export interface ImfSummary {
  transactionAmount?: number;
  walletAddress?: string;
  signatureValidity?: boolean;
  latencyMs?: number;
  timing?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

/**
 * Merges parsed IMF fields into metadata (non-destructive: keeps original keys).
 */
export function enrichMetadataWithImf(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const raw =
    (metadata.imf as Record<string, unknown> | undefined) ??
    (metadata.IMF as Record<string, unknown> | undefined);

  if (!raw || typeof raw !== "object") {
    return { ...metadata };
  }

  const summary: ImfSummary = {};

  summary.transactionAmount =
    num(raw.amount) ??
    num(raw.transactionAmount) ??
    num(raw.value) ??
    num((raw.tx as Record<string, unknown> | undefined)?.amount);

  summary.walletAddress =
    str(raw.walletAddress) ??
    str(raw.address) ??
    str(raw.to) ??
    str((raw.tx as Record<string, unknown> | undefined)?.to);

  summary.signatureValidity =
    bool(raw.signatureValid) ??
    bool(raw.signatureValidity) ??
    bool(raw.validSignature);

  summary.latencyMs =
    num(raw.latencyMs) ?? num(raw.latency) ?? num(raw.durationMs);

  if (raw.timing && typeof raw.timing === "object") {
    summary.timing = raw.timing as Record<string, unknown>;
  }

  const next = { ...metadata };
  if (Object.keys(summary).length > 0) {
    next.imfParsed = { ...summary };
  }
  return next;
}
