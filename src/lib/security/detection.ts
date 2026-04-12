import type { Db } from "mongodb";

import type { LogAction } from "@/lib/logs/types";
import { getBufferThreatDeltas } from "@/lib/logging/logBuffer";
import {
  countAuthFailsForDeviceSince,
  countNonServerLogsByIpSince,
  countTxActionsForDeviceSince,
  hasNonceForDevice,
} from "@/lib/logs/repository";
import {
  AUTH_FAIL_WINDOW_MS,
  MAX_AUTH_FAILS,
  MAX_LOGS_PER_IP_PER_WINDOW,
  MAX_TX_PER_WINDOW,
  RATE_WINDOW_MS,
  TX_WINDOW_MS,
} from "@/lib/security/threatWindows";

export interface ThreatSignals {
  rateLimited: boolean;
  authStorm: boolean;
  txSpam: boolean;
  duplicateNonce: boolean;
}

export async function checkDuplicateNonce(
  db: Db,
  deviceId: string,
  nonce: string,
): Promise<boolean> {
  return hasNonceForDevice(db, deviceId, nonce);
}

export async function assessThreats(
  db: Db,
  ip: string,
  deviceId: string,
  nonce: string,
  action: LogAction,
): Promise<ThreatSignals> {
  const now = Date.now();

  const [rateCount, authFailCount, txCount, dupNonceDb, buf] = await Promise.all([
    countNonServerLogsByIpSince(db, ip, new Date(now - RATE_WINDOW_MS)),
    countAuthFailsForDeviceSince(
      db,
      deviceId,
      new Date(now - AUTH_FAIL_WINDOW_MS),
    ),
    countTxActionsForDeviceSince(
      db,
      deviceId,
      new Date(now - TX_WINDOW_MS),
    ),
    checkDuplicateNonce(db, deviceId, nonce),
    getBufferThreatDeltas(ip, deviceId, nonce, now),
  ]);

  const incomingAuthFail = action === "AUTH_FAIL" ? 1 : 0;
  const incomingTx = action === "SIGN_TX" || action === "SEND_TX" ? 1 : 0;

  const rateLimited =
    rateCount + buf.rate >= MAX_LOGS_PER_IP_PER_WINDOW;
  const authStorm =
    authFailCount + buf.authFail + incomingAuthFail > MAX_AUTH_FAILS;
  const txSpam = txCount + buf.tx + incomingTx > MAX_TX_PER_WINDOW;

  return {
    rateLimited,
    authStorm,
    txSpam,
    duplicateNonce: dupNonceDb || buf.dupNonce,
  };
}

export function anyMalicious(s: ThreatSignals): boolean {
  return s.rateLimited || s.authStorm || s.txSpam || s.duplicateNonce;
}

export function describeThreat(s: ThreatSignals): string {
  const parts: string[] = [];
  if (s.rateLimited) parts.push("rate_limit_exceeded");
  if (s.authStorm) parts.push("excessive_auth_failures");
  if (s.txSpam) parts.push("transaction_spam");
  if (s.duplicateNonce) parts.push("duplicate_nonce");
  return parts.join(",") || "unknown";
}
