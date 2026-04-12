import type { Db, Document, UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";

import { enrichMetadataWithImf } from "@/lib/imf/parseImf";
import { ensureIndexes } from "@/lib/mongo/indexes";

import { computeLogHash, hashRawSignature, toLogDocumentWithHash } from "./hashChain";
import {
  LEDGER_DEVICES_COLLECTION,
  SESSION_AUDIT_DEVICES_COLLECTION,
  storageCollectionForDeviceId,
} from "./ledgerCollection";
import type {
  LedgerDeviceDocument,
  LedgerLogEntry,
  LogAction,
  LogDocument,
  LogStatus,
} from "./types";
import { GENESIS_PREV_HASH } from "./types";

export interface AppendLogInput {
  deviceId: string;
  ipAddress: string;
  action: LogAction;
  status: LogStatus;
  metadata: Record<string, unknown>;
  nonce: string;
  signatureHash: string;
}

export async function getLastLogHashForDevice(
  db: Db,
  deviceId: string,
): Promise<string> {
  await ensureIndexes(db);
  const coll = storageCollectionForDeviceId(deviceId);
  const row = await db
    .collection<LedgerDeviceDocument>(coll)
    .findOne({ deviceId }, { projection: { logs: { $slice: -1 } } });
  const last = row?.logs?.[0];
  return last?.hash ?? GENESIS_PREV_HASH;
}

export async function appendLog(
  db: Db,
  input: AppendLogInput,
): Promise<{ id: string; hash: string }> {
  await ensureIndexes(db);
  const coll = storageCollectionForDeviceId(input.deviceId);
  const prevHash = await getLastLogHashForDevice(db, input.deviceId);
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
  const entry: LedgerLogEntry = { _id, ...doc };

  const upd: UpdateFilter<LedgerDeviceDocument> = {
    $push: { logs: entry },
    $set: { updatedAt: timestamp },
    $setOnInsert: {
      deviceId: input.deviceId,
      registeredAt: timestamp,
    },
  };
  await db
    .collection<LedgerDeviceDocument>(coll)
    .updateOne({ deviceId: input.deviceId }, upd, { upsert: true });

  return { id: _id.toHexString(), hash: doc.hash };
}

export interface LogQuery {
  deviceId?: string;
  action?: LogAction;
  status?: LogStatus;
  from?: Date;
  to?: Date;
  limit?: number;
  skip?: number;
}

function matchParent(q: LogQuery, coll: string): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (q.deviceId) {
    if (
      coll === LEDGER_DEVICES_COLLECTION &&
      !q.deviceId.startsWith("ledger-")
    ) {
      return { _id: null };
    }
    if (
      coll === SESSION_AUDIT_DEVICES_COLLECTION &&
      q.deviceId.startsWith("ledger-")
    ) {
      return { _id: null };
    }
    match.deviceId = q.deviceId;
  }
  return match;
}

function logFieldFilters(q: LogQuery): Record<string, unknown>[] {
  const stages: Record<string, unknown>[] = [];
  if (q.action) stages.push({ $match: { action: q.action } });
  if (q.status) stages.push({ $match: { status: q.status } });
  if (q.from || q.to) {
    const ts: Record<string, Date> = {};
    if (q.from) ts.$gte = q.from;
    if (q.to) ts.$lte = q.to;
    stages.push({ $match: { timestamp: ts } });
  }
  return stages;
}

function unwindPipelineStages(
  coll: string,
  q: LogQuery,
): Record<string, unknown>[] {
  const parent = matchParent(q, coll);
  return [
    ...(Object.keys(parent).length ? [{ $match: parent }] : []),
    { $unwind: "$logs" },
    {
      $replaceRoot: {
        newRoot: {
          $mergeObjects: ["$logs", { deviceId: "$deviceId" }],
        },
      },
    },
    ...logFieldFilters(q),
  ];
}

export async function queryLogs(db: Db, q: LogQuery): Promise<LogDocument[]> {
  await ensureIndexes(db);
  const limit = Math.min(q.limit ?? 100, 500);
  const skip = q.skip ?? 0;

  if (q.deviceId?.startsWith("ledger-")) {
    const pipeline = [
      ...unwindPipelineStages(LEDGER_DEVICES_COLLECTION, q),
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];
    return db
      .collection(LEDGER_DEVICES_COLLECTION)
      .aggregate<LogDocument>(pipeline)
      .toArray();
  }

  if (q.deviceId && !q.deviceId.startsWith("ledger-")) {
    const pipeline = [
      ...unwindPipelineStages(SESSION_AUDIT_DEVICES_COLLECTION, q),
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];
    return db
      .collection(SESSION_AUDIT_DEVICES_COLLECTION)
      .aggregate<LogDocument>(pipeline)
      .toArray();
  }

  const ledgerStages = unwindPipelineStages(LEDGER_DEVICES_COLLECTION, q);
  const sessionStages = unwindPipelineStages(SESSION_AUDIT_DEVICES_COLLECTION, q);
  const pipeline: Document[] = [
    ...ledgerStages,
    {
      $unionWith: {
        coll: SESSION_AUDIT_DEVICES_COLLECTION,
        pipeline: sessionStages as Document[],
      },
    },
    { $sort: { timestamp: -1 } },
    { $skip: skip },
    { $limit: limit },
  ];

  return db
    .collection(LEDGER_DEVICES_COLLECTION)
    .aggregate<LogDocument>(pipeline)
    .toArray();
}

