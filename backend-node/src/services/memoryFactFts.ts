/**
 * Incrementally maintained FTS5 index for `hippocampus_facts.description`.
 *
 * The index is an **external-content** FTS5 table: the fact row is the content
 * and the FTS rowid is the fact rowid. `hippocampus_facts.description_tokens`
 * stores the pre-tokenized text (same CJK bigram + lowercase ASCII tokenizer as
 * the in-memory BM25), and triggers mirror the column into FTS. Application
 * writes only compute the tokens column; they never delete/insert FTS rows by
 * hand, which is what makes the index safe to maintain incrementally.
 *
 * There is no startup full rebuild. `repairFactFtsBatch` computes tokens for
 * rows whose column is NULL (startup: max 1000, search: max 500). The old
 * standalone table is migrated once by `ensureFactFtsTable` in db/sqlite.ts.
 *
 * FTS5 is optional: every entry point is try/catch, `searchFactFts` returns
 * `null` when unavailable, and callers fall back to in-memory `bm25FactHits`.
 */
import {
  FACT_FTS_TABLE_SQL,
  ensureFactFtsTable,
  getDb,
  repairFactFtsBatch,
  resetFactFtsSchemaCacheForTests,
} from "../db/sqlite.js";
import { tokenize } from "./memoryTextRank.js";

export { FACT_FTS_TABLE_SQL, repairFactFtsBatch };

export interface FactFtsScope {
  agentId: number;
  userId: string;
}

type FtsState = "unknown" | "ready" | "unavailable";

let ftsState: FtsState = "unknown";
let ftsWarningLogged = false;

