import type { Collection, Db } from "mongodb";

export type BlacklistType = "ip" | "device";

export interface BlacklistEntry {
  type: BlacklistType;
  value: string;
  reason: string;
  createdAt: Date;
  expiresAt?: Date;
}

export function getBlacklistCollection(db: Db): Collection<BlacklistEntry> {
  return db.collection<BlacklistEntry>("blacklist");
}

export async function isBlacklisted(
  db: Db,
  ip: string,
  deviceId: string,
): Promise<boolean> {
  const col = getBlacklistCollection(db);
  const now = new Date();
  const hit = await col.findOne({
    $and: [
      {
        $or: [
          { type: "ip" as const, value: ip },
          { type: "device" as const, value: deviceId },
        ],
      },
      {
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
      },
    ],
  });
  return Boolean(hit);
}

export async function addBlacklistEntry(
  db: Db,
  entry: Omit<BlacklistEntry, "createdAt"> & { createdAt?: Date },
): Promise<void> {
  const col = getBlacklistCollection(db);
  await col.updateOne(
    { type: entry.type, value: entry.value },
    {
      $set: {
        ...entry,
        createdAt: entry.createdAt ?? new Date(),
      },
    },
    { upsert: true },
  );
}
