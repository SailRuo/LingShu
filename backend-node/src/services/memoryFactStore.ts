/**
 * v23 memory fact store — the single write path shared by digest and
 * save_memory.
 *
 * Contract (see local-docs/memory/graphiti-inspired-long-term-memory.md §2–§3):
 *  - facts are never updated in place for a changed value; the old row is
 *    soft-invalidated (`invalid_at` / `expired_at` / `superseded_by_fact_id`)
 *    and the new row becomes current;
 *  - single-value predicates keep exactly one row with `expired_at IS NULL`;
 *    multi-value predicates coexist;
 *  - a repeated subject+relation+object only appends a `hippocampus_fact_sources`
 *    row and refreshes confidence / updated_at;
 *  - every fact has a source episode whenever one exists (digest always does;
 *    save_memory gets a `source='proactive-save'` virtual episode).
 */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db/sqlite.js";
import { nowIso, type MemoryScope } from "./memoryScope.js";
import { factDescriptionTokens } from "./memoryFactFts.js";

export type FactCardinality = "one" | "many";

export type EntityKind =
  | "person"
  | "location"
  | "organization"
  | "pet"
  | "object"
  | "concept"
  | "activity"
  | "event"
  | "theme"
  | "emotion"
  | "other";

/** Fallback when a relation has no registry row (registry is authoritative). */
const SINGLE_VALUE_FALLBACK = new Set([
  "HAS_NAME",
  "AGE",
  "GENDER",
  "LIVES_IN",
  "OCCUPATION",
  "SLEEP_PATTERN",
  "HAS_WORK_PATTERN",
]);

export function entityKindForRelation(relation: string): EntityKind {
  switch (String(relation || "").trim().toUpperCase()) {
    case "HAS_PET":
      return "pet";
    case "LIVES_IN":
      return "location";
    case "HAS_FRIEND":
    case "HAS_FAMILY":
      return "person";
    default:
      return "other";
  }
}

export interface PredicateRow {
  name: string;
  subject_kind: string | null;
  object_kind: string | null;
  cardinality: FactCardinality;
  symmetric: number;
  invalidation_policy: "supersede" | "additive" | "never";
  description: string | null;
}

export function readPredicate(relation: string): PredicateRow | null {
  const name = String(relation || "").trim().toUpperCase();
  if (!name) return null;
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_predicates WHERE name = ?")
    .get(name) as PredicateRow | undefined;
  return row ?? null;
}

/**
 * Resolve cardinality from the registry, falling back to the legacy
 * SINGLE_VALUE_RELATIONS set only when the relation has no registry row.
 */
export function resolveFactCardinality(
  relation: string,
  fallbackIsSingle: boolean,
): FactCardinality {
  const row = readPredicate(relation);
  if (row) return row.cardinality === "one" ? "one" : "many";
  const name = String(relation || "").trim().toUpperCase();
  return fallbackIsSingle || SINGLE_VALUE_FALLBACK.has(name) ? "one" : "many";
}

// ─── Episodes ───────────────────────────────────────────────────────────────

export interface EpisodeInput {
  scope: MemoryScope;
  threadId: number | null;
  source: string;
  sourceDescription?: string | null;
  startedAt: string;
  endedAt: string;
  referenceTime: string;
  rawContent: string;
  contentHash: string;
  messageIds: number[];
}

export interface EpisodeRecord {
  id: string;
  agentId: number;
  userId: string;
  threadId: number | null;
  source: string;
  startedAt: string;
  endedAt: string;
  referenceTime: string;
  rawContent: string;
  contentHash: string;
  messageIds: number[];
  createdAt: string;
}

function episodeFromRow(row: any): EpisodeRecord {
  let messageIds: number[] = [];
  try {
    const parsed = JSON.parse(String(row.message_ids_json || "[]"));
    if (Array.isArray(parsed)) messageIds = parsed.map((value) => Number(value));
  } catch {
    messageIds = [];
  }
  return {
    id: String(row.id),
    agentId: Number(row.agent_id),
    userId: String(row.user_id),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    source: String(row.source || "chat"),
    startedAt: String(row.started_at || ""),
    endedAt: String(row.ended_at || ""),
    referenceTime: String(row.reference_time || ""),
    rawContent: String(row.raw_content || ""),
    contentHash: String(row.content_hash || ""),
    messageIds,
    createdAt: String(row.created_at || ""),
  };
}

