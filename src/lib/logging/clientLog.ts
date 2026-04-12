"use client";

import type { LogAction, LogStatus } from "@/lib/logs/types";
import { isLedgerClientDeviceId } from "@/lib/logs/types";

/**
 * Sends one append-only ledger row from the browser (POST /api/log).
 * For `ledger-*` device IDs, skips the request unless USB Web Serial is active.
 */
export async function sendClientLedgerLog(
  input: {
    deviceId: string;
    action: LogAction;
    status: LogStatus;
    metadata?: Record<string, unknown>;
  },
  options: { usbConnected: boolean },
): Promise<void> {
  if (isLedgerClientDeviceId(input.deviceId) && !options.usbConnected) {
    return;
  }
  const nonce = `cli:${Date.now()}:${crypto.randomUUID()}`;
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isLedgerClientDeviceId(input.deviceId)
          ? { "X-CryptX-Usb-Connected": "1" }
          : {}),
      },
      body: JSON.stringify({
        deviceId: input.deviceId,
        action: input.action,
        status: input.status,
        metadata: { ...input.metadata, source: "browser" },
        nonce,
        signature: `browser:${nonce}`,
      }),
    });
  } catch {
    /* non-fatal */
  }
}
