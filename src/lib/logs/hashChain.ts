import { createHash } from "node:crypto";

import type { LogAction, LogDocument, LogStatus } from "./types";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function stableStringifyMetadata(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    sorted[k] = metadata[k];
  }
  return JSON.stringify(sorted);
}

/**
 * Chained hash: sha256(prevHash + canonicalPayload).
 * Payload excludes `hash` only.
 */
export function computeLogHash(
  prevHash: string,
  fields: {
    timestamp: Date;
    deviceId: string;
    ipAddress: string;
    action: LogAction;
    status: LogStatus;
    metadata: Record<string, unknown>;
    nonce: string;
    signatureHash: string;
  },
): string {
  const canonical = [
    fields.timestamp.toISOString(),
    fields.deviceId,
    fields.ipAddress,
    fields.action,
    fields.status,
    stableStringifyMetadata(fields.metadata),
    fields.nonce,
    fields.signatureHash,
    prevHash,
  ].join("|");
  return sha256Hex(prevHash + canonical);
}

export function hashRawSignature(raw: string): string {
  return sha256Hex(raw);
}

export function toLogDocumentWithHash(
  prevHash: string,
  partial: Omit<LogDocument, "hash">,
): LogDocument {
  const hash = computeLogHash(prevHash, {
    timestamp: partial.timestamp,
    deviceId: partial.deviceId,
    ipAddress: partial.ipAddress,
    action: partial.action,
    status: partial.status,
    metadata: partial.metadata,
    nonce: partial.nonce,
    signatureHash: partial.signatureHash,
  });
  return { ...partial, hash };
}
