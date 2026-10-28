import { assertSafeSeedTarget, loadConfig, loadRootEnvFile } from "../config.js";
import { withMongoClient } from "../db/mongo.js";
import { reportCliError } from "./cli.js";

const fixtureId = "local-dev-v1";

interface DevFixture {
  _id: string;
  kind: string;
  schemaVersion: number;
  synthetic: boolean;
  generatedAt: string;
  note: string;
  users: Array<{ userId: string; username: string; displayName: string }>;
  conversation: { conversationId: string; participantIds: string[]; pairKey: string };
  messages: Array<{
    messageId: string;
    conversationId: string;
    seq: number;
    senderUserId: string;
    envelopePlaceholder: string;
  }>;
}

const fixture: DevFixture = {
  _id: fixtureId,
  kind: "synthetic-local-fixture",
  schemaVersion: 1,
  synthetic: true,
  generatedAt: new Date().toISOString(),
  note: "Synthetic local-development fixture. Contains no real accounts, credentials, or message plaintext.",
  users: [
    {
      userId: "dev-user-alice",
      username: "alice_dev",
      displayName: "Alice (synthetic)",
    },
    {
      userId: "dev-user-bob",
      username: "bob_dev",
      displayName: "Bob (synthetic)",
    },
  ],
  conversation: {
    conversationId: "dev-conversation-alice-bob",
    participantIds: ["dev-user-alice", "dev-user-bob"],
    pairKey: "dev-user-alice:dev-user-bob",
  },
  messages: [
    {
      messageId: "dev-message-0001",
      conversationId: "dev-conversation-alice-bob",
      seq: 1,
      senderUserId: "dev-user-alice",
      envelopePlaceholder: "synthetic-not-ciphertext-0001",
    },
    {
      messageId: "dev-message-0002",
      conversationId: "dev-conversation-alice-bob",
      seq: 2,
      senderUserId: "dev-user-bob",
      envelopePlaceholder: "synthetic-not-ciphertext-0002",
    },
  ],
};

loadRootEnvFile();

try {
  const config = loadConfig();
  assertSafeSeedTarget(config);

  const totalFixtures = await withMongoClient(config, async (client) => {
    const collection = client.db(config.mongodb.dbName).collection<DevFixture>("dev_fixtures");
    await collection.replaceOne({ _id: fixtureId }, fixture, { upsert: true });
    return collection.countDocuments({ kind: "synthetic-local-fixture" });
  });

  console.log(
    `Seeded synthetic fixtures: db=${config.mongodb.dbName}, fixture=${fixtureId}, users=${fixture.users.length}, messages=${fixture.messages.length}, totalFixtures=${totalFixtures}`,
  );
} catch (error) {
  reportCliError(error);
  process.exitCode = 1;
}
