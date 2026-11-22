import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Build a real v22 file by hand before the backend opens it. The schema keeps
// `hippocampus_entities` / `hippocampus_facts` at their v22 shape (no
// valid_at / invalid_at / cardinality), then initSchema's v23 migration must
// upgrade it in place.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-v23-migration-"));
const dbPath = path.join(tempDir, "v22.db");
process.env.DB_PATH = dbPath;

{
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE hippocampus_entities (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      narrative TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX ix_hc_entities_scope
      ON hippocampus_entities (agent_id, user_id, name, type);

    CREATE TABLE hippocampus_facts (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      from_entity_id TEXT,
      to_entity_id TEXT,
      relation TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'current',
      importance REAL NOT NULL DEFAULT 0.5,
      is_identity INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      expired_at TEXT
    );
    CREATE INDEX ix_hc_facts_scope ON hippocampus_facts (agent_id, user_id, status);
  `);
  const now = "2025-01-01T00:00:00.000Z";
  const insertEntity = legacy.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, description, narrative, embedding, embedding_dim,
       created_at, updated_at)
     VALUES (?, 7, 'default_user', ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
  );
  insertEntity.run("entity-legacy-subject", "他", "user", "他", now, now);
  insertEntity.run("entity-legacy-shanghai", "上海", "location", "上海", now, now);
  insertEntity.run("entity-legacy-old-job", "甲公司", "organization", "甲公司", now, now);
  insertEntity.run("entity-legacy-new-job", "乙公司", "organization", "乙公司", now, now);
  const insertFact = legacy.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, status, importance, is_identity, evidence_json, created_at, updated_at,
       expired_at)
     VALUES (?, 7, 'default_user', ?, ?, ?, ?, 0.8, 'current', 0.5, 0, NULL, ?, ?, NULL)`,
  );
  insertFact.run(
    "fact-legacy-lives-in",
    "entity-legacy-subject",
    "entity-legacy-shanghai",
    "LIVES_IN",
    "他住在上海",
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-legacy-old-job",
    "entity-legacy-subject",
    "entity-legacy-old-job",
    "OCCUPATION",
    "他在甲公司上班",
    "2025-02-01T00:00:00.000Z",
    "2025-02-01T00:00:00.000Z",
  );
  insertFact.run(
    "fact-legacy-new-job",
    "entity-legacy-subject",
    "entity-legacy-new-job",
    "OCCUPATION",
    "他在乙公司上班",
    "2025-03-01T00:00:00.000Z",
    "2025-03-01T00:00:00.000Z",
  );
  legacy.pragma("user_version = 22");
  legacy.close();
}

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const factFts = await import("../src/services/memoryFactFts.js");

test("a real v22 database migrates NULL valid_at and dedupes single-value facts safely", () => {
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 23);

  const livesIn = db
    .prepare("SELECT * FROM hippocampus_facts WHERE id = 'fact-legacy-lives-in'")
    .get() as any;
  assert.equal(livesIn.valid_at, livesIn.created_at, "legacy valid_at = created_at");

  const oldJob = db
    .prepare("SELECT * FROM hippocampus_facts WHERE id = 'fact-legacy-old-job'")
    .get() as any;
  assert.equal(oldJob.status, "expired");
  assert.ok(oldJob.expired_at);
  assert.ok(oldJob.invalid_at, "surplus single-value fact must not keep NULL invalid_at");
  assert.equal(oldJob.invalidation_reason, "migration_dedupe");
  assert.ok(
    oldJob.invalid_at > (oldJob.valid_at || oldJob.created_at),
    "invalid_at must be after the fact start",
  );

  const newJob = db
    .prepare("SELECT * FROM hippocampus_facts WHERE id = 'fact-legacy-new-job'")
    .get() as any;
  assert.equal(newJob.status, "current");

  const scope = memory.memoryScope(7, "default_user");
  const asOf = "2025-01-15T00:00:00.000Z";
  const historical = memory.listFacts(scope, undefined, { asOf });
  assert.equal(historical.total, 1);
  assert.equal(historical.items[0].description, "他住在上海");
  assert.equal(historical.items[0].validAt, "2025-01-01T00:00:00.000Z");

  // A row that legitimately still has NULL valid_at (created after the
  // migration by an older writer) must be visible through COALESCE(...).
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, importance, is_identity, status, valid_at, invalid_at, created_at,
       updated_at, expired_at, cardinality)
     VALUES ('fact-null-valid', 7, 'default_user', 'entity-legacy-subject',
             'entity-legacy-shanghai', 'LIKES', '他喜欢梧桐', 0.7, 0.5, 0, 'current',
             NULL, NULL, '2024-01-01T00:00:00.000Z', NULL, NULL, 'many')`,
  ).run();

  const nullValidAsOf = memory.listFacts(scope, undefined, {
    asOf: "2024-06-01T00:00:00.000Z",
  });
  assert.equal(nullValidAsOf.total, 1);
  assert.equal(nullValidAsOf.items[0].description, "他喜欢梧桐");
  assert.equal(nullValidAsOf.items[0].validAt, null);

  const current = memory.listFacts(scope, "current");
  assert.deepEqual(
    new Set(current.items.map((item: any) => item.description)),
    new Set(["他住在上海", "他在乙公司上班", "他喜欢梧桐"]),
  );

  const viewSql = String(
    (db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'v_hc_facts_current'")
      .get() as { sql?: string } | undefined)?.sql || "",
  );
  assert.match(viewSql, /COALESCE\(valid_at, created_at\)/);
  const viewRows = db.prepare("SELECT id FROM v_hc_facts_current ORDER BY id").all() as {
    id: string;
  }[];
  assert.ok(viewRows.some((row) => row.id === "fact-null-valid"));
  assert.ok(!viewRows.some((row) => row.id === "fact-legacy-old-job"));

  // Old facts get `description_tokens` from the startup incremental backfill
  // (max 1000), so a 2-char Chinese query works after migration without an app
  // restart. The later direct-insert row has NULL tokens and waits for the
  // next repair batch. On a build without FTS5 the fallback is covered
  // elsewhere. External-content FTS resolves `COUNT(*)` through the content
  // table, so filter on the tokens column to count actual backfilled rows.
  if (factFts.factFtsReady()) {
    const ftsCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM hippocampus_fact_fts WHERE description_tokens IS NOT NULL",
      )
      .get() as { c: number };
    assert.equal(Number(ftsCount.c), 3, "three legacy facts backfilled at startup");
    const ftsHits = factFts.searchFactFts(scope, "上海", new Date().toISOString(), null, 10);
    assert.equal(ftsHits?.[0]?.id, "fact-legacy-lives-in");
  }

  closeDb();
});
