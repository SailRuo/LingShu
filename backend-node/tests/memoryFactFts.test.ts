import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-fact-fts-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const factStore = await import("../src/services/memoryFactStore.js");
const factFts = await import("../src/services/memoryFactFts.js");

const db = getDb();

let agentSeq = 0;
function createAgent(label: string): number {
  agentSeq += 1;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO agent_configs
        (name, display_name, role_setting, speaking_style, is_default, is_active,
         self_evolution_enabled, time_mirror_enabled, proactive_enabled,
         created_at, updated_at)
       VALUES (?, ?, '测试人设', '测试风格', 0, 1, 0, 0, 0, ?, ?)`,
    )
    .run(`${label}-${agentSeq}`, label, now, now);
  return Number(info.lastInsertRowid);
}

function insertEntity(agentId: number, name: string, kind = "other"): string {
  const id = `entity-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, 'default_user', ?, 'other', ?, '[]', NULL, ?, NULL, NULL, ?, ?)`,
  ).run(id, agentId, name, kind, name, now, now);
  return id;
}

function insertFactRow(input: {
  agentId: number;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  description: string;
  validAt?: string;
}): string {
  const id = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, importance, is_identity, status, valid_at, created_at, updated_at, cardinality)
     VALUES (?, ?, 'default_user', ?, ?, ?, ?, 0.9, 0.5, 0, 'current', ?, ?, ?, 'many')`,
  ).run(
    id,
    input.agentId,
    input.fromEntityId,
    input.toEntityId,
    input.relation,
    input.description,
    input.validAt || "2024-01-01T00:00:00.000Z",
    now,
    now,
  );
  return id;
}

function writeFact(input: {
  agentId: number;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  description: string;
}): string {
  return factStore.writeFact({
    scope: { agentId: input.agentId, userId: "default_user" },
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    relation: input.relation,
    description: input.description,
    confidence: 0.9,
    importance: 0.5,
    validAt: "2024-01-01T00:00:00.000Z",
    fallbackSingleValue: false,
  }).factId;
}

test("FTS5 table exists and a 2-character Chinese query hits without restart", async (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'hippocampus_fact_fts'")
    .get() as { name?: string } | undefined;
  assert.equal(row?.name, "hippocampus_fact_fts");

  const agentId = createAgent("FTS上海");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const shanghai = insertEntity(agentId, "上海", "location");
  const factId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: shanghai,
    relation: "LIVES_IN",
    description: "他住在上海",
  });

  // Written through writeFact → immediately searchable, no restart.
  const ftsRows = factFts.searchFactFts(scope, "上海", new Date().toISOString(), null, 10);
  assert.ok(ftsRows && ftsRows.length >= 1);
  assert.equal(ftsRows[0].id, factId);
  assert.equal(factFts.countFactFtsRows(factId), 1);

  const recalled = (await memory.recallFactsHybrid(scope, {
    queryText: "上海",
    limit: 5,
    backfill: false,
  })) as any[];
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].description, "他住在上海");
  assert.equal(recalled[0].recallSource, "bm25");
});

test("rewriting a duplicate statement updates the same FTS row (no stale tokens)", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const agentId = createAgent("FTS更新");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const alice = insertEntity(agentId, "Alice", "person");

  const firstId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: alice,
    relation: "HAS_FRIEND",
    description: "Alice 是他的朋友",
  });
  const secondId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: alice,
    relation: "HAS_FRIEND",
    description: "Alice 最近很忙",
  });

  assert.equal(secondId, firstId, "duplicate keeps one fact row");
  const facts = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].description, "Alice 最近很忙");
  assert.equal(factFts.countFactFtsRows(firstId), 1, "exactly one FTS row per fact");
  const stale = factFts.searchFactFts(scope, "朋友", new Date().toISOString(), null, 10);
  assert.equal(stale?.length ?? 0, 0, "old description tokens are gone");
  const fresh = factFts.searchFactFts(scope, "很忙", new Date().toISOString(), null, 10);
  assert.equal(fresh?.length, 1);
});

