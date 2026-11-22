import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-routes-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const { registerMemoryRoutes } = await import("../src/routes/memory.js");

const db = getDb();
const agentId = 31;
const userId = "default_user";
const now = new Date().toISOString();

function insertEntity(id: string, name: string, kind: string) {
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', ?, '[]', NULL, ?, NULL, NULL, ?, ?)`,
  ).run(id, agentId, userId, name, kind, name, now, now);
}

insertEntity("entity-route-subject", "他", "person");
insertEntity("entity-route-shanghai", "上海", "location");
insertEntity("entity-route-hangzhou", "杭州", "location");

function insertFact(input: {
  id: string;
  toEntityId: string;
  description: string;
  status: string;
  validAt: string;
  invalidAt: string | null;
  expiredAt: string | null;
}) {
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, importance, is_identity, status, valid_at, invalid_at, created_at,
       updated_at, expired_at, cardinality)
     VALUES (?, ?, ?, 'entity-route-subject', ?, 'LIVES_IN', ?, 0.9, 0.5, 0, ?, ?, ?, ?, ?, ?, 'one')`,
  ).run(
    input.id,
    agentId,
    userId,
    input.toEntityId,
    input.description,
    input.status,
    input.validAt,
    input.invalidAt,
    now,
    now,
    input.expiredAt,
  );
}

insertFact({
  id: "fact-route-shanghai",
  toEntityId: "entity-route-shanghai",
  description: "他住在上海",
  status: "expired",
  validAt: "2024-01-01T00:00:00.000Z",
  invalidAt: "2025-01-01T00:00:00.000Z",
  expiredAt: "2025-01-01T00:00:00.000Z",
});
insertFact({
  id: "fact-route-hangzhou",
  toEntityId: "entity-route-hangzhou",
  description: "他住在杭州",
  status: "current",
  validAt: "2025-01-01T00:00:00.000Z",
  invalidAt: null,
  expiredAt: null,
});

test("GET /memory/facts defaults to current, supports asOf, and returns 400/404", async () => {
  const app = Fastify({ logger: false });
  await registerMemoryRoutes(app);
  try {
    const current = await app.inject({
      method: "GET",
      url: `/api/v1/memory/facts?agentId=${agentId}&userId=${userId}`,
    });
    assert.equal(current.statusCode, 200);
    const currentBody = current.json();
    assert.equal(currentBody.total, 1, "default behaviour is current, not all");
    assert.equal(currentBody.items[0].description, "他住在杭州");
    // UI-facing lifecycle fields are additive; existing keys stay unchanged.
    assert.ok("supersededByFactId" in currentBody.items[0]);
    assert.ok("invalidationReason" in currentBody.items[0]);
    assert.ok("updatedAt" in currentBody.items[0]);
    assert.equal(currentBody.items[0].supersededByFactId, null);
    assert.equal(currentBody.items[0].invalidationReason, null);
    assert.ok(currentBody.items[0].updatedAt);

    const historical = await app.inject({
      method: "GET",
      url: `/api/v1/memory/facts?agentId=${agentId}&userId=${userId}&asOf=2024-06-01T00:00:00.000Z`,
    });
    assert.equal(historical.statusCode, 200);
    const historicalBody = historical.json();
    assert.equal(historicalBody.total, 1);
    assert.equal(historicalBody.items[0].description, "他住在上海");
    assert.equal(historicalBody.asOf, "2024-06-01T00:00:00.000Z");

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/memory/facts?agentId=${agentId}&asOf=not-a-date`,
    });
    assert.equal(invalid.statusCode, 400);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/memory/facts/fact-does-not-exist/sources?agentId=${agentId}`,
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
  closeDb();
});
