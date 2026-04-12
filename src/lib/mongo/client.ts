import { MongoClient } from "mongodb";

import { getMongoDbName, getMongoUri } from "./env";

/**
 * Standard Next.js pattern: one module-level promise so `connect()` runs once
 * per dev server / serverless instance (see MongoDB Node.js + Next.js docs).
 */
declare global {
  // eslint-disable-next-line no-var -- survive hot reload in dev
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalThis._mongoClientPromise) {
    const client = new MongoClient(getMongoUri());
    globalThis._mongoClientPromise = client.connect().catch((err) => {
      globalThis._mongoClientPromise = undefined;
      throw err;
    });
  }
  return globalThis._mongoClientPromise;
}

export async function getDb() {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
}