export async function getLogById(
  db: Db,
  id: string,
): Promise<(LogDocument & { _id: ObjectId }) | null> {
  await ensureIndexes(db);
  if (!ObjectId.isValid(id)) return null;
  const oid = new ObjectId(id);

  for (const coll of [
    LEDGER_DEVICES_COLLECTION,
    SESSION_AUDIT_DEVICES_COLLECTION,
  ]) {
    const row = await db
      .collection<LedgerDeviceDocument>(coll)
      .findOne(
        { "logs._id": oid },
        { projection: { deviceId: 1, logs: { $elemMatch: { _id: oid } } } },
      );
    const entry = row?.logs?.[0];
    if (entry && row?.deviceId) {
      return { ...entry, deviceId: row.deviceId };
    }
  }
  return null;
}

export function resolveSignatureHash(
  signature: string | undefined,
  signatureHash: string | undefined,
): string {
  if (signatureHash) return signatureHash.toLowerCase();
  if (signature) return hashRawSignature(signature);
  return hashRawSignature("");
}

export function verifyLogHash(doc: LogDocument): boolean {
  const expected = computeLogHash(doc.prevHash, {
    timestamp: doc.timestamp,
    deviceId: doc.deviceId,
    ipAddress: doc.ipAddress,
    action: doc.action,
    status: doc.status,
    metadata: doc.metadata,
    nonce: doc.nonce,
    signatureHash: doc.signatureHash,
  });
  return expected === doc.hash;
}

/** DB-side duplicate nonce check (per device, correct collection). */
export async function hasNonceForDevice(
  db: Db,
  deviceId: string,
  nonce: string,
): Promise<boolean> {
  await ensureIndexes(db);
  const coll = storageCollectionForDeviceId(deviceId);
  const found = await db.collection(coll).findOne(
    { deviceId, "logs.nonce": nonce },
    { projection: { _id: 1 } },
  );
  return found !== null;
}

/** Client-originated /api/log spam — count embedded rows in hardware collection only. */
export async function countNonServerLogsByIpSince(
  db: Db,
  ip: string,
  since: Date,
): Promise<number> {
  await ensureIndexes(db);
  const agg = await db
    .collection(LEDGER_DEVICES_COLLECTION)
    .aggregate<{ c: number }>([
      { $unwind: "$logs" },
      {
        $match: {
          "logs.ipAddress": ip,
          "logs.timestamp": { $gte: since },
          "logs.metadata.ingestion": { $ne: "server" },
          "logs.action": { $nin: ["CONNECT", "DISCONNECT"] },
        },
      },
      { $count: "c" },
    ])
    .toArray();
  return agg[0]?.c ?? 0;
}

export async function countAuthFailsForDeviceSince(
  db: Db,
  deviceId: string,
  since: Date,
): Promise<number> {
  await ensureIndexes(db);
  const coll = storageCollectionForDeviceId(deviceId);
  const agg = await db
    .collection(coll)
    .aggregate<{ c: number }>([
      { $unwind: "$logs" },
      {
        $match: {
          "logs.deviceId": deviceId,
          "logs.action": "AUTH_FAIL",
          "logs.timestamp": { $gte: since },
          "logs.metadata.ingestion": { $ne: "server" },
        },
      },
      { $count: "c" },
    ])
    .toArray();
  return agg[0]?.c ?? 0;
}

export async function countTxActionsForDeviceSince(
  db: Db,
  deviceId: string,
  since: Date,
): Promise<number> {
  await ensureIndexes(db);
  const coll = storageCollectionForDeviceId(deviceId);
  const agg = await db
    .collection(coll)
    .aggregate<{ c: number }>([
      { $unwind: "$logs" },
      {
        $match: {
          "logs.deviceId": deviceId,
          "logs.action": { $in: ["SIGN_TX", "SEND_TX"] },
          "logs.timestamp": { $gte: since },
          "logs.metadata.ingestion": { $ne: "server" },
        },
      },
      { $count: "c" },
    ])
    .toArray();
  return agg[0]?.c ?? 0;
}