test("clearAllMemory removes FTS rows for the scope", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const agentId = createAgent("FTS清理");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const coffee = insertEntity(agentId, "咖啡", "object");
  const factId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢手冲咖啡",
  });
  assert.equal(factFts.countFactFtsRows(factId), 1);
  memory.clearAllMemory(scope);
  assert.equal(factFts.countFactFtsRows(factId), 0);
  const remaining = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_facts WHERE agent_id = ?")
    .get(agentId) as { c: number };
  assert.equal(Number(remaining.c), 0);
});

test("FTS search applies current and world_as_of time predicates", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const agentId = createAgent("FTS时间");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const shanghai = insertEntity(agentId, "上海", "location");
  factStore.writeFact({
    scope: { agentId, userId: "default_user" },
    fromEntityId: subject,
    toEntityId: shanghai,
    relation: "LIVES_IN",
    description: "他住在上海",
    confidence: 0.9,
    validAt: "2024-01-01T00:00:00.000Z",
    invalidAt: "2025-01-01T00:00:00.000Z",
    fallbackSingleValue: true,
  });

  const current = factFts.searchFactFts(scope, "上海", new Date().toISOString(), null, 10);
  assert.equal(current?.length ?? 0, 0, "closed historical fact is not current");
  const historical = factFts.searchFactFts(
    scope,
    "上海",
    new Date().toISOString(),
    "2024-06-01T00:00:00.000Z",
    10,
  );
  assert.equal(historical?.length, 1);
  assert.equal(historical?.[0]?.description, "他住在上海");
});

