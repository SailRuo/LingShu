import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-health-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const factFts = await import("../src/services/memoryFactFts.js");
const { registerMemoryRoutes } = await import("../src/routes/memory.js");

const db = getDb();
const agentId = 77;
const userId = "default_user";

function insertFact(input: {
  id: string;
  status: string;
  description: string;
  tokens: string | null;
  expiredAt: string | null;
}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       description_tokens, confidence, importance, is_identity, status, valid_at,
       created_at, updated_at, expired_at, cardinality)
     VALUES (?, ?, ?, NULL, NULL, 'LIKES', ?, ?, 0.9, 0.5, 0, ?, '2024-01-01T00:00:00.000Z',
             ?, ?, ?, 'many')`,
  ).run(
    input.id,
    agentId,
    userId,
    input.description,
    input.tokens,
    input.status,
    now,
    now,
    input.expiredAt,
  );
}

insertFact({
  id: "fact-health-current",
  status: "current",
  description: "他喜欢上海",
  tokens: "上海",
  expiredAt: null,
});
insertFact({
  id: "fact-health-expired",
  status: "expired",
  description: "他以前喜欢北京",
  tokens: null,
  expiredAt: "2025-01-01T00:00:00.000Z",
});

const now = new Date().toISOString();
const old = "2024-01-01T00:00:00.000Z";
function insertJob(input: {
  id: string;
  status: string;
  from: number;
  createdAt: string;
  finishedAt: string | null;
}) {
  db.prepare(
    `INSERT INTO hippocampus_digest_jobs
      (id, agent_id, user_id, from_message_id, to_message_id, status, attempts,
       content_hash, extractor_version, prompt_version, last_error, started_at,
       finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'v23', 'graphiti-v1', ?, ?, ?, ?)`,
  ).run(
    input.id,
    agentId,
    userId,
    input.from,
    input.from + 10,
    input.status,
    `hash-${input.id}`,
    input.status === "failed" ? "boom" : null,
    input.createdAt,
    input.finishedAt,
    input.createdAt,
  );
}
insertJob({ id: "job-old-done", status: "done", from: 1, createdAt: old, finishedAt: old });
insertJob({
  id: "job-pending",
  status: "pending",
  from: 20,
  createdAt: "2025-01-01T00:00:00.000Z",
  finishedAt: null,
});
insertJob({
  id: "job-latest-failed",
  status: "failed",
  from: 40,
  createdAt: now,
  finishedAt: now,
});

test("getMemoryHealth returns fts/facts/digest fields and listDigestJobs orders/limits", () => {
  const health = memory.getMemoryHealth(memory.memoryScope(agentId, userId));
  assert.equal(typeof health.ftsReady, "boolean");
  assert.equal(health.ftsReady, factFts.factFtsReady());
  assert.equal(health.ftsRowsForScope, health.ftsReady ? 1 : 0);
  assert.deepEqual(health.facts, { total: 2, current: 1, expired: 1 });
  assert.equal(health.digest.lastStatus, "failed");
  assert.equal(health.digest.lastAt, now);
  assert.equal(health.digest.failedRecent, 1);
  assert.equal(health.digest.pending, 1);
  assert.equal(health.digest.running, 0);

  const jobs = memory.listDigestJobs(memory.memoryScope(agentId, userId), 2);
  assert.equal(jobs.total, 3);
  assert.equal(jobs.items.length, 2);
  assert.deepEqual(
    jobs.items.map((job: any) => job.id),
    ["job-latest-failed", "job-pending"],
  );
  assert.equal(jobs.items[0].lastError, "boom");
  assert.equal(jobs.items[0].fromMessageId, 40);
  assert.equal(jobs.items[0].extractorVersion, "v23");
  assert.equal(jobs.items[0].promptVersion, "graphiti-v1");
});

test("GET /memory/health and /memory/digest/jobs expose the same shape", async () => {
  const app = Fastify({ logger: false });
  await registerMemoryRoutes(app);
  try {
    const health = await app.inject({
      method: "GET",
      url: `/api/v1/memory/health?agentId=${agentId}&userId=${userId}`,
    });
    assert.equal(health.statusCode, 200);
    const body = health.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "digest",
      "facts",
      "ftsReady",
      "ftsRowsForScope",
    ]);
    assert.deepEqual(body.facts, { total: 2, current: 1, expired: 1 });
    assert.deepEqual(Object.keys(body.digest).sort(), [
      "failedRecent",
      "lastAt",
      "lastStatus",
      "pending",
      "running",
    ]);

    const jobs = await app.inject({
      method: "GET",
      url: `/api/v1/memory/digest/jobs?agentId=${agentId}&userId=${userId}&limit=1`,
    });
    assert.equal(jobs.statusCode, 200);
    assert.equal(jobs.json().total, 3);
    assert.equal(jobs.json().items.length, 1);
    assert.equal(jobs.json().items[0].id, "job-latest-failed");

    const missingScope = await app.inject({
      method: "GET",
      url: "/api/v1/memory/health?agentId=9999&userId=nobody",
    });
    assert.equal(missingScope.statusCode, 200);
    assert.deepEqual(missingScope.json().facts, { total: 0, current: 0, expired: 0 });
    assert.deepEqual(missingScope.json().digest, {
      lastStatus: null,
      lastAt: null,
      failedRecent: 0,
      pending: 0,
      running: 0,
    });
    assert.equal(missingScope.json().ftsRowsForScope, 0);

    const missingJobs = await app.inject({
      method: "GET",
      url: "/api/v1/memory/digest/jobs?agentId=9999&userId=nobody",
    });
    assert.equal(missingJobs.statusCode, 200);
    assert.deepEqual(missingJobs.json(), { items: [], total: 0 });

    const badScope = await app.inject({
      method: "GET",
      url: "/api/v1/memory/health",
    });
    assert.equal(badScope.statusCode, 400);
    assert.equal(badScope.json().detail, "agentId is required");
  } finally {
    await app.close();
  }
  closeDb();
});
