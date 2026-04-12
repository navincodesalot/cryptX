import type { Db } from "mongodb";

import {
  LEDGER_DEVICES_COLLECTION,
  SESSION_AUDIT_DEVICES_COLLECTION,
} from "@/lib/logs/ledgerCollection";

let ensured = false;

async function ensureAuditDeviceIndexes(
  db: Db,
  name: string,
): Promise<void> {
  const c = db.collection(name);
  await c.createIndex({ deviceId: 1 }, { unique: true });
  await c.createIndex({ updatedAt: -1 });
  await c.createIndex({
    deviceId: 1,
    "logs.nonce": 1,
  });
}

export async function ensureIndexes(db: Db): Promise<void> {
  if (ensured) return;

  await ensureAuditDeviceIndexes(db, LEDGER_DEVICES_COLLECTION);
  await ensureAuditDeviceIndexes(db, SESSION_AUDIT_DEVICES_COLLECTION);

  const blacklist = db.collection("blacklist");
  await blacklist.createIndex({ type: 1, value: 1 }, { unique: true });
  await blacklist.createIndex({ createdAt: -1 });

  ensured = true;
}
