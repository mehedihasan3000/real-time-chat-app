import { MongoClient } from "mongodb";
import type { AppConfig } from "../config.js";

export function createMongoClient(config: AppConfig): MongoClient {
  return new MongoClient(config.mongodb.uri, {
    appName: "real-time-chat-api",
    serverSelectionTimeoutMS: config.mongodb.connectTimeoutMs,
  });
}

export async function withMongoClient<T>(
  config: AppConfig,
  operation: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = createMongoClient(config);

  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.close();
  }
}

export interface MongoPingResult {
  dbName: string;
  latencyMs: number;
}

export async function pingMongo(config: AppConfig): Promise<MongoPingResult> {
  const startedAt = performance.now();

  await withMongoClient(config, async (client) => {
    await client.db(config.mongodb.dbName).command({ ping: 1 });
  });

  return {
    dbName: config.mongodb.dbName,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