test("empty FTS table and explicit FTS disable both fall back to in-memory BM25", async () => {
  const agentId = createAgent("FTS降级");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const coffee = insertEntity(agentId, "手冲咖啡", "object");
  // Direct SQL insert bypasses writeFact sync, simulating legacy rows with no
  // FTS row (the startup rebuild only runs once per process).
  const factId = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, importance, is_identity, status, valid_at, created_at, updated_at, cardinality)
     VALUES (?, ?, 'default_user', ?, ?, 'LIKES', '他喜欢手冲咖啡', 0.9, 0.5, 0, 'current', ?, ?, ?, 'many')`,
  ).run(factId, agentId, subject, coffee, "2024-01-01T00:00:00.000Z", now, now);
  assert.equal(factFts.countFactFtsRows(factId), 0);

  const emptyFtsRecall = (await memory.recallFactsHybrid(scope, {
    queryText: "手冲咖啡",
    limit: 5,
    backfill: false,
  })) as any[];
  assert.equal(emptyFtsRecall.length, 1);
  assert.equal(emptyFtsRecall[0].recallSource, "bm25");

  process.env.LINGSHU_DISABLE_FACT_FTS = "1";
  try {
    const disabledRecall = (await memory.recallFactsHybrid(scope, {
      queryText: "手冲咖啡",
      limit: 5,
      backfill: false,
    })) as any[];
    assert.equal(disabledRecall.length, 1);
    assert.equal(disabledRecall[0].recallSource, "bm25");
    assert.equal(factFts.searchFactFts(scope, "手冲咖啡", now, null, 10), null);
  } finally {
    delete process.env.LINGSHU_DISABLE_FACT_FTS;
  }
});

test("repairFactFtsBatch fills only NULL tokens, never deletes existing FTS rows, and batches", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  // Drain anything left pending by earlier tests so this test owns the queue.
  factFts.repairFactFtsBatch(db, 100000);
  assert.equal(pendingTokenCount(), 0);

  const agentId = createAgent("FTS回填");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const coffee = insertEntity(agentId, "咖啡", "object");
  const indexedId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢手冲咖啡",
  });
  assert.equal(factFts.countFactFtsRows(indexedId), 1);

  const first = insertFactRow({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢上海咖啡馆",
  });
  const second = insertFactRow({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢北京茶馆",
  });
  const third = insertFactRow({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢广州糖水",
  });
  assert.equal(pendingTokenCount(), 3);

  assert.equal(factFts.repairFactFtsBatch(db, 2), 2, "first batch processes two rows");
  assert.equal(pendingTokenCount(), 1);
  assert.equal(factFts.repairFactFtsBatch(db, 2), 1, "second batch finishes the queue");
  assert.equal(pendingTokenCount(), 0);

  // Existing indexed row was not deleted or rebuilt by the repair batches.
  assert.equal(factFts.countFactFtsRows(indexedId), 1);
  for (const [id, query] of [
    [first, "上海"],
    [second, "北京"],
    [third, "广州"],
  ] as const) {
    const hits = factFts.searchFactFts(scope, query, new Date().toISOString(), null, 10);
    assert.equal(hits?.[0]?.id, id, query);
    assert.equal(factFts.countFactFtsRows(id), 1);
  }
});

test("direct SQL insert/update of description is repaired without stale tokens", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  factFts.repairFactFtsBatch(db, 100000);
  const agentId = createAgent("FTS直改");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const book = insertEntity(agentId, "旧书", "object");
  const factId = insertFactRow({
    agentId,
    fromEntityId: subject,
    toEntityId: book,
    relation: "LIKES",
    description: "他喜欢旧书",
  });
  assert.equal(factFts.countFactFtsRows(factId), 0, "direct insert has no tokens yet");

  assert.equal(factFts.repairFactFtsBatch(db, 1000), 1);
  assert.equal(
    factFts.searchFactFts(scope, "旧书", new Date().toISOString(), null, 10)?.[0]?.id,
    factId,
  );

  // Bypass writeFact: the description trigger must invalidate the old tokens,
  // and the next repair must remove the old index entry instead of leaving it.
  db.prepare("UPDATE hippocampus_facts SET description = ? WHERE id = ?").run(
    "他喜欢新唱片",
    factId,
  );
  const row = db
    .prepare("SELECT description_tokens FROM hippocampus_facts WHERE id = ?")
    .get(factId) as { description_tokens: string | null };
  assert.equal(row.description_tokens, null, "direct description update clears tokens");

  factFts.repairFactFtsBatch(db, 1000);
  assert.equal(
    factFts.searchFactFts(scope, "唱片", new Date().toISOString(), null, 10)?.[0]?.id,
    factId,
  );
  assert.equal(
    factFts.searchFactFts(scope, "旧书", new Date().toISOString(), null, 10)?.length ?? 0,
    0,
    "old tokens do not survive",
  );
  assert.equal(factFts.countFactFtsRows(factId), 1);
});

test("writeFact new, duplicate and out-of-order rows are all searchable with one FTS row each", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const agentId = createAgent("FTS乱序");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const shanghai = insertEntity(agentId, "上海", "location");
  const beijing = insertEntity(agentId, "北京", "location");

  const current = factStore.writeFact({
    scope: { agentId, userId: "default_user" },
    fromEntityId: subject,
    toEntityId: shanghai,
    relation: "LIVES_IN",
    description: "他住在上海",
    confidence: 0.9,
    validAt: "2025-01-01T00:00:00.000Z",
    fallbackSingleValue: true,
  });
  assert.equal(factFts.countFactFtsRows(current.factId), 1);

  // Duplicate statement: same row, refreshed wording, still exactly one row.
  const duplicate = factStore.writeFact({
    scope: { agentId, userId: "default_user" },
    fromEntityId: subject,
    toEntityId: shanghai,
    relation: "LIVES_IN",
    description: "他定居上海",
    confidence: 0.9,
    validAt: "2025-01-01T00:00:00.000Z",
    fallbackSingleValue: true,
  });
  assert.equal(duplicate.factId, current.factId);
  assert.equal(factFts.countFactFtsRows(current.factId), 1);
  assert.equal(
    factFts.searchFactFts(scope, "定居", new Date().toISOString(), null, 10)?.[0]?.id,
    current.factId,
  );
  assert.equal(
    factFts.searchFactFts(scope, "住在", new Date().toISOString(), null, 10)?.length ?? 0,
    0,
    "duplicate update replaced the old tokens",
  );

  // Out-of-order historical row: older than the surviving current fact.
  const history = factStore.writeFact({
    scope: { agentId, userId: "default_user" },
    fromEntityId: subject,
    toEntityId: beijing,
    relation: "LIVES_IN",
    description: "他曾住北京",
    confidence: 0.8,
    validAt: "2024-01-01T00:00:00.000Z",
    fallbackSingleValue: true,
  });
  assert.notEqual(history.factId, current.factId);
  const historyRow = db
    .prepare("SELECT status, invalidation_reason FROM hippocampus_facts WHERE id = ?")
    .get(history.factId) as { status: string; invalidation_reason: string };
  assert.equal(historyRow.status, "expired");
  assert.equal(historyRow.invalidation_reason, "out_of_order");
  assert.equal(factFts.countFactFtsRows(history.factId), 1);
  assert.equal(
    factFts.searchFactFts(scope, "北京", new Date().toISOString(), null, 10)?.length ?? 0,
    0,
    "historical row is not current",
  );
  assert.equal(
    factFts.searchFactFts(
      scope,
      "北京",
      new Date().toISOString(),
      "2024-06-01T00:00:00.000Z",
      10,
    )?.[0]?.id,
    history.factId,
  );
});

test("old standalone FTS table is migrated to external-content by dropping only the index", (t) => {
  if (!factFts.factFtsReady()) {
    t.skip("FTS5 unavailable on this SQLite build");
    return;
  }
  const factsBefore = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts").get() as { c: number }).c,
  );

  db.exec(`
    DROP TRIGGER IF EXISTS hippocampus_fact_fts_ai;
    DROP TRIGGER IF EXISTS hippocampus_fact_fts_ad;
    DROP TRIGGER IF EXISTS hippocampus_fact_fts_au;
    DROP TRIGGER IF EXISTS hippocampus_fact_fts_desc;
    DROP TABLE hippocampus_fact_fts;
    CREATE VIRTUAL TABLE hippocampus_fact_fts USING fts5(
      fact_id UNINDEXED,
      description_tokens,
      tokenize = 'unicode61'
    );
  `);
  const beforeSql = String(
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hippocampus_fact_fts'")
        .get() as { sql?: string }
    )?.sql || "",
  );
  assert.match(beforeSql, /fact_id UNINDEXED/);

  factFts.resetFactFtsAvailabilityCacheForTests();
  assert.equal(factFts.factFtsReady(), true);
  const afterSql = String(
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hippocampus_fact_fts'")
        .get() as { sql?: string }
    )?.sql || "",
  );
  assert.match(afterSql, /content\s*=\s*'hippocampus_facts'/i);
  assert.match(afterSql, /content_rowid\s*=\s*'rowid'/i);
  const factsAfter = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM hippocampus_facts").get() as { c: number }).c,
  );
  assert.equal(factsAfter, factsBefore, "facts are not rewritten by the index migration");

  // Triggers were recreated against the new external-content table: a write
  // after migration is immediately searchable.
  const agentId = createAgent("FTS迁移后");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "他", "person");
  const coffee = insertEntity(agentId, "咖啡", "object");
  const factId = writeFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢冷萃咖啡",
  });
  assert.equal(
    factFts.searchFactFts(scope, "冷萃", new Date().toISOString(), null, 10)?.[0]?.id,
    factId,
  );
  assert.equal(factFts.countFactFtsRows(factId), 1);
});

test("startup path contains no full FTS rebuild", () => {
  const source = fs.readFileSync(
    new URL("../src/db/sqlite.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /DELETE\s+FROM\s+hippocampus_fact_fts/i);
  assert.match(source, /WHERE description_tokens IS NULL/);
  assert.match(source, /content='hippocampus_facts'/);
});

function pendingTokenCount(): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM hippocampus_facts WHERE description_tokens IS NULL",
        )
        .get() as { c: number }
    ).c,
  );
}

test("cleanup", () => {
  closeDb();
});
