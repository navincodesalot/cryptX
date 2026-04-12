import { randomBytes } from "node:crypto";

import { hashRawSignature } from "@/lib/logs/hashChain";
import { enqueueBufferedLog } from "@/lib/logging/logBuffer";
import { appendLog, resolveSignatureHash } from "@/lib/logs/repository";
import {
  isLedgerClientDeviceId,
  type LogAction,
  type LogStatus,
  type PostLogBody,
} from "@/lib/logs/types";
import { getDb } from "@/lib/mongo/client";
import { ensureIndexes } from "@/lib/mongo/indexes";
import { resolveClientIp } from "@/lib/http/clientIp";
import { addBlacklistEntry, isBlacklisted } from "@/lib/security/blacklist";
import {
  anyMalicious,
  assessThreats,
  describeThreat,
} from "@/lib/security/detection";

export type IngestLedgerParams = {
  ipAddress: string;
  deviceId: string;
  action: LogAction;
  status: LogStatus;
  metadata?: Record<string, unknown>;
  /** Hashed via SHA-256 in storage */
  signatureMaterial?: string;
  nonce?: string;
};

export type IngestOptions = {
  /**
   * Server/API telemetry: do not count toward client POST rate limits or tx/auth heuristics.
   * Still enforces blacklist and append-only chain.
   */
  ingestion?: "server" | "client";
};

function withIngestionMeta(
  meta: Record<string, unknown> | undefined,
  ingestion: "server" | "client",
): Record<string, unknown> {
  return { ...(meta ?? {}), ingestion };
}

/**
 * Core path shared with POST /api/log — writes one append-only chained row.
 */
export async function ingestLedgerEvent(
  params: IngestLedgerParams,
  options: IngestOptions = {},
): Promise<{ ok: true; id: string; hash: string } | { ok: false; error: string }> {
  const ingestion = options.ingestion ?? "client";
  const metadata = withIngestionMeta(params.metadata, ingestion);
  const nonce =
    params.nonce ?? `srv:${Date.now()}:${randomBytes(8).toString("hex")}`;
  const signatureHash = params.signatureMaterial
    ? hashRawSignature(params.signatureMaterial)
    : hashRawSignature(`ingest:${params.deviceId}:${nonce}`);

  const db = await getDb();
  await ensureIndexes(db);

  if (await isBlacklisted(db, params.ipAddress, params.deviceId)) {
    return { ok: false, error: "Blocked: IP or device is blacklisted." };
  }

  let threats = {
    rateLimited: false,
    authStorm: false,
    txSpam: false,
    duplicateNonce: false,
  };

  if (ingestion === "client") {
    threats = await assessThreats(
      db,
      params.ipAddress,
      params.deviceId,
      nonce,
      params.action,
    );
  }

  if (ingestion === "client" && anyMalicious(threats)) {
    await addBlacklistEntry(db, {
      type: "ip",
      value: params.ipAddress,
      reason: describeThreat(threats),
    });
    await addBlacklistEntry(db, {
      type: "device",
      value: params.deviceId,
      reason: describeThreat(threats),
    });

    await appendLog(db, {
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      action: "MALICIOUS_ACTIVITY",
      status: "FAIL",
      metadata: {
        ...metadata,
        reason: describeThreat(threats),
        threats,
        originalAction: params.action,
      },
      nonce: `sys:${Date.now()}:${randomBytes(12).toString("hex")}`,
      signatureHash: hashRawSignature(
        `malicious:${params.deviceId}:${nonce}`,
      ),
    });

    return { ok: false, error: describeThreat(threats) };
  }

  try {
    const { id, hash } = await enqueueBufferedLog({
      deviceId: params.deviceId,
      ipAddress: params.ipAddress,
      action: params.action,
      status: params.status,
      metadata,
      nonce,
      signatureHash,
    });
    return { ok: true, id, hash };
  } catch (e) {
    const code = typeof e === "object" && e && "code" in e ? (e as { code?: number }).code : 0;
    if (code === 11000) {
      return { ok: false, error: "Duplicate nonce (replay)." };
    }
    throw e;
  }
}

/** Never throws — logging failures must not break product APIs. */
export async function safeIngestLedgerEvent(
  params: IngestLedgerParams,
  options?: IngestOptions,
): Promise<void> {
  try {
    await ingestLedgerEvent(params, { ...options, ingestion: "server" });
  } catch (e) {
    console.error("[ledger-log]", e);
  }
}

/** Used by POST /api/log after parsing the body + Request. */
export async function ingestFromHttpPost(
  req: Request,
  body: PostLogBody,
): Promise<
  | { ok: true; id: string; hash: string }
  | { ok: false; error: string; status?: number }
> {
  const ip = resolveClientIp(req, body.ipAddress);
  const signatureHash = resolveSignatureHash(
    body.signature,
    body.signatureHash,
  );

  const db = await getDb();
  await ensureIndexes(db);

  if (await isBlacklisted(db, ip, body.deviceId)) {
    return { ok: false, error: "Blocked: IP or device is blacklisted.", status: 403 };
  }

  if (
    isLedgerClientDeviceId(body.deviceId) &&
    req.headers.get("x-cryptx-usb-connected") !== "1"
  ) {
    return {
      ok: false,
      error:
        "Ledger logs require an active USB Web Serial session (connect the device in this browser tab).",
      status: 403,
    };
  }

  const threats = await assessThreats(
    db,
    ip,
    body.deviceId,
    body.nonce,
    body.action,
  );

  if (anyMalicious(threats)) {
    await addBlacklistEntry(db, {
      type: "ip",
      value: ip,
      reason: describeThreat(threats),
    });
    await addBlacklistEntry(db, {
      type: "device",
      value: body.deviceId,
      reason: describeThreat(threats),
    });

    await appendLog(db, {
      deviceId: body.deviceId,
      ipAddress: ip,
      action: "MALICIOUS_ACTIVITY",
      status: "FAIL",
      metadata: withIngestionMeta(
        {
          reason: describeThreat(threats),
          threats,
          originalAction: body.action,
          ...body.metadata,
        },
        "client",
      ),
      nonce: `sys:${Date.now()}:${randomBytes(12).toString("hex")}`,
      signatureHash: hashRawSignature(
        `malicious:${body.deviceId}:${body.nonce}`,
      ),
    });

    return { ok: false, error: describeThreat(threats), status: 403 };
  }

  try {
    const { id, hash } = await enqueueBufferedLog({
      deviceId: body.deviceId,
      ipAddress: ip,
      action: body.action,
      status: body.status,
      metadata: withIngestionMeta(body.metadata, "client"),
      nonce: body.nonce,
      signatureHash,
    });
    return { ok: true, id, hash };
  } catch (e) {
    const code =
      typeof e === "object" && e && "code" in e
        ? (e as { code?: number }).code
        : 0;
    if (code === 11000) {
      return { ok: false, error: "Duplicate nonce for this device.", status: 409 };
    }
    throw e;
  }
}