/**
 * Create or reuse an episode. `(agent_id, user_id, content_hash)` is unique, so
 * a digest retry always lands on the same immutable raw-content row.
 */
export function ensureEpisode(input: EpisodeInput): EpisodeRecord {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM hippocampus_episodes
       WHERE agent_id = ? AND user_id = ? AND content_hash = ?
       LIMIT 1`,
    )
    .get(input.scope.agentId, input.scope.userId, input.contentHash) as any;
  if (existing) return episodeFromRow(existing);
  const now = nowIso();
  const id = `episode-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  db.prepare(
    `INSERT OR IGNORE INTO hippocampus_episodes
      (id, agent_id, user_id, thread_id, source, source_description, started_at, ended_at,
       reference_time, raw_content, content_hash, message_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope.agentId,
    input.scope.userId,
    input.threadId,
    input.source,
    input.sourceDescription ?? null,
    input.startedAt,
    input.endedAt,
    input.referenceTime,
    input.rawContent,
    input.contentHash,
    JSON.stringify(input.messageIds),
    now,
  );
  const row = db
    .prepare(
      `SELECT * FROM hippocampus_episodes
       WHERE agent_id = ? AND user_id = ? AND content_hash = ?
       LIMIT 1`,
    )
    .get(input.scope.agentId, input.scope.userId, input.contentHash) as any;
  return episodeFromRow(row);
}

/**
 * save_memory has no chat chunk. Give it a virtual episode so every fact still
 * has a traceable source (`source='proactive-save'`, raw_content = evidence).
 */
export function ensureProactiveEpisode(input: {
  scope: MemoryScope;
  threadId: number | null;
  evidence: string;
}): EpisodeRecord {
  const rawContent = String(input.evidence || "");
  const contentHash = createHash("sha1")
    .update(
      `${input.scope.agentId}:${input.scope.userId}:proactive-save:${
        input.threadId ?? "none"
      }:${rawContent}`,
    )
    .digest("hex");
  const now = nowIso();
  return ensureEpisode({
    scope: input.scope,
    threadId: input.threadId,
    source: "proactive-save",
    sourceDescription: input.threadId ? `save_memory:${input.threadId}` : "save_memory",
    startedAt: now,
    endedAt: now,
    referenceTime: now,
    rawContent,
    contentHash,
    messageIds: [],
  });
}

// ─── Source lifecycle ───────────────────────────────────────────────────────

/** Episode ids whose immutable raw chunk belongs to a chat thread. */
export function findEpisodeIdsForThread(
  agentId: number,
  userId: string,
  threadId: number,
): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM hippocampus_episodes
         WHERE agent_id = ? AND user_id = ? AND thread_id = ?`,
      )
      .all(agentId, userId, threadId) as { id: string }[]
  ).map((row) => String(row.id));
}

/**
 * Episode ids covering any of the given chat messages. `message_ids_json` is
 * the authoritative link (episodes can also be proactive-save virtual rows
 * with an empty list), so parse it instead of relying on a JSON1 extension.
 */
