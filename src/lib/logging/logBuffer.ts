import type { UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";

import { enrichMetadataWithImf } from "@/lib/imf/parseImf";
import { storageCollectionForDeviceId } from "@/lib/logs/ledgerCollection";
import { getLastLogHashForDevice } from "@/lib/logs/repository";
import type { AppendLogInput } from "@/lib/logs/repository";
import { toLogDocumentWithHash } from "@/lib/logs/hashChain";
import type {
  LedgerDeviceDocument,
  LedgerLogEntry,
  LogDocument,
} from "@/lib/logs/types";
import { getLedgerLogFlushBoundsMs } from "@/lib/mongo/env";
import { getDb } from "@/lib/mongo/client";
import { ensureIndexes } from "@/lib/mongo/indexes";
import {
  AUTH_FAIL_WINDOW_MS as AUTH_FAIL_W,
  RATE_WINDOW_MS as RATE_W,
  TX_WINDOW_MS as TX_W,
} from "@/lib/security/threatWindows";

/** Safety cap — flush immediately to avoid huge RAM / oversized $push batches. */
const MAX_BUFFER_BEFORE_FORCE_FLUSH = 150;

type GlobalWithLedgerBuffer = typeof globalThis & {
  __cryptxLedgerBuffer?: QueuedLedger[];
  __cryptxLedgerFlushTimer?: ReturnType<typeof setTimeout>;
  __cryptxLedgerMutexTail?: Promise<void>;
};

interface QueuedLedger {
  queuedAt: number;
  _id: ObjectId;
  doc: LogDocument;
}

function g(): GlobalWithLedgerBuffer {
  return globalThis as GlobalWithLedgerBuffer;
}

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const gl = g();
  const tail = gl.__cryptxLedgerMutexTail ?? Promise.resolve();
  const run = tail.then(fn, fn);
  gl.__cryptxLedgerMutexTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function prevHashForDevice(
  deviceId: string,
  buf: QueuedLedger[],
): Promise<string> {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i]!.doc.deviceId === deviceId) return buf[i]!.doc.hash;
  }
  const db = await getDb();
  await ensureIndexes(db);
  return getLastLogHashForDevice(db, deviceId);
}

function nextFlushDelayMs(): number {
  const { min, max } = getLedgerLogFlushBoundsMs();
  const span = Math.max(0, max - min);
  return min + Math.floor(Math.random() * (span + 1));
}

function scheduleFlush(): void {
  const gl = g();
  const buf = gl.__cryptxLedgerBuffer ?? [];
  if (buf.length >= MAX_BUFFER_BEFORE_FORCE_FLUSH) {
    if (gl.__cryptxLedgerFlushTimer) {
      clearTimeout(gl.__cryptxLedgerFlushTimer);
      gl.__cryptxLedgerFlushTimer = undefined;
    }
    queueMicrotask(() => {
      void flushLedgerBuffer();
    });
    return;
  }
  if (gl.__cryptxLedgerFlushTimer) return;
  gl.__cryptxLedgerFlushTimer = setTimeout(() => {
    gl.__cryptxLedgerFlushTimer = undefined;
    void flushLedgerBuffer();
  }, nextFlushDelayMs());
}

/**
 * Pending ledger rows not yet written to MongoDB. Keeps rate limits accurate
 * while batching $push per device.
 */
export async function getBufferThreatDeltas(
  ip: string,
  deviceId: string,
  nonce: string,
  nowMs: number,
): Promise<{ rate: number; authFail: number; tx: number; dupNonce: boolean }> {
  return withMutex(async () => {
    const buf = g().__cryptxLedgerBuffer ?? [];
    let rate = 0;
    let authFail = 0;
    let tx = 0;
    let dupNonce = false;

    for (const item of buf) {
      const d = item.doc;
      const ingestion = d.metadata["ingestion"];
      const isServer = ingestion === "server";
      if (d.deviceId === deviceId && d.nonce === nonce) dupNonce = true;

      const t = d.timestamp.getTime();
      if (isServer) continue;
      if (
        nowMs - t <= RATE_W &&
        d.ipAddress === ip &&
        d.action !== "CONNECT" &&
        d.action !== "DISCONNECT"
      ) {
        rate++;
      }
      if (
        nowMs - t <= AUTH_FAIL_W &&
        d.deviceId === deviceId &&
        d.action === "AUTH_FAIL"
      ) {
        authFail++;
      }
      if (
        nowMs - t <= TX_W &&
        d.deviceId === deviceId &&
        (d.action === "SIGN_TX" || d.action === "SEND_TX")
      ) {
        tx++;
      }
    }

    return { rate, authFail, tx, dupNonce };
  });
}

export async function enqueueBufferedLog(
  input: AppendLogInput,
): Promise<{ id: string; hash: string }> {
  return withMutex(async () => {
    const gl = g();
    const prevHash = await prevHashForDevice(
      input.deviceId,
      gl.__cryptxLedgerBuffer ?? [],
    );

    const metadata = enrichMetadataWithImf(input.metadata);
    const timestamp = new Date();
    const doc = toLogDocumentWithHash(prevHash, {
      timestamp,
      deviceId: input.deviceId,
      ipAddress: input.ipAddress,
      action: input.action,
      status: input.status,
      metadata,
      nonce: input.nonce,
      signatureHash: input.signatureHash,
      prevHash,
    });

    const _id = new ObjectId();
    const item: QueuedLedger = { queuedAt: Date.now(), _id, doc };
    if (!gl.__cryptxLedgerBuffer) gl.__cryptxLedgerBuffer = [];
    gl.__cryptxLedgerBuffer.push(item);
    scheduleFlush();
    return { id: _id.toHexString(), hash: doc.hash };
  });
}

async function flushLedgerBuffer(): Promise<void> {
  await withMutex(async () => {
    const gl = g();
    const buf = gl.__cryptxLedgerBuffer ?? [];
    if (!buf.length) return;

    const batch = buf.splice(0, buf.length);
    const db = await getDb();
    await ensureIndexes(db);

    const byDevice = new Map<string, QueuedLedger[]>();
    for (const item of batch) {
      const id = item.doc.deviceId;
      if (!byDevice.has(id)) byDevice.set(id, []);
      byDevice.get(id)!.push(item);
    }

    try {
      for (const [deviceId, items] of byDevice) {
        const payload: LedgerLogEntry[] = items.map((it) => ({
          _id: it._id,
          ...it.doc,
        }));
        const now = new Date();
        const coll = storageCollectionForDeviceId(deviceId);
        const upd: UpdateFilter<LedgerDeviceDocument> = {
          $push: { logs: { $each: payload } },
          $set: { updatedAt: now },
          $setOnInsert: {
            deviceId,
            registeredAt: now,
          },
        };
        await db
          .collection<LedgerDeviceDocument>(coll)
          .updateOne({ deviceId }, upd, { upsert: true });
      }
    } catch (e) {
      gl.__cryptxLedgerBuffer = [...batch, ...(gl.__cryptxLedgerBuffer ?? [])];
      throw e;
    }
  });

  const gl = g();
  if ((gl.__cryptxLedgerBuffer?.length ?? 0) > 0) {
    scheduleFlush();
  }
}