function warnOnce(error: unknown) {
  if (ftsWarningLogged) return;
  ftsWarningLogged = true;
  console.warn("[MEMORY_FACT_FTS] FTS5 unavailable, falling back to in-memory BM25", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Canonical token string persisted in `hippocampus_facts.description_tokens`. */
export function factDescriptionTokens(description: unknown): string {
  return tokenize(String(description ?? "")).join(" ");
}

/**
 * Resolve FTS5 availability lazily. `LINGSHU_DISABLE_FACT_FTS=1` is an explicit
 * escape hatch for a broken platform build and for the fallback test.
 */
export function factFtsReady(): boolean {
  if (process.env.LINGSHU_DISABLE_FACT_FTS === "1") return false;
  if (ftsState === "ready") return true;
  if (ftsState === "unavailable") return false;
  try {
    const ready = ensureFactFtsTable(getDb());
    ftsState = ready ? "ready" : "unavailable";
    return ready;
  } catch (error) {
    ftsState = "unavailable";
    warnOnce(error);
    return false;
  }
}

/** Test/ops hook: forget the cached availability probe. */
export function resetFactFtsAvailabilityCacheForTests(): void {
  ftsState = "unknown";
  ftsWarningLogged = false;
  resetFactFtsSchemaCacheForTests();
}

/**
 * Synchronize one fact's tokens by id. Kept for compatibility; `writeFact`
 * writes the column directly, and the FTS triggers do the rest.
 */
export function syncFactFts(factId: string, description: unknown): void {
  if (!factId || !factFtsReady()) return;
  try {
    getDb()
      .prepare("UPDATE hippocampus_facts SET description_tokens = ? WHERE id = ?")
      .run(factDescriptionTokens(description), factId);
  } catch (error) {
    // A failed sync leaves the fact searchable through the in-memory fallback.
    warnOnce(error);
  }
}

/**
 * Compatibility no-op. External-content FTS is cleaned up by the fact delete
 * trigger. Deleting rows from an external-content table directly is invalid
 * and can corrupt the index ("database disk image is malformed").
 */
export function deleteFactFtsForScope(_agentId: number, _userId: string): number {
  return 0;
}

/** Compatibility no-op; see `deleteFactFtsForScope`. */
export function deleteFactFtsRows(_factIds: string[]): number {
  return 0;
}

/**
 * BM25 fact search through FTS5, applying the same scope/time predicates as
 * `loadFactsForRecall` before ranking. Returns `null` when FTS5 is unavailable
 * so the caller can fall back to the in-memory scorer.
 *
 * `bm25()` is negative and more-negative is more relevant, so the SQL orders
 * ASC; the returned array order itself is the rank consumed by RRF.
 */
export function searchFactFts(
  scope: FactFtsScope,
  queryText: string,
  at: string,
  asOf: string | null,
  limit: number,
): any[] | null {
  if (!factFtsReady()) return null;
  const db = getDb();
  // Bounded opportunistic backfill: a legacy database becomes searchable over
  // time without a startup full scan. Failures must not break the search.
  try {
    repairFactFtsBatch(db, 500);
  } catch (error) {
    warnOnce(error);
  }
  const queryTokens = tokenize(String(queryText || "")).slice(0, 64);
  if (!queryTokens.length) return [];
  // Quote every token so FTS5 never treats an ASCII word like "or"/"near" as
  // a query operator. OR matches the in-memory BM25 semantics (partial term
  // overlap still contributes); implicit AND would drop valid partial hits on
  // longer Chinese queries.
  const match = queryTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
  const visibilityAt = asOf ?? at;
  const clauses = [
    "f.agent_id = ?",
    "f.user_id = ?",
    "COALESCE(f.valid_at, f.created_at) <= ?",
    "(f.invalid_at IS NULL OR f.invalid_at > ?)",
  ];
  const params: any[] = [scope.agentId, scope.userId, visibilityAt, visibilityAt];
  if (!asOf) {
    clauses.push("f.expired_at IS NULL", "f.status = 'current'");
  }
  try {
    return db
      .prepare(
        `SELECT f.*, src.name AS source_name, dst.name AS target_name,
                bm25(hippocampus_fact_fts) AS fts_score
         FROM hippocampus_fact_fts
         JOIN hippocampus_facts f ON f.rowid = hippocampus_fact_fts.rowid
         JOIN hippocampus_entities src
           ON src.id = f.from_entity_id
          AND src.agent_id = f.agent_id AND src.user_id = f.user_id
         LEFT JOIN hippocampus_entities dst
           ON dst.id = f.to_entity_id
          AND dst.agent_id = f.agent_id AND dst.user_id = f.user_id
         WHERE hippocampus_fact_fts MATCH ?
           AND ${clauses.join(" AND ")}
         ORDER BY bm25(hippocampus_fact_fts) ASC
         LIMIT ?`,
      )
      .all(match, ...params, Math.max(1, Math.min(Math.floor(limit) || 50, 200))) as any[];
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

/** Exposed for diagnostics/tests: number of FTS rows for one fact id. */
export function countFactFtsRows(factId: string): number {
  if (!factFtsReady()) return 0;
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c
         FROM hippocampus_fact_fts
         JOIN hippocampus_facts f ON f.rowid = hippocampus_fact_fts.rowid
         WHERE f.id = ? AND f.description_tokens IS NOT NULL`,
      )
      .get(factId) as { c: number } | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

/** Number of actually indexed facts for one agent/user scope (health API). */
export function countFactFtsRowsForScope(agentId: number, userId: string): number {
  if (!factFtsReady()) return 0;
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c
         FROM hippocampus_fact_fts
         JOIN hippocampus_facts f ON f.rowid = hippocampus_fact_fts.rowid
         WHERE f.agent_id = ? AND f.user_id = ?
           AND f.description_tokens IS NOT NULL`,
      )
      .get(agentId, userId) as { c: number } | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

/**
 * Facts in this scope that still have no FTS tokens. While this is non-zero the
 * index is incomplete (legacy/imported rows), so recall must fall back to the
 * in-memory BM25 to avoid silently missing the unindexed tail.
 */
export function countPendingFactFtsForScope(agentId: number, userId: string): number {
  if (!factFtsReady()) return 0;
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM hippocampus_facts
         WHERE agent_id = ? AND user_id = ? AND description_tokens IS NULL`,
      )
      .get(agentId, userId) as { c: number } | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