export function findEpisodeIdsForMessages(
  agentId: number,
  userId: string,
  messageIds: number[],
): string[] {
  const wanted = new Set(
    messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
  );
  if (!wanted.size) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, message_ids_json FROM hippocampus_episodes
       WHERE agent_id = ? AND user_id = ?`,
    )
    .all(agentId, userId) as { id: string; message_ids_json: string | null }[];
  const ids: string[] = [];
  for (const row of rows) {
    let messageIdsInEpisode: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row.message_ids_json || "[]"));
      if (Array.isArray(parsed)) messageIdsInEpisode = parsed;
    } catch {
      messageIdsInEpisode = [];
    }
    if (messageIdsInEpisode.some((id) => wanted.has(Number(id)))) {
      ids.push(String(row.id));
    }
  }
  return ids;
}

/**
 * Soft-delete every fact whose provenance points at a deleted episode. Rows
 * stay in the table (and fact_sources stays intact) for audit; recall filters
 * `expired_at IS NULL`, so they disappear from current reads immediately.
 */
export function softDeleteFactsForEpisodes(
  agentId: number,
  userId: string,
  episodeIds: string[],
  at: string = nowIso(),
): number {
  const ids = [...new Set(episodeIds.map(String).filter(Boolean))];
  if (!ids.length) return 0;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT f.id, f.valid_at, f.created_at, f.invalid_at
       FROM hippocampus_facts f
       JOIN hippocampus_fact_sources fs ON fs.fact_id = f.id
       WHERE f.agent_id = ? AND f.user_id = ? AND fs.episode_id IN (${placeholders})`,
    )
    .all(agentId, userId, ...ids) as {
    id: string;
    valid_at: string | null;
    created_at: string;
    invalid_at: string | null;
  }[];
  if (!rows.length) return 0;
  const update = db.prepare(
    `UPDATE hippocampus_facts
     SET status = 'expired', expired_at = COALESCE(expired_at, ?),
         invalid_at = ?, invalidation_reason = COALESCE(invalidation_reason, 'source_deleted'),
         updated_at = ?
     WHERE id = ? AND agent_id = ? AND user_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      const start = String(row.valid_at || row.created_at || "");
      // invalid_at must be strictly later than the fact's start; a future
      // valid_at (a scheduled statement) would otherwise be born invalid.
      let invalidAt = String(row.invalid_at || "");
      if (!invalidAt || (start && invalidAt <= start)) {
        const startMs = Date.parse(start);
        const atMs = Date.parse(at);
        invalidAt =
          Number.isFinite(startMs) && Number.isFinite(atMs) && startMs >= atMs
            ? new Date(startMs + 1_000).toISOString()
            : at;
      }
      update.run(at, invalidAt, at, row.id, agentId, userId);
    }
  });
  tx();
  return rows.length;
}

// ─── Digest jobs ────────────────────────────────────────────────────────────

export interface DigestJobInput {
  scope: MemoryScope;
  fromMessageId: number;
  toMessageId: number;
  contentHash: string;
  extractorVersion: string;
  promptVersion: string;
}

/**
 * Idempotent job ledger row. A retry of the same range+content reuses the row
 * and increments `attempts`; job bookkeeping must never break the digest, so
 * failures here are swallowed.
 */
export function beginDigestJob(input: DigestJobInput): { id: string; attempts: number } | null {
  try {
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, attempts FROM hippocampus_digest_jobs
         WHERE agent_id = ? AND user_id = ? AND from_message_id = ? AND to_message_id = ?
           AND content_hash = ?
         LIMIT 1`,
      )
      .get(
        input.scope.agentId,
        input.scope.userId,
        input.fromMessageId,
        input.toMessageId,
        input.contentHash,
      ) as { id: string; attempts: number } | undefined;
    const now = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE hippocampus_digest_jobs
         SET status = 'running', attempts = attempts + 1, last_error = NULL,
             extractor_version = ?, prompt_version = ?,
             started_at = ?, finished_at = NULL
         WHERE id = ?`,
      ).run(input.extractorVersion, input.promptVersion, now, existing.id);
      return { id: existing.id, attempts: Number(existing.attempts) + 1 };
    }
    const id = `digest-job-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    db.prepare(
      `INSERT INTO hippocampus_digest_jobs
        (id, agent_id, user_id, from_message_id, to_message_id, status, attempts,
         content_hash, extractor_version, prompt_version, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.scope.agentId,
      input.scope.userId,
      input.fromMessageId,
      input.toMessageId,
      input.contentHash,
      input.extractorVersion,
      input.promptVersion,
      now,
      now,
    );
    return { id, attempts: 1 };
  } catch {
    return null;
  }
}

export function finishDigestJob(
  jobId: string | null,
  status: "done" | "failed" | "stale",
  error?: unknown,
): void {
  if (!jobId) return;
  try {
    getDb()
      .prepare(
        `UPDATE hippocampus_digest_jobs
         SET status = ?, finished_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(
        status,
        nowIso(),
        status === "failed"
          ? (error instanceof Error ? error.message : String(error ?? "")).slice(0, 1000)
          : null,
        jobId,
      );
  } catch {
    // job bookkeeping is best-effort; the digest result is authoritative
  }
}

// ─── Facts ──────────────────────────────────────────────────────────────────

export interface WriteFactInput {
  scope: MemoryScope;
  fromEntityId: string;
  toEntityId: string | null;
  relation: string;
  description: string;
  confidence: number;
  importance?: number;
  isIdentity?: boolean;
  evidence?: string;
  evidenceRef?: Record<string, unknown> | null;
  episodeId?: string | null;
  streamId?: string | null;
  validAt?: string | null;
  invalidAt?: string | null;
  extractorVersion?: string | null;
  promptVersion?: string | null;
  /** Legacy SINGLE_VALUE_RELATIONS result, used only when the registry misses. */
  fallbackSingleValue: boolean;
}

