import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// A dedicated throwaway DB: this test deliberately corrupts a v23 database by
// removing columns that the current code requires, then verifies that opening
// it again repairs the schema without waiting for a version bump.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-schema-repair-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const factFts = await import("../src/services/memoryFactFts.js");

test("a v23 database missing seed lifecycle columns is repaired on open", () => {
  let db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 23);
  closeDb();

  // Simulate the hot-reload race: user_version advanced, but the version-guarded
  // seed migration did not land on this file.
  db = new Database(process.env.DB_PATH!);
  db.exec(`
    DROP INDEX IF EXISTS ix_hc_seeds_scope_status;
    DROP INDEX IF EXISTS ix_hc_streams_theater_origin;
    ALTER TABLE hippocampus_seeds DROP COLUMN revision;
    ALTER TABLE hippocampus_seeds DROP COLUMN status;
    ALTER TABLE hippocampus_seeds DROP COLUMN applicability_json;
    ALTER TABLE hippocampus_streams DROP COLUMN origin_theater_id;
  `);
  db.pragma("user_version = 22");
  const before = db.prepare("PRAGMA table_info(hippocampus_seeds)").all() as { name: string }[];
  assert.ok(!before.some((column) => column.name === "status"));
  db.close();

  db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 23);
  const seedColumns = db.prepare("PRAGMA table_info(hippocampus_seeds)").all() as { name: string }[];
  for (const column of ["revision", "status", "applicability_json"]) {
    assert.ok(seedColumns.some((item) => item.name === column), column);
  }
  const streamColumns = db.prepare("PRAGMA table_info(hippocampus_streams)").all() as { name: string }[];
  assert.ok(streamColumns.some((column) => column.name === "origin_theater_id"));
  const overview = db
    .prepare(
      `SELECT COUNT(*) AS active FROM hippocampus_seeds
       WHERE agent_id = -1 AND user_id = 'missing' AND COALESCE(status, 'active') = 'active'`,
    )
    .get() as { active: number };
  assert.equal(Number(overview.active), 0);
  closeDb();
});

test("a v23 database missing v23 memory tables is repaired on open", () => {
  let db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 23);
  closeDb();

  // Simulate a hot reload that advanced user_version before the v23 DDL
  // transaction committed: the version says 23, but the new tables are gone.
  db = new Database(process.env.DB_PATH!);
  db.exec(`
    DROP TABLE IF EXISTS hippocampus_fact_sources;
    DROP TABLE IF EXISTS hippocampus_episodes;
    DROP TABLE IF EXISTS hippocampus_digest_jobs;
    DROP TABLE IF EXISTS hippocampus_entity_aliases;
    DROP TABLE IF EXISTS hippocampus_entity_merges;
    DROP TABLE IF EXISTS hippocampus_predicates;
    DROP TABLE IF EXISTS hippocampus_fact_fts;
  `);
  db.pragma("user_version = 23");
  db.close();

  db = getDb();
  for (const table of [
    "hippocampus_episodes",
    "hippocampus_fact_sources",
    "hippocampus_digest_jobs",
    "hippocampus_predicates",
    "hippocampus_entity_aliases",
    "hippocampus_entity_merges",
  ]) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    assert.equal(row?.name, table, table);
  }
  const viewSql = String(
    (db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'v_hc_facts_current'")
      .get() as { sql?: string } | undefined)?.sql || "",
  );
  assert.match(viewSql, /COALESCE\(valid_at, created_at\)/);
  const predicateCount = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_predicates")
    .get() as { c: number };
  assert.equal(Number(predicateCount.c), 15);
  if (factFts.factFtsReady()) {
    const ftsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hippocampus_fact_fts'")
      .get() as { name?: string } | undefined;
    assert.equal(ftsRow?.name, "hippocampus_fact_fts");
  }
  closeDb();
});
