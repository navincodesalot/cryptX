import type { ObjectId } from "mongodb";
import { z } from "zod";

export const LOG_ACTIONS = [
  "CONNECT",
  "DISCONNECT",
  "SIGN_TX",
  "SEND_TX",
  "AUTH_SUCCESS",
  "AUTH_FAIL",
  "MALICIOUS_ACTIVITY",
  "BALANCE_FETCH",
  "HISTORY_FETCH",
  "AIRDROP",
  "SESSION_LOGOUT",
] as const;

export type LogAction = (typeof LOG_ACTIONS)[number];

export const LOG_STATUSES = ["SUCCESS", "FAIL", "CANCELLED"] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

export const GENESIS_PREV_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export interface LogDocument {
  timestamp: Date;
  deviceId: string;
  ipAddress: string;
  action: LogAction;
  status: LogStatus;
  metadata: Record<string, unknown>;
  nonce: string;
  signatureHash: string;
  prevHash: string;
  hash: string;
}

/** One stored row inside `ledger_devices.logs` (append-only chain per device). */
export type LedgerLogEntry = LogDocument & { _id: ObjectId };

/**
 * One MongoDB document per physical ledger identity (`deviceId` from firmware).
 * Reconnecting the same USB device reuses this doc; a new firmware identity → new doc.
 */
export interface LedgerDeviceDocument {
  _id: ObjectId;
  deviceId: string;
  registeredAt: Date;
  updatedAt: Date;
  logs: LedgerLogEntry[];
}

export const postLogBodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  action: z.enum(LOG_ACTIONS),
  status: z.enum(LOG_STATUSES),
  metadata: z.record(z.string(), z.any()).default({}),
  nonce: z.string().min(8).max(256),
  /** Raw signature — server stores SHA-256 only */
  signature: z.string().min(1).optional(),
  /** Pre-hashed signature (hex); use if hashing client-side */
  signatureHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  /** Optional hint; server uses request headers when possible */
  ipAddress: z.string().max(45).optional(),
});

export type PostLogBody = z.infer<typeof postLogBodySchema>;

/** Browser POST /api/log rows that require an active Web Serial USB session. */
export function isLedgerClientDeviceId(deviceId: string): boolean {
  return deviceId.startsWith("ledger-");
}