export interface WriteFactResult {
  factId: string;
  created: boolean;
  merged: boolean;
  supersededFactIds: string[];
}

function appendFactSource(input: {
  factId: string;
  episodeId: string | null;
  streamId: string | null;
  evidence: string | null;
}) {
  if (!input.episodeId) return;
  getDb()
    .prepare(
      `INSERT INTO hippocampus_fact_sources
        (fact_id, episode_id, stream_id, evidence_quote, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(fact_id, episode_id) DO UPDATE SET
         stream_id = COALESCE(excluded.stream_id, hippocampus_fact_sources.stream_id),
         evidence_quote = COALESCE(excluded.evidence_quote, hippocampus_fact_sources.evidence_quote)`,
    )
    .run(
      input.factId,
      input.episodeId,
      input.streamId ?? null,
      input.evidence ?? null,
      nowIso(),
    );
}

/**
 * Write one fact under the v23 semantics in a single transaction.
 *
 * Order matters:
 *  1. exact duplicate (same subject + relation + object, still current) →
 *     append source only;
 *  2. cardinality=one → soft-invalidate the current row only when the new
 *     real-world time is strictly later than the old one. A newer fact may
 *     supersede an older one; an out-of-order older fact must never produce a
 *     "current" row whose invalid_at <= valid_at (it would be invisible
 *     forever). In that case it becomes an expired historical row linked to
 *     the surviving current fact, and the evidence is still preserved;
 *  3. insert the new current row + fact_source.
 */
export function writeFact(input: WriteFactInput): WriteFactResult {
  const db = getDb();
  const relation = String(input.relation || "").trim().toUpperCase();
  const cardinality = resolveFactCardinality(relation, input.fallbackSingleValue);
  const now = nowIso();
  const validAt = String(input.validAt || now);
  // Never persist invalid_at <= valid_at; an explicit past invalid_at means
  // the fact is born expired instead of being a permanently invisible
  // "current" row.
  const requestedInvalidAt = input.invalidAt ? String(input.invalidAt) : null;
  const invalidAt =
    requestedInvalidAt && requestedInvalidAt > validAt ? requestedInvalidAt : null;
  const bornExpired = Boolean(invalidAt && invalidAt <= now);
  // Compute once; every insert path (current, born-expired, out-of-order
  // history row) persists the same pre-tokenized text.
  const descriptionTokens = factDescriptionTokens(input.description);

  const tx = db.transaction((): WriteFactResult => {
    const duplicate = db
      .prepare(
        `SELECT id, confidence, description FROM hippocampus_facts
         WHERE agent_id = ? AND user_id = ? AND from_entity_id = ? AND relation = ?
           AND to_entity_id IS ? AND expired_at IS NULL
         ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC
         LIMIT 1`,
      )
      .get(
        input.scope.agentId,
        input.scope.userId,
        input.fromEntityId,
        relation,
        input.toEntityId,
      ) as { id: string; confidence: number; description: string | null } | undefined;
    if (duplicate) {
      // A repeated statement may carry a newer wording. Keep the row (and its
      // source history) but refresh description + pre-tokenized text together.
      // The trigger mirrors the new tokens into FTS exactly once.
      const incomingDescription = String(input.description || "").trim();
      const nextDescription = incomingDescription || String(duplicate.description || "");
      const nextTokens = factDescriptionTokens(nextDescription);
      db.prepare(
        `UPDATE hippocampus_facts
         SET confidence = MAX(confidence, ?),
             description = CASE WHEN ? <> '' THEN ? ELSE description END,
             description_tokens = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(
        Number(input.confidence) || 0,
        incomingDescription,
        nextDescription,
        nextTokens,
        now,
        duplicate.id,
      );
      appendFactSource({
        factId: duplicate.id,
        episodeId: input.episodeId ?? null,
        streamId: input.streamId ?? null,
        evidence: input.evidence ?? null,
      });
      return { factId: duplicate.id, created: false, merged: true, supersededFactIds: [] };
    }

    const insertFact = (
      id: string,
      status: "current" | "expired",
      expiredAt: string | null,
      invalidationReason: string | null,
      supersededBy: string | null,
      rowValidAt: string,
      rowInvalidAt: string | null,
    ) => {
      db.prepare(
        `INSERT INTO hippocampus_facts
          (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
           description_tokens, confidence, importance, is_identity, status, evidence_json,
           valid_at, invalid_at, created_at, updated_at, expired_at, superseded_by_fact_id,
           invalidation_reason, source_episode_id, cardinality, extractor_version, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.scope.agentId,
        input.scope.userId,
        input.fromEntityId,
        input.toEntityId,
        relation,
        input.description,
        descriptionTokens,
        Number(input.confidence) || 0,
        Number(input.importance ?? 0.5),
        input.isIdentity ? 1 : 0,
        status,
        input.evidenceRef ? JSON.stringify(input.evidenceRef) : null,
        rowValidAt,
        rowInvalidAt,
        now,
        now,
        expiredAt,
        supersededBy,
        invalidationReason,
        input.episodeId ?? null,
        cardinality,
        input.extractorVersion ?? null,
        input.promptVersion ?? null,
      );
    };

    const supersededFactIds: string[] = [];
    if (!bornExpired) {
      const current = db
        .prepare(
          `SELECT id, valid_at, created_at FROM hippocampus_facts
           WHERE agent_id = ? AND user_id = ? AND from_entity_id = ? AND relation = ?
             AND expired_at IS NULL
           ORDER BY COALESCE(valid_at, created_at) DESC, rowid DESC`,
        )
        .all(input.scope.agentId, input.scope.userId, input.fromEntityId, relation) as {
        id: string;
        valid_at: string | null;
        created_at: string;
      }[];
      if (cardinality === "one" && current.length) {
        const old = current[0];
        const oldValidAt = String(old.valid_at || old.created_at || "");
        if (validAt > oldValidAt) {
          db.prepare(
            `UPDATE hippocampus_facts
             SET invalid_at = ?, expired_at = ?,
                 invalidation_reason = 'contradicted', status = 'expired', updated_at = ?
             WHERE id = ?`,
          ).run(validAt, now, now, old.id);
          // The old row is no longer recallable; drop its vector so semantic
          // search cannot resurrect it behind the time predicate.
          try {
            db.prepare("DELETE FROM fact_vec WHERE fact_id = ?").run(old.id);
          } catch {
            // vec0 is optional
          }
          supersededFactIds.push(old.id);
        } else if (validAt < oldValidAt) {
          // Out-of-order digest: the statement is older than the surviving
          // current fact. Keep it as a closed historical row. invalid_at is
          // strictly after valid_at because oldValidAt > validAt.
          const historyId = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          insertFact(
            historyId,
            "expired",
            now,
            "out_of_order",
            old.id,
            validAt,
            oldValidAt,
          );
          appendFactSource({
            factId: historyId,
            episodeId: input.episodeId ?? null,
            streamId: input.streamId ?? null,
            evidence: input.evidence ?? null,
          });
          return {
            factId: historyId,
            created: false,
            merged: true,
            supersededFactIds: [],
          };
        } else {
          // Same real-world instant: a duplicate statement. Append the source
          // to the surviving fact instead of creating a zero-length row.
          appendFactSource({
            factId: old.id,
            episodeId: input.episodeId ?? null,
            streamId: input.streamId ?? null,
            evidence: input.evidence ?? null,
          });
          db.prepare("UPDATE hippocampus_facts SET updated_at = ? WHERE id = ?").run(
            now,
            old.id,
          );
          return { factId: old.id, created: false, merged: true, supersededFactIds: [] };
        }
      }
    }

    const factId = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    for (const oldId of supersededFactIds) {
      db.prepare("UPDATE hippocampus_facts SET superseded_by_fact_id = ? WHERE id = ?").run(
        factId,
        oldId,
      );
    }
    insertFact(
      factId,
      bornExpired ? "expired" : "current",
      bornExpired ? now : null,
      bornExpired ? "invalid_at_past" : null,
      null,
      validAt,
      invalidAt,
    );
    appendFactSource({
      factId,
      episodeId: input.episodeId ?? null,
      streamId: input.streamId ?? null,
      evidence: input.evidence ?? null,
    });
    return {
      factId,
      created: !bornExpired,
      merged: false,
      supersededFactIds,
    };
  });
  return tx();
}
