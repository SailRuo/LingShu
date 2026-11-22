import { createHash, randomUUID } from "node:crypto";
import { Solar } from "lunar-javascript";
import { getDb } from "../db/sqlite.js";
import { normalizeUserId } from "./chatThreadService.js";
import { userMessageForLlm } from "./chatMessageService.js";
import {
  bufferToVector,
  cosineSimilarity,
  deleteScopeVecRows,
  embedQueryText,
  embedQueryTextsCached,
  embedText,
  EmbeddingUnavailableError,
  makeQueryCacheSessionKey,
  searchStreamCandidates,
  storeFactEmbedding,
  storeSeedEmbeddings,
  storeStreamEmbedding,
  vectorToBuffer,
} from "./embeddingService.js";
import { bm25Scores, tokenize } from "./memoryTextRank.js";
import {
  DIGEST_CONSTANTS,
  DIGEST_PROMPTS,
  DIGEST_RESPONSE_SCHEMAS,
  DIGEST_SETS,
  DIGEST_TEMPLATES,
} from "../contracts/native/index.js";
import {
  MEMORY_SEARCH as CHAT_MEMORY_SEARCH,
  NEAR_WINDOW as CHAT_NEAR_WINDOW,
  STREAM as CHAT_STREAM,
} from "../contracts/native/nativeChatContract.js";
import {
  recordBackgroundTaskEvent,
} from "./backgroundTaskEvents.js";
import {
  beginMemoryTask,
  invalidateMemoryTasks,
  isMemoryTaskValid,
  runIfMemoryTaskValid,
  type MemoryTaskToken,
} from "./memoryTaskToken.js";
import {
  buildDigestTranscript,
  estimateDigestTokens,
  flattenTranscriptContent,
  planDigestChunks,
  type DigestChunk,
  type DigestMessageRow,
  type DigestTranscriptRow,
} from "./digestBatch.js";
import {
  classifyRecallAudit,
  listRecallEvents,
  publishRecallEvent,
  recallSessionKey,
  subscribeRecallEvents,
} from "./recallReport.js";
import { createOpenAIClient, getLLMConfig } from "./llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "./thinkingEffort.js";
import { recordCompletionUsage } from "./usageService.js";
import {
  logTick,
  memoryScope,
  nowIso,
  parseJson,
  subscribeTickLog,
  type MemoryScope,
} from "./memoryScope.js";
import {
  applyTextAffect,
  deriveSelfState,
  getBaselineItem,
  persistSelfStateSnapshot,
  readAffectTimeline,
} from "./baselineService.js";
import { activateSeedsForText, type SeedActivationResult } from "./seedActivationService.js";
import {
  applySeedChange,
  insertSeedLedgerEntry,
  isSeedAutoMutable,
  listSeedChanges,
  parseSeedApplicability,
  seedApplicabilityJson,
  seedReviewBatchKey,
  seedSnapshot,
} from "./seedLedgerService.js";
import {
  applyRelationshipContinuity,
  listRelationshipThreadCandidates,
  type RelationshipContinuityItem,
  type RelationshipThreadCandidate,
} from "./relationshipThreadService.js";
import {
  getMirror as witnessGetMirror,
  getRetrospect as witnessGetRetrospect,
  listRetrospectBuckets as witnessListRetrospectBuckets,
  recomputeRetrospect as witnessRecomputeRetrospect,
  scheduleWitnessAfterDigest,
} from "./witnessService.js";
import {
  dayKey,
  wallTimeToUtc,
  zonedParts,
  type CalendarGranularity,
  type ZonedParts,
} from "./memoryTime.js";
import {
  beginDigestJob,
  ensureEpisode,
  ensureProactiveEpisode,
  entityKindForRelation,
  finishDigestJob,
  writeFact,
  type EntityKind,
  type EpisodeRecord,
} from "./memoryFactStore.js";
import {
  countFactFtsRowsForScope,
  countPendingFactFtsForScope,
  deleteFactFtsForScope,
  factFtsReady,
  searchFactFts,
} from "./memoryFactFts.js";

/** Digest schema/prompt version stamped on facts and jobs. Keep in one place. */
export const DIGEST_EXTRACTOR_VERSION = "v23";
export const DIGEST_PROMPT_VERSION = "graphiti-v1";

/**
 * Desktop-only overlay on top of the APP-generated extractor contract.
 * `nativeDigestSource.generated.ts` is a verbatim mirror of the APP contract
 * and must not be edited. We deep-clone it at runtime and add the two optional
 * double-time fields; they stay out of `required`, so older/APP outputs remain
 * valid and prompt-cache prefixes for existing calls are unaffected.
 */
export const EXTRACTOR_SCHEMA_WITH_TIME: Record<string, any> = (() => {
  const schema = JSON.parse(
    JSON.stringify(DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.schema),
  ) as Record<string, any>;
  const factProperties = schema?.properties?.facts?.items?.properties;
  if (factProperties) {
    factProperties.valid_at = { type: "string" };
    factProperties.invalid_at = { type: "string" };
  }
  return schema;
})();

/**
 * Appended to the end of the human prompt (never the system prefix): digest
 * calls are standalone per-chunk requests, and the static rules must stay at
 * the front so consecutive requests keep a byte-identical prefix.
 */
const FACT_TIME_PROMPT_RULE =
  "\n\n事实时间字段（可选，仅 facts 使用）：\n" +
  "- valid_at：这件事在现实世界开始为真的时间；invalid_at：停止为真的时间。\n" +
  "- 只接受 ISO 8601 或 YYYY-MM-DD；相对时间（昨天/去年/下个月）按上面的对话时间基准换算成绝对日期。\n" +
  "- 没有明确时间就省略，不要猜。";

export { memoryScope, logTick, subscribeTickLog };
export { listRecallEvents, subscribeRecallEvents };
export type { MemoryScope };

function freshness(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, Math.min(1, 1 - 0.02 * days));
}

function proactivePenalty(lastProactiveAt: string | null | undefined): number {
  if (!lastProactiveAt) return 1;
  const hours = (Date.now() - new Date(lastProactiveAt).getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return 1;
  if (hours < 24) return 0;
  if (hours < 168) return 0.3;
  return 1;
}

export function streamToItem(row: any) {
  const revisitCount = Number(row.revisit_count ?? 0);
  const salience = Math.log1p(revisitCount) * freshness(row.revisit_last_at || row.created_at);
  const significance = Number(row.significance ?? 0.5);
  return {
    id: row.id,
    narrative: row.narrative || "",
    about: row.about || "",
    type: row.type || "external",
    // Group-public provenance rides with the recall item so callers can keep
    // public group experiences in their own prompt pool instead of presenting
    // them as private-chat memories.
    originScope: row.origin_scope ?? null,
    originGroupSessionId: row.origin_group_session_id ?? null,
    perspective: row.perspective ?? null,
    participantsJson: row.participants_json ?? null,
    rawStart: row.raw_start ?? null,
    rawEnd: row.raw_end ?? null,
    revisitCount,
    revisitLastAt: row.revisit_last_at ?? null,
    lastProactiveAt: row.last_proactive_at ?? null,
    salience: Number(salience.toFixed(4)),
    significance,
    proactiveWeight: Number(
      (freshness(row.created_at) * significance * proactivePenalty(row.last_proactive_at)).toFixed(4),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function seedRealCount(row: any): number {
  // Real stored corroboration count (maintained on create/reinforce/merge/revise).
  // No version-table proxy: legacy rows are backfilled by the schema v15 migration.
  const direct = Number(row?.count);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 1;
}

export function seedToItem(row: any) {
  const updatedAt = row.updated_at || row.created_at;
  const lastSeen = row.last_seen || updatedAt;
  const count = seedRealCount(row);
  const fresh = freshness(lastSeen);
  return {
    id: row.id,
    subject: row.subject || "about_self",
    content: row.inner_orientation || "",
    tags: parseJson<string[]>(row.tags_json, []),
    innerOrientation: row.inner_orientation || "",
    outerExpression: row.outer_expression || "",
    wakeText: row.wake_text || "",
    boostText: row.boost_text || "",
    suppressText: row.suppress_text || "",
    count,
    lastSeen,
    source: row.source || "learned",
    status: row.status || "active",
    revision: Number(row.revision || 0),
    applicability: parseSeedApplicability(row.applicability_json),
    freshness: Number(fresh.toFixed(4)),
    // Python seed salience: real count × last_seen freshness (no log proxy).
    salience: Number((count * fresh).toFixed(4)),
    createdAt: row.created_at,
    updatedAt,
  };
}

function versionToItem(row: any) {
  const before = parseJson<Record<string, any> | null>(row.before_json, null);
  const after = parseJson<Record<string, any> | null>(row.after_json, null);
  const diffs: { field: string; before: unknown; after: unknown }[] = [];
  if (before && after) {
    for (const field of [
      "innerOrientation",
      "outerExpression",
      "wakeText",
      "boostText",
      "suppressText",
      "tags",
    ]) {
      const left = JSON.stringify(before[field] ?? null);
      const right = JSON.stringify(after[field] ?? null);
      if (left !== right) diffs.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }
  return {
    id: row.id,
    seedId: row.seed_id,
    versionNo: row.version_no,
    eventType: row.event_type,
    triggerSource: row.trigger_source,
    reason: row.reason,
    sessionId: row.session_id,
    turnIds: parseJson<number[]>(row.turn_ids_json, []),
    before,
    after,
    field: row.field,
    affectNote: row.affect_note,
    recallAudit: parseJson<Record<string, unknown> | null>(row.recall_audit_json, null),
    createdAt: row.created_at,
    diffs,
  };
}

function tickToItem(row: any) {
  return {
    id: row.id,
    tickType: row.tick_type,
    outcome: row.outcome,
    triggeredAt: row.triggered_at,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    error: row.error ?? null,
  };
}

interface DigestTurn {
  threadId: number;
  assistantId: number;
  userMessageId: number | null;
  userText: string;
  assistantText: string;
  userCreatedAt: string;
  assistantCreatedAt: string;
}

/**
 * Legacy thread-shaped target kept for the `buildThreadDigestTarget` helper and
 * external callers. The M1 digest pipeline reads an agent+user batch instead.
 */
export interface ThreadDigestTarget {
  threadId: number;
  agentId: number;
  userId: string;
  turns: DigestTurn[];
  turnIds: number[];
  transcript: string;
  contextTranscript: string;
}

interface ExtractedStream {
  narrative: string;
  about: string;
  type: "external" | "internal";
  significance: number;
  rawStart: number | null;
  rawEnd: number | null;
}

interface ExtractedConstraint {
  action: "new" | "update" | "remove";
  targetId: number | null;
  ruleType: "do" | "dont";
  description: string;
  evidence: string;
}

interface ExtractedFact {
  subject: "Me" | "Self";
  relation: string;
  object: string;
  description: string;
  evidence: string;
  confidence: number;
  importance: number;
  isIdentity: boolean;
  /**
   * Real-world validity window (desktop-only overlay fields; the APP-generated
   * nativeDigestSource contract does not expose them). `validAt` prefers the
   * extractor, then the evidence message's created_at, then episode.endedAt.
   */
  validAt?: string | null;
  invalidAt?: string | null;
}

interface ExtractedCorrection {
  targetType: "fact";
  targetHint: string;
}

interface ExtractedContinuity {
  title: string;
  note: string;
  carriesIndex: number;
  carryNote: string;
  nodes: {
    index: number;
    messageId: number;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }[];
}

interface DigestExtraction {
  shouldWrite: boolean;
  streams: ExtractedStream[];
  constraints: ExtractedConstraint[];
  facts: ExtractedFact[];
  corrections: ExtractedCorrection[];
  continuity: ExtractedContinuity[];
}

export type DigestComplete = (
  system: string | string[],
  human: string,
  schema?: Record<string, unknown>,
) => Promise<any>;

export interface AgentDigestOptions {
  source?: string;
  /** Import path may override the 3-day lookback. */
  since?: string | null;
  maxPairs?: number;
  maxRows?: number;
  maxChunks?: number;
  maxInputTokens?: number;
  forceStreamFallback?: boolean;
  complete?: DigestComplete;
  /**
   * Entity-resolution completion hook (tests/offline). Kept separate from
   * `complete` because the extractor mock returns extraction JSON, not
   * resolution decisions. When only `complete` is injected, ambiguity
   * resolution is skipped and the deterministic entity path is used.
   */
  entityComplete?: DigestComplete;
  /** Independent affect-sidecar completion hook (tests/offline). */
  affectComplete?: DigestComplete;
  embed?: (text: string) => Promise<number[]>;
  /** Deterministic test hook: runs after extraction, before any write. */
  afterExtract?: () => void | Promise<void>;
  /** Deterministic test hook: runs inside the write transaction before writes. */
  beforeCommit?: () => void | Promise<void>;
  /** Internal: reuse a token created by an outer run. */
  taskToken?: MemoryTaskToken;
}

export interface AgentDigestRunResult {
  sessionId?: number;
  agentId: number;
  userId: string;
  turnIds: number[];
  turnCount: number;
  markedDigested: number;
  streamsWritten: number;
  streamsSource: string;
  factsProcessed: number;
  constraintsProcessed: number;
  continuityApplied: number;
  threadsCreated: number;
  threadsUpdated: number;
  touchpointsWritten: number;
  selfEvolutionEnabled: boolean;
  personalitySeedAction: string;
  personalitySeedId: string | null;
  personalitySeedReason: string;
  seedsCreated: number;
  seedsReinforced: number;
  seedsSkipped: number;
  batchesRun: number;
  hasMore: boolean;
}

export type DigestRunResult = AgentDigestRunResult;

export type AgentDigestResult = AgentDigestRunResult | { skipped: string; sessionId?: number };

const ALLOWED_ABOUT = new Set([
  ...(DIGEST_SETS.EXTERNAL_ABOUT as readonly string[]),
  ...(DIGEST_SETS.SELF_ABOUT as readonly string[]),
]);

const SELF_ABOUT = new Set(DIGEST_SETS.SELF_ABOUT as readonly string[]);

/**
 * Python `digest_streams._LEGACY_ABOUT_MAP`: old english/legacy buckets still
 * exist in historical LLM output and imported data, so normalize them before
 * validating against the closed set.
 */
const LEGACY_ABOUT_MAP: Record<string, string> = {
  "user.work": "他·工作",
  "user.health": "他·健康",
  "user.family": "他·家人",
  "user.hobby": "他·爱好",
  "user.emotion": "他·情绪",
  "user.daily": "他·日常",
  "user.general": "他·其它",
  "us.trust": "咱俩·信任",
  "us.routine": "咱俩·相处",
  "us.conflict": "咱俩·摩擦",
  "us.general": "咱俩·其它",
  general: "其它",
  "self.feeling": "她·感受",
  "self.value": "她·在乎",
  "self.reaction": "她·反应",
  "self.boundary": "她·边界",
};

const SINGLE_VALUE_RELATIONS = new Set([
  "HAS_NAME",
  "AGE",
  "GENDER",
  "LIVES_IN",
  "OCCUPATION",
  "SLEEP_PATTERN",
  "HAS_WORK_PATTERN",
]);

const MULTI_VALUE_RELATIONS = new Set([
  "LIKES",
  "DISLIKES",
  "HAS_PET",
  "HAS_FRIEND",
  "HAS_FAMILY",
  "INTERESTED_IN",
  "HAS_HEALTH_CONDITION",
  "HAS_BODY_REACTION",
  "HAS_ROUTINE",
]);

const RELATION_SYNONYMS: Record<string, string> = {
  NAME: "HAS_NAME",
  FULL_NAME: "HAS_NAME",
  CALLED: "HAS_NAME",
  CALL_ME: "HAS_NAME",
  NICKNAME: "HAS_NAME",
  CHANGED_NAME_TO: "HAS_NAME",
  RENAMED_TO: "HAS_NAME",
  NEW_NAME: "HAS_NAME",
  NOW_CALLED: "HAS_NAME",
  LIVES: "LIVES_IN",
  LIVE_IN: "LIVES_IN",
  LOCATED_IN: "LIVES_IN",
  RESIDES_IN: "LIVES_IN",
  WORKS_AS: "OCCUPATION",
  JOB: "OCCUPATION",
  JOB_TITLE: "OCCUPATION",
  PROFESSION: "OCCUPATION",
  LIKE: "LIKES",
  LOVES: "LIKES",
  ENJOYS: "LIKES",
  FAVORITE: "LIKES",
  DISLIKE: "DISLIKES",
  HATES: "DISLIKES",
  PET: "HAS_PET",
  HAS_A_PET: "HAS_PET",
  FRIEND: "HAS_FRIEND",
  HAS_A_FRIEND: "HAS_FRIEND",
  FAMILY: "HAS_FAMILY",
  RELATIVE: "HAS_FAMILY",
  SLEEP: "SLEEP_PATTERN",
  SLEEP_HABIT: "SLEEP_PATTERN",
  BEDTIME: "SLEEP_PATTERN",
  HEALTH: "HAS_HEALTH_CONDITION",
  CONDITION: "HAS_HEALTH_CONDITION",
  ILLNESS: "HAS_HEALTH_CONDITION",
  CHRONIC: "HAS_HEALTH_CONDITION",
  BODY_REACTION: "HAS_BODY_REACTION",
  STRESS_REACTION: "HAS_BODY_REACTION",
  ROUTINE: "HAS_ROUTINE",
  HABIT: "HAS_ROUTINE",
  WORK_PATTERN: "HAS_WORK_PATTERN",
  WORK_SCHEDULE: "HAS_WORK_PATTERN",
};

const RELATION_DROP = new Set([
  "PREVIOUS_NAME",
  "FORMER_NAME",
  "OLD_NAME",
  "USED_TO_BE_CALLED",
  "EX_NAME",
]);

const EPISODIC_RELATION_TOKENS = [
  "TRIP",
  "TRAVEL",
  "PLAN",
  "UPCOMING",
  "GO_TO",
  "GOES_TO",
  "VISIT",
  "MEET",
  "ATTEND",
  "WILL_",
  "SCHEDULE",
  "APPOINTMENT",
  "TRACK",
  "EVENT",
];

const ROLE_GENERIC_NAMES = new Set([
  "助手",
  "智能体",
  "ai",
  "assistant",
  "agent",
  "用户",
  "user",
  "客服",
  "机器人",
  "bot",
  "模型",
  "系统",
]);

const DEICTIC_NAME_OBJECTS = new Set([
  "这个名字",
  "那个名字",
  "这名",
  "那名",
  "这个",
  "那个",
  "代号",
  "名字",
  "昵称",
  "这个名",
  "那个名",
]);

function canonicalizeRelation(relation: string): string | null {
  const value = String(relation || "").trim().toUpperCase();
  if (!value) return null;
  if (RELATION_DROP.has(value)) return null;
  if (EPISODIC_RELATION_TOKENS.some((token) => value.includes(token))) return null;
  const canonical = RELATION_SYNONYMS[value] || value;
  if (SINGLE_VALUE_RELATIONS.has(canonical) || MULTI_VALUE_RELATIONS.has(canonical)) return canonical;
  return null;
}

function isRoleGenericName(value: string): boolean {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (ROLE_GENERIC_NAMES.has(text)) return true;
  return [...ROLE_GENERIC_NAMES].some((token) => text === token);
}

function isDeicticNameObject(value: string): boolean {
  const text = String(value || "").trim().replace(/^[「」"'“”]+|[「」"'“”]+$/g, "");
  if (!text) return true;
  if (DEICTIC_NAME_OBJECTS.has(text)) return true;
  return [...DEICTIC_NAME_OBJECTS].some(
    (token) => text.toLowerCase().includes(token) && text.length <= token.length + 4,
  );
}

/**
 * Python `facts.coerce_name_fact`: HAS_NAME only accepts a real name/nickname.
 * Role-generic names ("助手", "AI") become OCCUPATION; deictic names are dropped.
 */
function coerceNameFact(fact: ExtractedFact): ExtractedFact | null {
  const relation = canonicalizeRelation(fact.relation);
  if (!relation) return null;
  let object = String(fact.object || "").trim();
  if (!object) return null;
  if (relation === "HAS_NAME") {
    if (isDeicticNameObject(object)) return null;
    if (isRoleGenericName(object)) {
      return {
        ...fact,
        relation: "OCCUPATION",
        object,
        isIdentity: false,
        importance: fact.importance >= 1 ? 0.7 : fact.importance,
      };
    }
  }
  return { ...fact, relation, object };
}

function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeStreamAbout(about: string, type: string): string {
  const raw = String(about || "").trim();
  const value = LEGACY_ABOUT_MAP[raw] || raw;
  if (String(type || "").toLowerCase() === "internal") {
    return SELF_ABOUT.has(value) ? value : "她·感受";
  }
  if (ALLOWED_ABOUT.has(value)) return value;
  if (value.startsWith("咱俩")) return "咱俩·其它";
  return "他·其它";
}

function normalizeStreamNarrative(narrative: string): string {
  return String(narrative || "")
    .replace(/我\s*[（(]\s*(?:AI|ai|智能体|助手|Self)\s*[）)]/g, "我")
    .replace(/(?:AI|ai|智能体|助手|Self)\s*(?:向|对|跟)\s*用户/g, "我向ta")
    .replace(/用户\s*(?:向|对|跟)\s*(?:AI|ai|智能体|助手|Self)/g, "ta向我")
    .replace(/(?:AI|ai|智能体|助手|Self)/g, "我")
    .replace(/用户/g, "ta")
    .trim();
}

function guessStreamAbout(text: string): string {
  if (/(工作|面试|加班|同事|老板)/.test(text)) return "他·工作";
  if (/(生病|身体|熬夜|医院|睡眠)/.test(text)) return "他·健康";
  if (/(爸|妈|家里|家人|孩子)/.test(text)) return "他·家人";
  if (/(咱俩|我们|我们俩)/.test(text)) return "咱俩·其它";
  return "他·其它";
}

function parseJsonBlock(raw: string): any {
  let text = String(raw || "").trim();
  if (text.startsWith("```json")) text = text.slice(7).trim();
  else if (text.startsWith("```")) text = text.slice(3).trim();
  if (text.endsWith("```")) text = text.slice(0, -3).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("invalid_digest_json");
  }
}

function userSideUtterances(transcript: string, userLabel = "ta"): string[] {
  const out: string[] = [];
  const label = String(userLabel || "ta").trim() || "ta";
  for (const rawLine of String(transcript || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const numbered = /^\[(\d+)\]\s*(.*)$/.exec(line);
    const body = numbered ? numbered[2] : line;
    if (body.startsWith(`${label}：`) || body.startsWith(`${label}:`)) {
      out.push(body.slice(label.length + 1).trim());
    }
  }
  return out.filter(Boolean);
}

function evidenceInUserSide(evidence: string, transcript: string, userLabel = "ta"): boolean {
  const quote = String(evidence || "").trim().replace(/^[“”"'「」]+|[“”"'「」]+$/g, "");
  if (!quote) return false;
  return userSideUtterances(transcript, userLabel).some((utterance) => utterance.includes(quote));
}

function readKnownFactsText(scope: MemoryScope): string {
  const rows = getDb()
    .prepare(
      `SELECT f.relation, f.description, f.importance, src.name AS source_name, dst.name AS target_name
       FROM hippocampus_facts f
       LEFT JOIN hippocampus_entities src ON src.id = f.from_entity_id
       LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id
       WHERE f.agent_id = ? AND f.user_id = ? AND f.status = 'current'
       ORDER BY f.importance DESC, f.created_at DESC LIMIT 40`,
    )
    .all(scope.agentId, scope.userId) as any[];
  return rows
    .map(
      (row) =>
        `- ${row.source_name || "他"} ${row.relation || "相关"} ${row.target_name || ""}${row.description ? `：${row.description}` : ""}`,
    )
    .join("\n");
}

function readConstraintCandidates(scope: MemoryScope) {
  return getDb()
    .prepare(
      `SELECT id, rule_type, description FROM hippocampus_constraints
       WHERE agent_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 8`,
    )
    .all(scope.agentId, scope.userId) as { id: number; rule_type: string; description: string }[];
}

function parseStoredEmbedding(raw: unknown): number[] {
  if (!raw) return [];
  if (Buffer.isBuffer(raw)) return bufferToVector(raw);
  if (raw instanceof Uint8Array) return bufferToVector(Buffer.from(raw));
  if (Array.isArray(raw)) return raw.map(Number).filter((value) => Number.isFinite(value));
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed)
        ? parsed.map(Number).filter((value) => Number.isFinite(value))
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function contextTranscriptBefore(threadId: number, beforeId: number, maxTurns = 5): string {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE thread_id = ? AND id < ? AND role IN ('user','assistant') AND status = 'completed'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(threadId, beforeId, maxTurns * 2) as any[];
  const ordered = rows.reverse();
  const assistantById = new Map<number, any>();
  for (const row of ordered) if (row.role === "assistant") assistantById.set(row.id, row);
  const lines: string[] = [];
  for (const row of ordered) {
    if (row.role !== "assistant") continue;
    const user = row.reply_to_message_id
      ? ordered.find((item) => item.id === row.reply_to_message_id && item.role === "user")
      : null;
    if (user) lines.push(`ta：${userMessageForLlm(user.content, parseJson(user.user_images_json, []))}`);
    if (row.content) lines.push(`我：${String(row.content).trim()}`);
  }
  return lines.join("\n\n");
}

function digestTranscriptLimit(): number {
  // Python feeds the whole working-memory transcript. 0 / negative means no
  // truncation; an explicit env override can still cap it for very long chats.
  const raw = Number(process.env.LINGSHU_DIGEST_MAX_TRANSCRIPT_CHARS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function limitDigestText(text: string): string {
  const limit = digestTranscriptLimit();
  return limit > 0 ? String(text || "").slice(0, limit) : String(text || "");
}

export function buildThreadDigestTarget(
  threadId: number,
  maxPairs = 10,
  since?: string | null,
): ThreadDigestTarget | null {
  const db = getDb();
  const thread = db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(threadId) as any;
  if (!thread) return null;
  const limit = Math.max(1, Math.min(maxPairs, 200));
  // Digest scope is the whole agent+user pair, not one thread. Imported or
  // historical databases can carry several thread rows for the same pair.
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND role = 'assistant' AND status = 'completed'
         AND digested_at IS NULL
         ${since ? "AND created_at >= ?" : ""}
       ORDER BY id ASC LIMIT ?`,
    )
    .all(
      ...(since
        ? [thread.agent_id, thread.user_id, since, limit * 2]
        : [thread.agent_id, thread.user_id, limit * 2]),
    ) as any[];
  const turns: DigestTurn[] = [];
  let transcriptChars = 0;
  const transcriptLimit = digestTranscriptLimit();
  for (const row of rows) {
    if (!String(row.content || "").trim()) continue;
    const user =
      (row.reply_to_message_id
        ? (db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(row.reply_to_message_id) as any)
        : null) ||
      (db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE thread_id = ? AND role = 'user' AND id < ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(Number(row.thread_id), row.id) as any);
    const turn: DigestTurn = {
      threadId: Number(row.thread_id),
      assistantId: Number(row.id),
      userMessageId: user ? Number(user.id) : null,
      userText: user
        ? userMessageForLlm(user.content, parseJson(user.user_images_json, []))
        : "",
      assistantText: String(row.content || "").trim(),
      userCreatedAt: user?.created_at || row.created_at,
      assistantCreatedAt: row.created_at,
    };
    const blockChars = turn.userText.length + turn.assistantText.length + 6;
    if (
      transcriptLimit > 0 &&
      turns.length &&
      transcriptChars + blockChars > transcriptLimit
    ) {
      break;
    }
    turns.push(turn);
    transcriptChars += blockChars;
    if (turns.length >= limit) break;
  }
  if (!turns.length) return null;
  const blocks = turns.map((turn) => {
    const lines: string[] = [];
    if (turn.userText) lines.push(`ta：${turn.userText}`);
    if (turn.assistantText) lines.push(`我：${turn.assistantText}`);
    return lines.join("\n");
  });
  const turnIds = [
    ...new Set(
      turns.flatMap((turn) =>
        [turn.userMessageId, turn.assistantId].filter(
          (value): value is number => typeof value === "number",
        ),
      ),
    ),
  ];
  return {
    threadId: Number(thread.id),
    agentId: Number(thread.agent_id),
    userId: String(thread.user_id),
    turns,
    turnIds,
    transcript: blocks.join("\n\n").trim(),
    contextTranscript: contextTranscriptBefore(turns[0].threadId || threadId, turns[0].assistantId),
  };
}

function markTurnsDigested(ids: number[]) {
  if (!ids.length) return 0;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `UPDATE chat_messages SET digested_at = ?
       WHERE id IN (${placeholders}) AND digested_at IS NULL`,
    )
    .run(nowIso(), ...ids).changes;
}

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function timeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function buildDigestTimeAnchor(): string {
  const tzName = String(process.env.LINGSHU_DISPLAY_TIMEZONE || "Asia/Shanghai").trim() || "Asia/Shanghai";
  let tzLabel = tzName;
  let now: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  try {
    now = timeZoneParts(new Date(), tzName);
  } catch {
    const local = new Date();
    tzLabel = "local";
    now = {
      year: local.getFullYear(),
      month: local.getMonth() + 1,
      day: local.getDate(),
      hour: local.getHours(),
      minute: local.getMinutes(),
      second: local.getSeconds(),
    };
  }
  const weekday = WEEKDAY_ZH[new Date(Date.UTC(now.year, now.month - 1, now.day)).getUTCDay()];
  let lunarStr = "";
  try {
    const solar = Solar.fromYmdHms(now.year, now.month, now.day, now.hour, now.minute, now.second);
    const lunar = solar.getLunar();
    const lunarMd = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
    const ganzhiYear = lunar.getYearInGanZhi();
    const shengxiao = lunar.getYearShengXiao();
    const huangdiYear = Number(lunar.getYear()) + 2697;
    const ganzhiMonth = lunar.getMonthInGanZhi();
    const ganzhiDay = lunar.getDayInGanZhi();
    const ganzhiTime = lunar.getTimeInGanZhi();
    lunarStr =
      ` 农历${lunarMd}（${ganzhiYear}${shengxiao}年）` +
      ` 黄帝纪年${huangdiYear}年` +
      `【干支：${ganzhiYear}年${ganzhiMonth}月${ganzhiDay}日${ganzhiTime}时】`;
    const extras: string[] = [];
    const jieqi = lunar.getJieQi();
    if (jieqi) extras.push(String(jieqi));
    for (const festival of lunar.getFestivals() || []) extras.push(String(festival));
    for (const festival of solar.getFestivals() || []) extras.push(String(festival));
    if (extras.length) lunarStr += `【${extras.join("/")}】`;
  } catch {
    // Lunar metadata is best-effort; the solar anchor is still authoritative.
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `本次对话发生于：${now.year}年${now.month}月${now.day}日${lunarStr} ` +
    `${pad(now.hour)}:${pad(now.minute)}:${pad(now.second)} ${weekday}（${tzLabel}）\n` +
    "#时间常识\n" +
    "以上是此刻的真实时间，权威且不可推翻。凡涉及日期、星期、节气、" +
    "「今天/昨天/刚刚/上次/这几天」之类的表述，一律以本行为准，" +
    "禁止凭上文对话的语感去推断或沿用旧的时间感（例如别把今天说成别的星期几）；" +
    "回应前先据此校准，避免做出与当前时间矛盾的说法。"
  );
}

function renderDigestTemplate(template: string, vars: Record<string, string>): string {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}

function readUserLabel(userId: string): string {
  const row = getDb()
    .prepare("SELECT nickname FROM user_profiles WHERE user_id = ?")
    .get(userId) as { nickname?: string } | undefined;
  const nickname = String(row?.nickname || "").trim();
  return nickname || "ta";
}

function buildDigestRoleContext(userLabel: string, agentLabel: string): string {
  return renderDigestTemplate(DIGEST_TEMPLATES.DIGEST_ROLE_CONTEXT, {
    user: String(userLabel || "ta").trim() || "ta",
    agent: String(agentLabel || "我").trim() || "我",
  });
}

function buildDigestPersona(userLabel: string, agentLabel: string, roleBlock: string): string {
  return renderDigestTemplate(DIGEST_TEMPLATES.DIGEST_EXTRACTOR_PERSONA, {
    agentName: String(agentLabel || "我").trim() || "我",
    user: String(userLabel || "ta").trim() || "ta",
    roleBlock: String(roleBlock || "").trim() || "（无额外设定）",
  });
}

function digestSystemParts(userLabel: string, agentLabel: string, roleBlock: string): string[] {
  // APP order: byte-identical static rules first (cacheable), then JSON-only
  // system note, then the per-agent persona card.
  return [
    DIGEST_TEMPLATES.DIGEST_EXTRACTOR_RULES,
    DIGEST_PROMPTS.JSON_ONLY_SYSTEM,
    buildDigestPersona(userLabel, agentLabel, roleBlock),
  ];
}

function isResponseFormatUnsupported(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|json_schema|unsupported|not support|invalid.*format/i.test(detail);
}

function isLengthFinishError(error: unknown): boolean {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /LengthFinishReason|finish_reason.*length|length.*finish|truncat|max_tokens/i.test(detail);
}

export async function requestDigestJson(
  system: string | string[],
  human: string,
  options: {
    temperature?: number;
    retries?: number;
    schema?: Record<string, unknown>;
    schemaName?: string;
  } = {},
): Promise<any> {
  const cfg = getLLMConfig("memory");
  if (!cfg.model || !cfg.baseUrl) throw new Error("memory_llm_unavailable");
  const client = createOpenAIClient(cfg);
  const systemParts = Array.isArray(system) ? system : [system];
  const messages = [
    ...systemParts
      .map((content) => String(content || "").trim())
      .filter(Boolean)
      .map((content) => ({ role: "system" as const, content })),
    { role: "user" as const, content: human },
  ];
  const temperature = options.temperature ?? 0.1;
  const retries = Math.max(0, options.retries ?? 2);
  const schemaFormat = options.schema
    ? ({
        type: "json_schema",
        json_schema: {
          name: options.schemaName || "digest_extraction",
          strict: false,
          schema: options.schema,
        },
      } as any)
    : null;
  const jsonObjectFormat = { type: "json_object" } as any;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // First pass prefers json_schema; retries fall back to json_object because a
    // reasoning model may have exhausted its token budget on strict schema.
    const formats: any[] = attempt === 0 ? [schemaFormat, jsonObjectFormat, null] : [jsonObjectFormat, null];
    let retryAttempt = false;
    for (const format of formats) {
      try {
        const response = await createCompletionWithThinkingFallback(
          client,
          {
            model: cfg.model,
            messages,
            temperature,
            ...(format ? { response_format: format } : {}),
            ...buildThinkingParams(cfg),
          } as any,
          cfg,
        );
        recordCompletionUsage(cfg.model, response, "memory");
        if (String((response.choices?.[0] as any)?.finish_reason || "").toLowerCase() === "length") {
          lastError = new Error("length_finish_reason");
          retryAttempt = true;
          break;
        }
        return parseJsonBlock(response.choices?.[0]?.message?.content || "");
      } catch (error) {
        lastError = error;
        if (isLengthFinishError(error)) {
          retryAttempt = true;
          break;
        }
        if (isResponseFormatUnsupported(error)) continue;
        // Malformed/truncated JSON is worth one more structured attempt.
        const detail = error instanceof Error ? error.message : String(error);
        if (/invalid_digest_json|Unexpected token|JSON|parse/i.test(detail)) {
          retryAttempt = true;
          break;
        }
        throw error;
      }
    }
    if (!retryAttempt && !formats.length) break;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "digest_json_failed"));
}

async function extractDigest(
  scope: MemoryScope,
  chunk: DigestChunk,
  context: {
    userLabel: string;
    agentLabel: string;
    roleBlock: string;
    knownFacts: string;
    constraints: { id: number; rule_type: string; description: string }[];
    threads: RelationshipThreadCandidate[];
  },
  complete?: DigestComplete,
): Promise<DigestExtraction> {
  const userLabel = context.userLabel;
  const roleContext = buildDigestRoleContext(userLabel, context.agentLabel);
  const knownBlock = String(context.knownFacts || "").trim() || "（无）";
  const constraintBlock =
    context.constraints
      .map((item) => `- id: ${item.id}\n  rule_type: ${item.rule_type}\n  description: ${item.description}`)
      .join("\n") || "（无）";
  let human =
    `${buildDigestTimeAnchor()}\n\n${roleContext}\n\n` +
    `用户身份配置：昵称=${userLabel}\n\n` +
    `对话记录：\n${chunk.transcript}\n\n` +
    `已知事实：\n${knownBlock}\n\n` +
    `已有约束（同主题必须 update 已有 id，禁止重复 new）：\n${constraintBlock}`;
  if (context.threads.length) {
    const block = context.threads
      .map((thread, index) => {
        const summary = String(thread.summary || "").trim();
        const lastAt = String(thread.last_at || "").slice(0, 10);
        return `- [${index}] 《${thread.title || ""}》${summary}${lastAt ? `（最近 ${lastAt}）` : ""}`;
      })
      .join("\n");
    human +=
      "\n\n历史共同来往候选（本次对话若真的用上其中某条——又叫了约定的称呼或说法、按约定行事、回应或兑现此前的共同内容——就要为它输出一条 continuity：carries_index=该序号，nodes 填本次原话行号，carry_note 写清这次承接了什么；序号仅在此列表内有效）：\n" +
      block;
  }
  human += FACT_TIME_PROMPT_RULE;

  const parsed = complete
    ? await complete(
        digestSystemParts(userLabel, context.agentLabel, context.roleBlock),
        human,
        EXTRACTOR_SCHEMA_WITH_TIME,
      )
    : await requestDigestJson(digestSystemParts(userLabel, context.agentLabel, context.roleBlock), human, {
        temperature: 0.1,
        retries: 2,
        schema: EXTRACTOR_SCHEMA_WITH_TIME,
        schemaName: DIGEST_RESPONSE_SCHEMAS.EXTRACTOR.name,
      });

  const rawStreams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const rawConstraints = Array.isArray(parsed?.constraints) ? parsed.constraints : [];
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  const rawCorrections = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
  const rawContinuity = Array.isArray(parsed?.continuity) ? parsed.continuity : [];

  const streams: ExtractedStream[] = rawStreams
    .map((item: any) => {
      const rawType = item?.stream_type ?? item?.streamType ?? item?.type;
      const type = String(rawType || "").toLowerCase() === "internal" ? "internal" : "external";
      return {
        narrative: normalizeStreamNarrative(String(item?.narrative || "")),
        about: normalizeStreamAbout(String(item?.about || (type === "internal" ? "她·感受" : "他·日常")), type),
        type,
        significance: clampNumber(
          item?.significance,
          DIGEST_CONSTANTS.SIGNIFICANCE_MIN,
          DIGEST_CONSTANTS.SIGNIFICANCE_MAX,
          DIGEST_CONSTANTS.SIGNIFICANCE_DEFAULT,
        ),
        rawStart: null,
        rawEnd: null,
      } as ExtractedStream;
    })
    .filter((item: ExtractedStream) => item.narrative.length >= 4);

  const constraints: ExtractedConstraint[] = rawConstraints
    .map((item: any): ExtractedConstraint | null => {
      const action = String(item?.action || "new");
      const ruleType = String(item?.rule_type ?? item?.ruleType ?? "dont").toLowerCase();
      if (!["new", "update", "remove"].includes(action)) return null;
      if (ruleType !== "do" && ruleType !== "dont") return null;
      const targetId = item?.target_id ?? item?.targetId;
      return {
        action: action as "new" | "update" | "remove",
        targetId: targetId == null ? null : Number(targetId),
        ruleType,
        description: String(item?.description || "").trim(),
        evidence: String(item?.evidence || "").trim(),
      };
    })
    .filter((item: ExtractedConstraint | null): item is ExtractedConstraint => Boolean(item))
    .filter((item: ExtractedConstraint) => {
      if (!evidenceInUserSide(item.evidence, chunk.transcript, userLabel)) return false;
      if (item.action !== "new") return Number.isInteger(item.targetId) && Number(item.targetId) > 0;
      return item.description.length >= 2;
    });

  // Each fact carries the created_at of the message its evidence came from, so
  // one digest chunk spanning several turns does not stamp every fact with the
  // chunk's (later) ended_at.
  const factValidAtByEvidence = (evidence: string): string | null => {
    const needle = flattenTranscriptContent(evidence);
    if (!needle) return null;
    const row = chunk.rows.find((candidate) =>
      flattenTranscriptContent(candidate.content).includes(needle),
    );
    return row?.createdAt ?? null;
  };
  // Conversation-time basis for relative expressions the model may emit.
  const digestReferenceTime = String(
    chunk.rows[chunk.rows.length - 1]?.createdAt ||
      chunk.messages[chunk.messages.length - 1]?.created_at ||
      nowIso(),
  );

  const facts: ExtractedFact[] = rawFacts
    .map((item: any) => {
      const extractedValidAt = normalizeFactExtractedTime(
        item?.valid_at ?? item?.validAt,
        digestReferenceTime,
      );
      const extractedInvalidAt = normalizeFactExtractedTime(
        item?.invalid_at ?? item?.invalidAt,
        digestReferenceTime,
      );
      return {
        subject: String(item?.subject || "").trim() as "Me" | "Self",
        relation: String(item?.relation || "").trim().toUpperCase(),
        object: String(item?.object || "").trim().slice(0, 120),
        description: String(item?.description || "").trim().slice(0, 500),
        evidence: String(item?.evidence || "").trim(),
        confidence: clampNumber(item?.confidence, 0, 1, DIGEST_CONSTANTS.FACT_CONFIDENCE_DEFAULT),
        importance: clampNumber(item?.importance, 0, 1, 0.5),
        isIdentity: false,
        validAt: extractedValidAt,
        invalidAt: extractedInvalidAt,
      };
    })
    .filter(
      (item: ExtractedFact) =>
        (item.subject === "Me" || item.subject === "Self") &&
        (DIGEST_SETS.FACT_RELATIONS as readonly string[]).includes(item.relation) &&
        item.confidence >= 0.5 &&
        Boolean(item.object || item.description) &&
        !(DIGEST_SETS.PLACEHOLDER_ENTITIES as readonly string[]).includes(item.object.toLowerCase()) &&
        evidenceInUserSide(item.evidence, chunk.transcript, userLabel),
    )
    .map((item: ExtractedFact) => coerceNameFact(item))
    .filter((item: ExtractedFact | null): item is ExtractedFact => Boolean(item))
    .map((item: ExtractedFact) => {
      // Priority: extractor valid_at > evidence message created_at. applyFacts
      // still falls back to episode.endedAt when both are absent.
      const validAt = item.validAt ?? factValidAtByEvidence(item.evidence);
      const invalidAt =
        item.invalidAt && validAt && item.invalidAt <= validAt ? null : item.invalidAt ?? null;
      return { ...item, validAt, invalidAt };
    });

  const corrections: ExtractedCorrection[] = rawCorrections
    .map((item: any) => ({
      targetType: "fact" as const,
      targetHint: String(item?.target_hint ?? item?.targetHint ?? "").trim(),
    }))
    .filter((item: ExtractedCorrection) => item.targetHint.length >= 2);

  const rowByIndex = new Map(chunk.rows.map((row) => [row.index, row]));
  const continuity: ExtractedContinuity[] = rawContinuity
    .map((item: any) => {
      const carriesRaw = Number(item?.carries_index ?? item?.carriesIndex ?? -1);
      const carriesIndex =
        Number.isInteger(carriesRaw) && carriesRaw >= 0 && carriesRaw < context.threads.length
          ? carriesRaw
          : -1;
      const seen = new Set<number>();
      const nodes: ExtractedContinuity["nodes"] = [];
      for (const node of Array.isArray(item?.nodes) ? item.nodes : []) {
        const index = Number(node?.index);
        if (!Number.isInteger(index) || seen.has(index)) continue;
        const row = rowByIndex.get(index);
        if (!row) continue;
        seen.add(index);
        nodes.push({
          index,
          messageId: row.messageId,
          role: row.role,
          content: row.content,
          createdAt: row.createdAt,
        });
      }
      return {
        title: String(item?.title || "").trim().slice(0, 160),
        note: String(item?.note || "").trim().slice(0, 1200),
        carriesIndex,
        carryNote: String(item?.carry_note ?? item?.carryNote ?? "").trim().slice(0, 600),
        nodes,
      };
    })
    .filter((item: ExtractedContinuity) => item.title.length >= 2 && item.nodes.length >= 1);

  // The APP schema requires a boolean. Anything else (missing/string/0) must
  // not open the crystallization gate.
  const shouldWrite = parsed?.should_write === true;
  return {
    shouldWrite,
    streams,
    constraints: shouldWrite ? constraints : [],
    facts: shouldWrite ? facts : [],
    corrections,
    continuity,
  };
}

function applyConstraints(
  scope: MemoryScope,
  items: ExtractedConstraint[],
  segmentRef: string,
) {
  const db = getDb();
  let processed = 0;
  for (const item of items) {
    // remove: hard delete until M2 adds the soft-delete status column. The
    // scope check makes a retried remove idempotent (0 changes, no error).
    if (item.action === "remove") {
      if (item.targetId) {
        const info = db
          .prepare(
            "DELETE FROM hippocampus_constraints WHERE id = ? AND agent_id = ? AND user_id = ?",
          )
          .run(item.targetId, scope.agentId, scope.userId);
        processed += info.changes > 0 ? 1 : 0;
      }
      continue;
    }
    const optOut = /(不要主动|别主动|不想被打扰|别找我|不要找我|别发消息)/.test(item.description) ? 1 : 0;
    const evidenceRefs = JSON.stringify([
      { source: "chat_turn", ref_id: segmentRef, excerpt: item.evidence },
    ]);
    if (item.action === "update" && item.targetId) {
      const info = db
        .prepare(
          `UPDATE hippocampus_constraints SET rule_type = ?,
             description = COALESCE(NULLIF(?, ''), description),
             opt_out_proactive = ?, evidence_refs_json = ?, evidence = ?, segment_ref = ?
           WHERE id = ? AND agent_id = ? AND user_id = ?`,
        )
        .run(
          item.ruleType,
          item.description,
          optOut,
          evidenceRefs,
          item.evidence,
          segmentRef,
          item.targetId,
          scope.agentId,
          scope.userId,
        );
      processed += info.changes > 0 ? 1 : 0;
      continue;
    }
    const exists = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND description = ?",
      )
      .get(scope.agentId, scope.userId, item.description);
    if (exists) continue;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_constraints
          (agent_id, user_id, rule_type, description, opt_out_proactive, evidence_refs_json, evidence,
           segment_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.agentId,
        scope.userId,
        item.ruleType,
        item.description,
        optOut,
        evidenceRefs,
        item.evidence,
        segmentRef,
        nowIso(),
      );
    processed += info.changes;
  }
  return processed;
}

const VALID_RECUR = new Set(["none", "daily", "weekly", "monthly", "yearly", "day", "week", "month", "year"]);

function normalizeRecur(raw: string | null | undefined): string {
  const value = String(raw || "none").trim().toLowerCase();
  return VALID_RECUR.has(value) ? value : "none";
}

const APPOINTMENT_RECUR_KEYS = new Set(["daily", "weekly", "monthly", "yearly"]);

/** Node also accepts the short spellings the digest extractor may emit. */
const APPOINTMENT_RECUR_ALIASES: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

function canonicalRecurKey(recur: string | null | undefined): string {
  const value = String(recur || "none").trim().toLowerCase();
  return APPOINTMENT_RECUR_ALIASES[value] || value;
}

function addDaysZoned(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** Python `_add_months`: month shift clamps the day to the last day of the month. */
function addMonthsZoned(parts: ZonedParts, months: number): ZonedParts {
  const monthIndex = parts.month - 1 + months;
  const year = parts.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { ...parts, year, month, day: Math.min(parts.day, lastDay) };
}

/** Python yearly shift: Feb 29 falls back to Feb 28 on non-leap years. */
function addYearsZoned(parts: ZonedParts, years: number): ZonedParts {
  const year = parts.year + years;
  const lastDay = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  return { ...parts, year, day: Math.min(parts.day, lastDay) };
}

/**
 * Python `advance_recurring_due_at`: roll `due_at` forward — period by period —
 * until it is no longer in the past. Returns null for one-shot appointments.
 *
 * M3: minute-interval reminders (`recur = "interval:<minutes>"`, the APP's
 * storage format for manage_alarm recurrence=interval) roll forward in
 * minute steps instead of calendar periods.
 */
export function advanceRecurringDueAt(
  dueAt: string,
  recur: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const rawRecur = String(recur || "").trim().toLowerCase();
  const intervalMinutes = parseIntervalRecurMinutes(rawRecur);
  if (intervalMinutes !== null) {
    const date = new Date(String(dueAt || ""));
    if (Number.isNaN(date.getTime())) return null;
    let current = date.getTime();
    const step = intervalMinutes * 60_000;
    let guard = 0;
    while (current < now.getTime() && guard < 512) {
      current += step;
      guard += 1;
    }
    return new Date(current).toISOString();
  }
  const key = canonicalRecurKey(rawRecur);
  if (!APPOINTMENT_RECUR_KEYS.has(key)) return null;
  const date = new Date(String(dueAt || ""));
  if (Number.isNaN(date.getTime())) return null;
  let current = date;
  let guard = 0;
  while (current.getTime() < now.getTime() && guard < 512) {
    const parts = zonedParts(current);
    let next: ZonedParts;
    if (key === "daily") next = addDaysZoned(parts, 1);
    else if (key === "weekly") next = addDaysZoned(parts, 7);
    else if (key === "monthly") next = addMonthsZoned(parts, 1);
    else next = addYearsZoned(parts, 1);
    current = wallTimeToUtc(next);
    guard += 1;
  }
  return current.toISOString();
}

/** `"interval:<minutes>"` → minutes (1–1440), or null when not an interval recur. */
export function parseIntervalRecurMinutes(recur: string | null | undefined): number | null {
  const value = String(recur || "").trim().toLowerCase();
  if (!value.startsWith("interval:")) return null;
  const minutes = Number(value.slice("interval:".length).trim());
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return null;
  return Math.round(minutes);
}

/**
 * Python `_is_due_for_active_delivery`.
 *
 * Two rules:
 *  1. the appointment day (display timezone) must not be in the future;
 *  2. the de-dup window is the **appointment day**, not "today": the reminder
 *     stays due while `last_delivered_at` is on an earlier day than the
 *     appointment's own due day. Comparing against "today" is what made the
 *     scheduler re-fire every single day.
 *
 * Minute-interval reminders (`interval:<minutes>`) are the exception: several
 * deliveries land on the same day by design, so the de-dup compares exact
 * timestamps instead of days.
 */
export function isAppointmentDueForDelivery(
  dueAt: Date,
  lastDeliveredAt: string | null | undefined,
  now: Date = new Date(),
  recur: string | null | undefined = null,
): boolean {
  if (Number.isNaN(dueAt.getTime())) return false;
  if (dayKey(dueAt) > dayKey(now)) return false;
  if (!lastDeliveredAt) return true;
  const delivered = new Date(String(lastDeliveredAt));
  if (Number.isNaN(delivered.getTime())) return true;
  if (recur && parseIntervalRecurMinutes(String(recur)) !== null) {
    return delivered.getTime() < dueAt.getTime();
  }
  return dayKey(delivered) < dayKey(dueAt);
}

/**
 * Python `consume_due_appointment_reminders`: a chat turn that carried the
 * appointment reminder hint counts as the delivery, so the scheduler must not
 * push the same appointment again. One-shot appointments are closed, recurring
 * ones roll forward to their next future occurrence.
 */
export function consumeDueAppointmentReminders(
  scope: MemoryScope,
  now: Date = new Date(),
): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_appointments
       WHERE agent_id = ? AND user_id = ? AND status IN ('active','pending')
         AND due_at IS NOT NULL
       ORDER BY due_at ASC LIMIT 50`,
    )
    .all(scope.agentId, scope.userId) as any[];
  let consumed = 0;
  for (const row of rows) {
    const storedDue = new Date(String(row.due_at));
    if (Number.isNaN(storedDue.getTime())) continue;
    // Same roll-forward the prompt injection uses: a recurring appointment
    // whose occurrence already elapsed is not consumed by this chat turn.
    const advanced = advanceRecurringDueAt(String(row.due_at), row.recur, now);
    const effectiveDue = advanced ? new Date(advanced) : storedDue;
    if (!isAppointmentDueForDelivery(effectiveDue, row.last_delivered_at, now, row.recur)) continue;
    // Roll strictly past `now` so the next occurrence is a different one.
    const nextDue = advanceRecurringDueAt(
      String(row.due_at),
      row.recur,
      new Date(now.getTime() + 1000),
    );
    db.prepare(
      `UPDATE hippocampus_appointments
       SET last_delivered_at = ?,
           status = ?,
           due_at = COALESCE(?, due_at)
       WHERE id = ?`,
    ).run(
      now.toISOString(),
      nextDue ? "active" : "delivered",
      nextDue,
      row.id,
    );
    consumed += 1;
  }
  return consumed;
}

function factSubjectName(subject: string): string {
  const value = String(subject || "").trim();
  if (["Me", "me", "他", "用户", "ta"].includes(value)) return "他";
  if (["Self", "self", "我", "她", "助手"].includes(value)) return "她";
  return value || "他";
}

/**
 * Best-effort fact vector write used after a *created* fact. The fact row is
 * already committed (writeFact runs its own transaction); an embedding failure
 * must only log and leave semantic recall to BM25/entity channels.
 */
async function writeFactEmbeddingSafely(
  factId: string,
  description: string,
  embed?: (text: string) => Promise<number[]>,
) {
  const text = String(description || "").trim();
  if (!factId || !text) return;
  try {
    const vector = embed ? await embed(text) : (await embedText(text, { wait: true })).vector;
    if (vector?.length) storeFactEmbedding(factId, vector);
  } catch (error) {
    console.warn("[MEMORY_FACT_VEC] embedding failed", {
      factId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function applyFacts(
  scope: MemoryScope,
  items: ExtractedFact[],
  context: {
    segmentRef: string;
    episodeId: string | null;
    episodeEndedAt: string | null;
    entityResolution?: Map<string, EntityResolutionDecision>;
    isStillValid?: () => boolean;
    embed?: (text: string) => Promise<number[]>;
  },
) {
  let processed = 0;
  for (const item of items) {
    if (context.isStillValid && !context.isStillValid()) return processed;
    if (!(DIGEST_SETS.FACT_RELATIONS as readonly string[]).includes(item.relation)) continue;
    const coerced = coerceNameFact(item);
    if (!coerced) continue;
    const sourceName = factSubjectName(coerced.subject);
    const targetName = coerced.object || coerced.subject;
    const sourceDecision = context.entityResolution?.get(normalizeEntityAlias(sourceName));
    const targetDecision = context.entityResolution?.get(normalizeEntityAlias(targetName));
    const sourceId = await ensureEntity(scope, sourceName, {
      kind: "person",
      sourceEpisodeId: context.episodeId,
      isStillValid: context.isStillValid,
      embed: context.embed,
      entityId: sourceDecision?.entityId,
      forceNew: sourceDecision?.forceNew === true,
    });
    if (!sourceId) return processed;
    const targetId = await ensureEntity(scope, targetName, {
      kind: entityKindForRelation(coerced.relation),
      sourceEpisodeId: context.episodeId,
      isStillValid: context.isStillValid,
      embed: context.embed,
      entityId: targetDecision?.entityId,
      forceNew: targetDecision?.forceNew === true,
    });
    if (!targetId) return processed;
    if (context.isStillValid && !context.isStillValid()) return processed;
    const description =
      coerced.description || `${sourceName} ${coerced.relation} ${targetName}`.trim();

    // All invalidation / dedupe / source-provenance semantics live in the
    // shared writeFact store. `SINGLE_VALUE_RELATIONS` is only the fallback
    // when the predicate registry has no row for this relation.
    const result = writeFact({
      scope,
      fromEntityId: sourceId,
      toEntityId: targetId,
      relation: coerced.relation,
      description,
      confidence: coerced.confidence,
      importance: coerced.importance,
      isIdentity: coerced.isIdentity,
      evidence: coerced.evidence,
      evidenceRef: {
        source: "chat_turn",
        ref_id: context.segmentRef,
        excerpt: coerced.evidence,
      },
      episodeId: context.episodeId,
      validAt: item.validAt ?? context.episodeEndedAt,
      invalidAt: item.invalidAt ?? null,
      extractorVersion: DIGEST_EXTRACTOR_VERSION,
      promptVersion: DIGEST_PROMPT_VERSION,
      fallbackSingleValue: SINGLE_VALUE_RELATIONS.has(coerced.relation),
    });
    if (result.created) {
      processed += 1;
      await writeFactEmbeddingSafely(result.factId, description, context.embed);
    }
  }
  return processed;
}

function expireFactsByHint(scope: MemoryScope, hint: string) {
  const value = String(hint || "").trim();
  if (value.length < 2) return 0;
  return getDb()
    .prepare(
      `UPDATE hippocampus_facts
       SET status = 'expired', expired_at = ?,
           invalid_at = COALESCE(invalid_at, ?),
           invalidation_reason = COALESCE(invalidation_reason, 'manual_forget'),
           updated_at = ?
       WHERE agent_id = ? AND user_id = ? AND status = 'current'
         AND (description LIKE ? OR to_entity_id IN (
           SELECT id FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? AND name LIKE ?
         ))`,
    )
    .run(
      nowIso(),
      nowIso(),
      nowIso(),
      scope.agentId,
      scope.userId,
      `%${value}%`,
      scope.agentId,
      scope.userId,
      `%${value}%`,
    ).changes;
}

// ─── save_memory (proactive memory tool) ────────────────────────────────────

const PREFERENCE_RELATIONS = new Set(["LIKES", "DISLIKES", "INTERESTED_IN"]);
const SAVE_MEMORY_USER_WINDOW = 20;

export interface SaveMemoryInput {
  agentId: number;
  userId?: string | null;
  threadId?: number | null;
  memoryType: "fact" | "preference";
  relation: string;
  subject?: string;
  object: string;
  description?: string;
  evidence: string;
  confidence?: number;
}

export interface SaveMemoryResult {
  ok: boolean;
  message: string;
  factId?: string;
  constraintId?: number;
  merged?: boolean;
}

/**
 * Recent user utterances of one thread (verbatim evidence check).
 * `content` is the raw user text; the `[图片]` placeholder lives only in the
 * LLM-side copy and must not participate in the match.
 */
function recentThreadUserMessages(threadId: number, limit: number): string[] {
  return (
    getDb()
      .prepare(
        `SELECT content FROM chat_messages
         WHERE thread_id = ? AND role = 'user' AND TRIM(COALESCE(content, '')) != ''
         ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, limit)}`,
      )
      .all(threadId) as { content: string }[]
  ).map((row) => String(row.content || ""));
}

function resolveLatestThread(agentId: number, userId: string): number | null {
  const row = getDb()
    .prepare(
      "SELECT id FROM chat_threads WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .get(agentId, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * save_memory tool backend — writes facts / preferences ONLY.
 *
 *  - `evidence` is mandatory and must be found verbatim inside one of the
 *    thread's last 20 user messages; a fabricated quote is the exact failure
 *    mode the gate exists for.
 *  - facts go through the same `hippocampus_entities` + `hippocampus_facts`
 *    pipeline the digest uses (merge by subject+relation, single-value or
 *    multi-value), with the tool's relaxed relation rule: any UPPER_SNAKE_CASE
 *    name, empty → RELATED.
 *  - preferences (memory_type=preference) must use LIKES / DISLIKES /
 *    INTERESTED_IN and land in `hippocampus_constraints` — the same table the
 *    digest's preference pipeline and the prompt's 相处偏好 block read.
 *  - never writes streams / seeds / portraits, and never touches the M2 seed
 *    evolution. Errors return ok=false so the model cannot claim it remembered.
 */
export async function saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
  const scope = memoryScope(input.agentId, input.userId);
  const evidence = String(input.evidence || "").trim();
  if (!evidence) {
    return {
      ok: false,
      message: "未写入：evidence 必填，必须是用户本轮或最近的原话片段",
    };
  }
  const threadId =
    input.threadId && Number.isFinite(Number(input.threadId)) && Number(input.threadId) > 0
      ? Number(input.threadId)
      : resolveLatestThread(scope.agentId, scope.userId);
  if (!threadId) {
    return { ok: false, message: "未写入：找不到当前会话，无法校验用户原话" };
  }
  const userMessages = recentThreadUserMessages(threadId, SAVE_MEMORY_USER_WINDOW);
  const evidenceOk = userMessages.some((content) => content.includes(evidence));
  if (!evidenceOk) {
    return {
      ok: false,
      message:
        "未写入：evidence 不是用户原话（未能在该会话最近 20 条用户发言中逐字找到）。请引用用户原话后重试",
    };
  }

  const memoryType = String(input.memoryType || "fact").trim().toLowerCase() === "preference"
    ? "preference"
    : "fact";
  let relation = String(input.relation || "").trim().toUpperCase();
  if (!relation) relation = "RELATED";
  if (!/^[A-Z][A-Z0-9_]*$/.test(relation)) {
    return {
      ok: false,
      message: `未写入：relation 必须是大写蛇形英文（收到「${relation}」）`,
    };
  }
  if (memoryType === "preference" && !PREFERENCE_RELATIONS.has(relation)) {
    return {
      ok: false,
      message: "未写入：memory_type=preference 时 relation 只能是 LIKES / DISLIKES / INTERESTED_IN",
    };
  }
  const object = String(input.object || "").trim();
  if (!object) {
    return { ok: false, message: "未写入：object 必填（断言对象实体）" };
  }
  const subjectRaw = String(input.subject || "Me").trim();
  const subject = subjectRaw.toLowerCase() === "self" ? "Self" : "Me";
  const confidenceRaw = Number(input.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.7;
  const db = getDb();

  if (memoryType === "preference") {
    const description = String(input.description || "").trim() || `他${relation === "LIKES" ? "喜欢" : relation === "DISLIKES" ? "不喜欢" : "对"}${object}`;
    const existing = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND description = ?",
      )
      .get(scope.agentId, scope.userId, description) as { id: number } | undefined;
    if (existing) {
      return {
        ok: true,
        merged: true,
        constraintId: existing.id,
        message: `已存在相同偏好，未重复写入：${description}`,
      };
    }
    const segmentRef = `proactive-save-${threadId}`;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_constraints
          (agent_id, user_id, rule_type, description, opt_out_proactive, evidence_refs_json, evidence,
           segment_ref, created_at)
         VALUES (?, ?, 'do', ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        scope.agentId,
        scope.userId,
        description,
        JSON.stringify([
          { source: "chat_turn", ref_id: segmentRef, excerpt: evidence },
        ]),
        evidence,
        segmentRef,
        nowIso(),
      );
    if (!info.changes) {
      return { ok: false, message: "未写入：偏好已存在（同描述同会话）" };
    }
    const row = db
      .prepare(
        "SELECT id FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? AND segment_ref = ? ORDER BY id DESC LIMIT 1",
      )
      .get(scope.agentId, scope.userId, segmentRef) as { id: number } | undefined;
    return {
      ok: true,
      constraintId: row?.id,
      message: `已记住（偏好）：${description}`,
    };
  }

  // fact → the exact same writeFact pipeline the digest uses. A virtual
  // `source='proactive-save'` episode keeps the fact traceable even though
  // save_memory has no digest chunk.
  const episode = ensureProactiveEpisode({ scope, threadId, evidence });
  const sourceName = factSubjectName(subject);
  const targetName = object;
  const sourceId = await ensureEntity(scope, sourceName, {
    kind: "person",
    sourceEpisodeId: episode.id,
  });
  if (!sourceId) return { ok: false, message: "未写入：记忆向量模型不可用，无法落实体" };
  const targetId = await ensureEntity(scope, targetName, {
    kind: entityKindForRelation(relation),
    sourceEpisodeId: episode.id,
  });
  if (!targetId) return { ok: false, message: "未写入：记忆向量模型不可用，无法落实体" };
  const description = String(input.description || "").trim() || object;
  const written = writeFact({
    scope,
    fromEntityId: sourceId,
    toEntityId: targetId,
    relation,
    description,
    confidence,
    importance: 0.5,
    isIdentity: false,
    evidence,
    evidenceRef: {
      source: "chat_turn",
      ref_id: `proactive-save-${threadId}`,
      excerpt: evidence,
    },
    episodeId: episode.id,
    validAt: episode.endedAt,
    extractorVersion: DIGEST_EXTRACTOR_VERSION,
    promptVersion: DIGEST_PROMPT_VERSION,
    fallbackSingleValue: SINGLE_VALUE_RELATIONS.has(relation),
  });
  if (written.created) {
    await writeFactEmbeddingSafely(written.factId, description);
    return { ok: true, factId: written.factId, message: `已记住：${description}` };
  }
  return {
    ok: true,
    factId: written.factId,
    merged: true,
    message: `已存在相同记忆，未重复写入：${description}`,
  };
}

interface AkinCandidateRow {
  id: string;
  narrative: string;
  about: string;
  created_at: string;
  similarity: number;
  source: "vector" | "temporal";
}

/** L2 distance <= 1.1 on unit vectors == cosine similarity >= 0.395. */
const AKIN_MIN_COSINE = Math.max(
  0,
  1 - (DIGEST_CONSTANTS.AKIN_LINK_MAX_L2 * DIGEST_CONSTANTS.AKIN_LINK_MAX_L2) / 2,
);

async function judgeAkinCandidates(
  focalNarrative: string,
  candidates: { id: string; narrative: string; about: string; created_at: string }[],
  judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>,
): Promise<number[]> {
  if (!candidates.length) return [];
  if (judge) {
    return judge(
      focalNarrative,
      candidates.map((candidate) => ({
        ...candidate,
        similarity: AKIN_MIN_COSINE,
        source: "vector" as const,
      })),
    );
  }
  const lines = [`【焦点】${String(focalNarrative || "").trim()}`, "", "【候选】"];
  candidates.forEach((candidate, index) => {
    const when = candidate.created_at
      ? new Date(candidate.created_at).toISOString().slice(5, 16).replace("T", " ")
      : "?";
    lines.push(`${index}. (${candidate.about} · ${when}) ${String(candidate.narrative || "").trim()}`);
  });
  const parsed = await requestDigestJson(DIGEST_PROMPTS.AKIN_JUDGE, lines.join("\n"), {
    temperature: 0.0,
    retries: 0,
    schema: DIGEST_RESPONSE_SCHEMAS.AKIN_JUDGE_SINGLE.schema,
    schemaName: DIGEST_RESPONSE_SCHEMAS.AKIN_JUDGE_SINGLE.name,
  });
  const linked: unknown[] = Array.isArray(parsed?.linked) ? parsed.linked : [];
  const unique = new Set<number>();
  for (const value of linked) {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < candidates.length) unique.add(index);
  }
  return [...unique].sort((left, right) => left - right);
}

async function collectAkinCandidates(
  scope: MemoryScope,
  focal: { id: string; vector: number[] },
): Promise<AkinCandidateRow[]> {
  const db = getDb();
  const focalRow = db
    .prepare(
      "SELECT id, narrative, about, created_at FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?",
    )
    .get(focal.id, scope.agentId, scope.userId) as
    | { id: string; narrative: string; about: string; created_at: string }
    | undefined;
  if (!focalRow) return [];
  const byId = new Map<string, AkinCandidateRow>();

  if (focal.vector.length) {
    const vectorLimit = Math.max(1, DIGEST_CONSTANTS.AKIN_LINK_TOPK);
    const hits = searchStreamCandidates(
      scope.agentId,
      scope.userId,
      focal.vector,
      Math.max(24, vectorLimit * 6),
    );
    let vectorCount = 0;
    for (const hit of hits) {
      if (vectorCount >= vectorLimit) break;
      if (hit.streamId === focal.id || hit.similarity < AKIN_MIN_COSINE) continue;
      const row = db
        .prepare(
          `SELECT id, narrative, about, created_at FROM hippocampus_streams
           WHERE id = ? AND agent_id = ? AND user_id = ? AND archived = 0`,
        )
        .get(hit.streamId, scope.agentId, scope.userId) as
        | { id: string; narrative: string; about: string; created_at: string }
        | undefined;
      if (!row) continue;
      byId.set(row.id, { ...row, similarity: hit.similarity, source: "vector" });
      vectorCount += 1;
    }
  }

  const temporalLimit = Math.max(0, DIGEST_CONSTANTS.AKIN_TEMPORAL_NEIGHBOR_LIMIT);
  if (temporalLimit > 0 && byId.size < DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP) {
    const eachSide = Math.max(1, Math.ceil(temporalLimit / 2));
    const before = db
      .prepare(
        `SELECT id, narrative, about, created_at FROM hippocampus_streams
         WHERE agent_id = ? AND user_id = ? AND archived = 0 AND id <> ? AND created_at <= ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(scope.agentId, scope.userId, focal.id, focalRow.created_at, eachSide * 2) as Array<{
      id: string;
      narrative: string;
      about: string;
      created_at: string;
    }>;
    const after = db
      .prepare(
        `SELECT id, narrative, about, created_at FROM hippocampus_streams
         WHERE agent_id = ? AND user_id = ? AND archived = 0 AND id <> ? AND created_at >= ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(scope.agentId, scope.userId, focal.id, focalRow.created_at, eachSide * 2) as Array<{
      id: string;
      narrative: string;
      about: string;
      created_at: string;
    }>;
    const temporalRows = [...before.reverse(), ...after];
    let temporalCount = 0;
    for (const row of temporalRows) {
      if (temporalCount >= temporalLimit) break;
      if (byId.size >= DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP) break;
      if (byId.has(row.id)) continue;
      let similarity = AKIN_MIN_COSINE;
      const embedding = db
        .prepare("SELECT embedding FROM hippocampus_streams WHERE id = ?")
        .get(row.id) as { embedding: Buffer | null } | undefined;
      const candidateVector = bufferToVector(embedding?.embedding ?? null);
      if (candidateVector.length && focal.vector.length) {
        similarity = Math.max(AKIN_MIN_COSINE, cosineSimilarity(focal.vector, candidateVector));
      }
      byId.set(row.id, { ...row, similarity, source: "temporal" });
      temporalCount += 1;
    }
  }

  return [...byId.values()].slice(0, DIGEST_CONSTANTS.AKIN_CANDIDATE_TOTAL_CAP);
}

/**
 * Link one already-inserted stream into the member's own AKIN graph. Edges are
 * written in both directions (APP `akin_edges` PK is bidirectional) so the
 * existing two-hop recall reader sees the same graph from either endpoint.
 */
export async function linkStreamToExistingMemory(
  scope: MemoryScope,
  stream: { id: string; narrative: string; vector: number[]; episodeId?: string | null },
  options: {
    judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>;
    guard?: () => boolean;
  } = {},
): Promise<number> {
  const db = getDb();
  if (options.guard && !options.guard()) return 0;
  const candidates = await collectAkinCandidates(scope, stream);
  if (!candidates.length) {
    db.prepare("UPDATE hippocampus_streams SET cluster_linked_at = ? WHERE id = ?").run(
      nowIso(),
      stream.id,
    );
    return 0;
  }
  let keep: number[] = [];
  try {
    keep = await judgeAkinCandidates(stream.narrative, candidates, options.judge);
  } catch {
    keep = [];
  }
  if (options.guard && !options.guard()) return 0;
  let linked = 0;
  const tx = db.transaction(() => {
    for (const index of keep) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const weight = Math.max(0, Math.min(1, candidate.similarity));
      const created = nowIso();
      linked += db
        .prepare(
          `INSERT OR IGNORE INTO hippocampus_edges
            (agent_id, user_id, edge_type, edge_class, source_id, target_id, weight,
             source_episode_id, created_at)
           VALUES (?, ?, 'AKIN', 'associative', ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.agentId,
          scope.userId,
          stream.id,
          candidate.id,
          weight,
          stream.episodeId ?? null,
          created,
        ).changes;
      linked += db
        .prepare(
          `INSERT OR IGNORE INTO hippocampus_edges
            (agent_id, user_id, edge_type, edge_class, source_id, target_id, weight,
             source_episode_id, created_at)
           VALUES (?, ?, 'AKIN', 'associative', ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.agentId,
          scope.userId,
          candidate.id,
          stream.id,
          weight,
          stream.episodeId ?? null,
          created,
        ).changes;
    }
    db.prepare("UPDATE hippocampus_streams SET cluster_linked_at = ? WHERE id = ?").run(
      nowIso(),
      stream.id,
    );
  });
  tx();
  return linked;
}

async function insertDigestStreams(
  scope: MemoryScope,
  chunk: DigestChunk,
  streams: ExtractedStream[],
  episodeId: string | null,
  embed?: (text: string) => Promise<number[]>,
  isStillValid?: () => boolean,
): Promise<{ id: string; narrative: string; vector: number[] }[]> {
  const db = getDb();
  const inserted: { id: string; narrative: string; vector: number[] }[] = [];
  const rawStart = chunk.messages[0]?.id ?? null;
  const rawEnd = chunk.messages[chunk.messages.length - 1]?.id ?? null;
  const sourceMessageIdsJson = JSON.stringify(chunk.messages.map((message) => Number(message.id)));
  const created = nowIso();
  for (let index = 0; index < streams.length; index += 1) {
    if (isStillValid && !isStillValid()) break;
    const item = streams[index];
    const narrative = normalizeStreamNarrative(item.narrative).slice(0, 8000);
    if (!narrative) continue;
    const about = normalizeStreamAbout(item.about, item.type);
    // Deterministic id from the batch range + model output index: a retry of
    // the same batch cannot create a second copy of the same stream.
    const key = `${scope.agentId}:${scope.userId}:${rawStart}:${rawEnd}:${index}`;
    const id = `digest-stream-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO hippocampus_streams
          (id, agent_id, user_id, narrative, about, type, raw_start, raw_end, revisit_count,
           revisit_last_at, significance, archived, origin_scope, perspective, participants_json,
           episode_id, source_message_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 'private_dyadic', ?, '[]', ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.agentId,
        scope.userId,
        narrative,
        about,
        item.type === "internal" ? "internal" : "external",
        rawStart,
        rawEnd,
        created,
        clampNumber(
          item.significance,
          DIGEST_CONSTANTS.SIGNIFICANCE_MIN,
          DIGEST_CONSTANTS.SIGNIFICANCE_MAX,
          DIGEST_CONSTANTS.SIGNIFICANCE_DEFAULT,
        ),
        SELF_ABOUT.has(about) ? "self" : "ta",
        episodeId,
        sourceMessageIdsJson,
        created,
        created,
      );
    if (!info.changes) {
      // A retry after a crash between insert and AKIN linking must still reach
      // the linker; backfill provenance added by v23 if the row predates it.
      db.prepare(
        `UPDATE hippocampus_streams
         SET episode_id = COALESCE(episode_id, ?),
             source_message_ids_json = COALESCE(source_message_ids_json, ?)
         WHERE id = ?`,
      ).run(episodeId, sourceMessageIdsJson, id);
      const existing = db
        .prepare("SELECT embedding FROM hippocampus_streams WHERE id = ?")
        .get(id) as { embedding: Buffer | null } | undefined;
      const existingVector = bufferToVector(existing?.embedding ?? null);
      if (existingVector.length) {
        inserted.push({ id, narrative, vector: existingVector });
        continue;
      }
    }
    const vector = embed ? await embed(narrative) : (await embedText(narrative, { wait: true })).vector;
    if (isStillValid && !isStillValid()) break;
    storeStreamEmbedding(id, vector);
    inserted.push({ id, narrative, vector });
  }
  return inserted;
}

async function linkInsertedStreams(
  scope: MemoryScope,
  inserted: { id: string; narrative: string; vector: number[] }[],
  judge?: (focal: string, candidates: AkinCandidateRow[]) => Promise<number[]>,
  guard?: () => boolean,
) {
  let linked = 0;
  for (const stream of inserted) {
    if (guard && !guard()) break;
    linked += await linkStreamToExistingMemory(scope, stream, { judge, guard });
  }
  return linked;
}

interface DigestAgentRow {
  id: number;
  name: string;
  display_name: string | null;
  role_setting: string | null;
  self_evolution_enabled: number;
}

export interface DigestStateRow {
  agentId: number;
  userId: string;
  lastMessageCreatedAt: string | null;
  lastMessageId: number | null;
  updatedAt: string;
}

export function readDigestState(agentId: number, userId: string): DigestStateRow | null {
  const row = getDb()
    .prepare(
      `SELECT agent_id, user_id, last_message_created_at, last_message_id, updated_at
       FROM digest_state WHERE agent_id = ? AND user_id = ?`,
    )
    .get(agentId, userId) as
    | {
        agent_id: number;
        user_id: string;
        last_message_created_at: string | null;
        last_message_id: number | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    userId: row.user_id,
    lastMessageCreatedAt: row.last_message_created_at,
    lastMessageId: row.last_message_id == null ? null : Number(row.last_message_id),
    updatedAt: row.updated_at,
  };
}

function advanceDigestState(
  scope: MemoryScope,
  lastMessageCreatedAt: string,
  lastMessageId: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO digest_state
        (agent_id, user_id, last_message_created_at, last_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, user_id) DO UPDATE SET
         last_message_created_at = excluded.last_message_created_at,
         last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at
       WHERE COALESCE(excluded.last_message_created_at, '') > COALESCE(digest_state.last_message_created_at, '')
          OR (COALESCE(excluded.last_message_created_at, '') = COALESCE(digest_state.last_message_created_at, '')
              AND excluded.last_message_id >= COALESCE(digest_state.last_message_id, -1))`,
    )
    .run(scope.agentId, scope.userId, lastMessageCreatedAt, lastMessageId, nowIso());
}

function readDigestAgent(agentId: number): DigestAgentRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, name, display_name, role_setting, self_evolution_enabled FROM agent_configs WHERE id = ?",
    )
    .get(agentId) as DigestAgentRow | undefined;
}

interface SelectedDigestMessages {
  rows: DigestMessageRow[];
  rowCapped: boolean;
}

function selectDigestMessages(
  scope: MemoryScope,
  options: { since?: string | null; maxPairs?: number; maxRows?: number } = {},
): SelectedDigestMessages {
  const lookbackStart =
    options.since && String(options.since).trim()
      ? String(options.since)
      : new Date(Date.now() - DIGEST_CONSTANTS.DIGEST_LOOKBACK_DAYS * 86_400_000).toISOString();
  const hardCap = Math.max(1, DIGEST_CONSTANTS.DIGEST_BATCH_ROW_CAP);
  const requested = options.maxRows ?? (options.maxPairs ? options.maxPairs * 2 : hardCap);
  const rowCap = Math.max(1, Math.min(requested, hardCap));
  const state = readDigestState(scope.agentId, scope.userId);
  const clauses = [
    "agent_id = ?",
    "user_id = ?",
    "status = 'completed'",
    "role IN ('user','assistant')",
    "TRIM(content) <> ''",
    "created_at >= ?",
    "digested_at IS NULL",
  ];
  const args: unknown[] = [scope.agentId, scope.userId, lookbackStart];
  if (state?.lastMessageCreatedAt) {
    clauses.push("(created_at > ? OR (created_at = ? AND id > ?))");
    args.push(state.lastMessageCreatedAt, state.lastMessageCreatedAt, state.lastMessageId ?? -1);
  }
  args.push(rowCap + 1);
  const rows = getDb()
    .prepare(
      `SELECT id, thread_id, agent_id, user_id, role, content, llm_content, created_at
       FROM chat_messages
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...args) as DigestMessageRow[];
  const rowCapped = rows.length > rowCap;
  return { rows: rowCapped ? rows.slice(0, rowCap) : rows, rowCapped };
}

function digestPromptOverheadTokens(input: {
  userLabel: string;
  agentLabel: string;
  roleBlock: string;
  knownFacts: string;
  constraints: { id: number; rule_type: string; description: string }[];
  threads: RelationshipThreadCandidate[];
  timeAnchor: string;
}): number {
  const system = digestSystemParts(input.userLabel, input.agentLabel, input.roleBlock).join("\n");
  const constraintBlock = input.constraints
    .map((item) => `- id: ${item.id}\n  rule_type: ${item.rule_type}\n  description: ${item.description}`)
    .join("\n");
  const threadBlock = input.threads
    .map((thread) => `${thread.title || ""}${thread.summary || ""}`)
    .join("\n");
  const base = [
    system,
    input.timeAnchor,
    buildDigestRoleContext(input.userLabel, input.agentLabel),
    `用户身份配置：昵称=${input.userLabel}`,
    "对话记录：",
    "已知事实：",
    input.knownFacts,
    "已有约束（同主题必须 update 已有 id，禁止重复 new）：",
    constraintBlock,
    threadBlock,
  ].join("\n");
  // 2K headroom for tokenizer drift and model output.
  return estimateDigestTokens(base) + 2_048;
}

function fallbackStreamsForChunk(chunk: DigestChunk): ExtractedStream[] {
  const streams: ExtractedStream[] = [];
  let pendingUser = "";
  for (const message of chunk.messages) {
    if (message.role === "user") {
      pendingUser = String(message.content || "").trim();
      continue;
    }
    if (message.role !== "assistant") continue;
    const assistant = String(message.content || "").trim();
    const userSnippet = pendingUser.length > 220 ? `${pendingUser.slice(0, 217)}…` : pendingUser;
    const assistantSnippet = assistant.length > 220 ? `${assistant.slice(0, 217)}…` : assistant;
    if (!userSnippet && !assistantSnippet) continue;
    streams.push({
      narrative: userSnippet
        ? `ta 跟我说：${userSnippet}；我回了：${assistantSnippet}`
        : `我回了：${assistantSnippet}`,
      about: guessStreamAbout(`${pendingUser} ${assistant}`),
      type: "external",
      significance: 0.5,
      rawStart: null,
      rawEnd: null,
    });
    pendingUser = "";
  }
  return streams;
}

interface DigestOnceResult extends AgentDigestRunResult {
  hasMore: boolean;
}

/**
 * continuity persistence. M1 follow-up retired the desktop "心事线" write path:
 * only APP `relationship_threads` / `relationship_thread_nodes` are written.
 * These rows are storage-only and are never injected into chat prompts.
 */
function applyContinuity(
  scope: MemoryScope,
  items: ExtractedContinuity[],
  candidates: RelationshipThreadCandidate[],
  chunk: DigestChunk,
  isStillValid?: () => boolean,
): { threadsCreated: number; threadsUpdated: number; touchpointsWritten: number } {
  if (!items.length) {
    return { threadsCreated: 0, threadsUpdated: 0, touchpointsWritten: 0 };
  }
  const firstId = chunk.messages[0]?.id ?? "none";
  const lastId = chunk.messages[chunk.messages.length - 1]?.id ?? firstId;
  const result = applyRelationshipContinuity(
    scope,
    items as RelationshipContinuityItem[],
    candidates,
    `digest-rel:${scope.agentId}:${scope.userId}:${firstId}:${lastId}`,
    isStillValid,
  );
  return {
    threadsCreated: result.threadsCreated,
    threadsUpdated: result.threadsUpdated,
    // AgentDigestRunResult still exposes the old field name for log compatibility;
    // its value now counts relationship_thread_nodes rows.
    touchpointsWritten: result.nodesWritten,
  };
}

const AFFECT_SIDECAR_PROMPT =
  "你是情绪读数旁路器（Affect Sidecar）。只读本段对话，输出用户侧文本情绪的整体 VAD 读数。\n" +
  "text_valence 范围 -1~1，负=负面、正=正面；text_arousal 与 text_dominance 范围 0~1。\n" +
  "note 用一句简短中文写情绪状态，禁止临床心理标签。\n" +
  '只输出 JSON：{"text_valence":0,"text_arousal":0.4,"text_dominance":0.5,"note":""}';

const AFFECT_SIDECAR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["text_valence", "text_arousal", "text_dominance"],
  properties: {
    text_valence: { type: "number", minimum: -1, maximum: 1 },
    text_arousal: { type: "number", minimum: 0, maximum: 1 },
    text_dominance: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string" },
  },
};

function affectSidecarEnabled(): boolean {
  const raw =
    process.env.LINGSHU_DIGEST_AFFECT_SIDECAR ??
    process.env.LINGSHU_AFFECT_SIDECAR ??
    "1";
  const value = String(raw).trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(value);
}

/**
 * Affect sidecar: deliberately outside the APP strict digest schema. It runs
 * after a private digest batch succeeds, reads the same batch transcript, and
 * writes only `hippocampus_affect_points` plus the baseline aggregate via
 * `applyTextAffect`. Failure is logged and never blocks the digest itself.
 *
 * Switch off with `LINGSHU_DIGEST_AFFECT_SIDECAR=0` (or LINGSHU_AFFECT_SIDECAR).
 */
async function runAffectSidecar(
  scope: MemoryScope,
  chunk: DigestChunk,
  complete: DigestComplete | undefined,
  isStillValid: () => boolean,
): Promise<boolean> {
  if (!affectSidecarEnabled()) return false;
  try {
    if (!isStillValid()) return false;
    const human = `对话记录：\n${chunk.transcript}`;
    const parsed = complete
      ? await complete([AFFECT_SIDECAR_PROMPT, DIGEST_PROMPTS.JSON_ONLY_SYSTEM], human, AFFECT_SIDECAR_SCHEMA)
      : await requestDigestJson(
          [AFFECT_SIDECAR_PROMPT, DIGEST_PROMPTS.JSON_ONLY_SYSTEM],
          human,
          {
            temperature: 0.2,
            retries: 1,
            schema: AFFECT_SIDECAR_SCHEMA,
            schemaName: "digest_affect_sidecar",
          },
        );
    const valence = Number(parsed?.text_valence ?? parsed?.valence);
    const arousal = Number(parsed?.text_arousal ?? parsed?.arousal);
    const dominance = Number(parsed?.text_dominance ?? parsed?.dominance);
    if (![valence, arousal, dominance].every((value) => Number.isFinite(value))) return false;
    if (!isStillValid()) return false;
    const last = chunk.messages[chunk.messages.length - 1];
    if (last) {
      const exists = getDb()
        .prepare(
          `SELECT 1 FROM hippocampus_affect_points
           WHERE agent_id = ? AND user_id = ? AND turn_id = ? AND channel = 'text' LIMIT 1`,
        )
        .get(scope.agentId, scope.userId, Number(last.id));
      if (exists) return false;
    }
    applyTextAffect(
      scope,
      {
        valence: clampNumber(valence, -1, 1, 0),
        arousal: clampNumber(arousal, 0, 1, 0.5),
        dominance: clampNumber(dominance, 0, 1, 0.5),
        note: String(parsed?.note || "").trim().slice(0, 500),
      },
      {
        turnId: last ? Number(last.id) : null,
        createdAt: last?.created_at,
        source: "digest_affect_sidecar",
      },
    );
    return true;
  } catch (error) {
    recordBackgroundTaskEvent({
      eventType: "affect_sidecar",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    });
    return false;
  }
}

async function runAgentDigestOnce(
  scope: MemoryScope,
  token: MemoryTaskToken,
  options: AgentDigestOptions,
  source: string,
): Promise<DigestOnceResult | { skipped: string; sessionId?: number }> {
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:start",
    });
    return { skipped: "stale" };
  }
  const agent = readDigestAgent(scope.agentId);
  if (!agent) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "owner_deleted",
    });
    return { skipped: "orphaned_agent" };
  }
  const selected = selectDigestMessages(scope, options);
  if (!selected.rows.length) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "empty_recent_batch",
    });
    return { skipped: "empty_recent_batch" };
  }

  const userLabel = readUserLabel(scope.userId);
  const agentLabelRaw = String(agent.display_name || agent.name || "我").trim() || "我";
  const agentLabel = agentLabelRaw === userLabel ? "我" : agentLabelRaw;
  const roleBlock = String(agent.role_setting || "").trim();
  const knownFacts = readKnownFactsText(scope);
  const constraints = readConstraintCandidates(scope);
  const threads = listRelationshipThreadCandidates(scope);
  const timeAnchor = buildDigestTimeAnchor();
  const overhead = digestPromptOverheadTokens({
    userLabel,
    agentLabel,
    roleBlock,
    knownFacts,
    constraints,
    threads,
    timeAnchor,
  });
  const maxInputTokens = Math.max(
    4_096,
    Number(options.maxInputTokens) || DIGEST_CONSTANTS.DIGEST_MAX_INPUT_TOKENS,
  );
  const transcriptBudget = Math.max(4_096, maxInputTokens - overhead);
  const chunks = planDigestChunks(selected.rows, userLabel, agentLabel, transcriptBudget);
  if (!chunks.length) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "skipped",
      detail: "empty_recent_batch",
    });
    return { skipped: "empty_recent_batch" };
  }
  const chunk = chunks[0];
  const hasMore = selected.rowCapped || chunks.length > 1;

  // Episode is the immutable raw layer: create/reuse it before any derived
  // write so facts and streams can point back to the exact source text.
  const episode = createDigestEpisode(scope, chunk, source);
  const job = beginDigestJob({
    scope,
    fromMessageId: Number(chunk.messages[0]?.id),
    toMessageId: Number(chunk.messages[chunk.messages.length - 1]?.id),
    contentHash: episode.contentHash,
    extractorVersion: DIGEST_EXTRACTOR_VERSION,
    promptVersion: DIGEST_PROMPT_VERSION,
  });
  try {
    const result = await runDigestChunkBody(scope, token, options, source, {
      agent,
      userLabel,
      agentLabel,
      roleBlock,
      knownFacts,
      constraints,
      threads,
      timeAnchor,
      chunk,
      episode,
      hasMore,
    });
    finishDigestJob(job?.id ?? null, "skipped" in result ? "stale" : "done");
    return result;
  } catch (error) {
    finishDigestJob(job?.id ?? null, "failed", error);
    throw error;
  }
}

function createDigestEpisode(
  scope: MemoryScope,
  chunk: DigestChunk,
  source: string,
): EpisodeRecord {
  const parts: string[] = [];
  for (const message of chunk.messages) {
    // User turns replay `llm_content` (the exact text sent to the LLM), never
    // the display-layer `content`; assistant turns use `content`.
    const llmContent = String(message.llm_content ?? "");
    const text =
      message.role === "user" && llmContent.trim().length
        ? llmContent
        : String(message.content ?? "");
    parts.push(`[${message.role}] ${text}`);
  }
  const rawContent = parts.join("\n");
  const messageIds = chunk.messages.map((message) => Number(message.id));
  const contentHash = createHash("sha1")
    .update(
      `${scope.agentId}:${scope.userId}:${messageIds.join(",")}:${rawContent}`,
    )
    .digest("hex");
  const first = chunk.messages[0];
  const last = chunk.messages[chunk.messages.length - 1];
  return ensureEpisode({
    scope,
    threadId: first?.thread_id == null ? null : Number(first.thread_id),
    source: "chat",
    sourceDescription: `digest:${source}`,
    startedAt: String(first?.created_at || nowIso()),
    endedAt: String(last?.created_at || first?.created_at || nowIso()),
    referenceTime: String(last?.created_at || first?.created_at || nowIso()),
    rawContent,
    contentHash,
    messageIds,
  });
}

interface DigestChunkContext {
  agent: DigestAgentRow;
  userLabel: string;
  agentLabel: string;
  roleBlock: string;
  knownFacts: string;
  constraints: ReturnType<typeof readConstraintCandidates>;
  threads: RelationshipThreadCandidate[];
  timeAnchor: string;
  chunk: DigestChunk;
  episode: EpisodeRecord;
  hasMore: boolean;
}

async function runDigestChunkBody(
  scope: MemoryScope,
  token: MemoryTaskToken,
  options: AgentDigestOptions,
  source: string,
  ctx: DigestChunkContext,
): Promise<DigestOnceResult | { skipped: string; sessionId?: number }> {
  const { agent, chunk, episode, hasMore } = ctx;
  const extraction = await extractDigest(
    scope,
    chunk,
    {
      userLabel: ctx.userLabel,
      agentLabel: ctx.agentLabel,
      roleBlock: ctx.roleBlock,
      knownFacts: ctx.knownFacts,
      constraints: ctx.constraints,
      threads: ctx.threads,
    },
    options.complete,
  );
  await options.afterExtract?.();
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_extract",
    });
    return { skipped: "stale" };
  }
  await options.beforeCommit?.();
  // One batched ambiguity pass per chunk, before any fact write. It is a
  // best-effort side call: failures return an empty map and leave the
  // deterministic entity path untouched.
  const entityResolution = await resolveChunkEntityAmbiguities(
    scope,
    chunk,
    extraction.facts,
    options,
  );
  const streams = options.forceStreamFallback && !extraction.streams.length
    ? fallbackStreamsForChunk(chunk)
    : extraction.streams;
  const segmentRef = String(chunk.messages[chunk.messages.length - 1]?.id ?? "");

  // Constraints / facts / corrections first: a failure here must leave the
  // digest cursor untouched so the whole batch is retried.
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_write",
    });
    return { skipped: "stale" };
  }
  const db = getDb();
  const writeTx = db.transaction(() => {
    return applyConstraints(scope, extraction.constraints, segmentRef);
  });
  const constraintsProcessed = writeTx();
  const factsProcessed = await applyFacts(scope, extraction.facts, {
    segmentRef,
    episodeId: episode.id,
    episodeEndedAt: episode.endedAt,
    entityResolution,
    isStillValid: () => isMemoryTaskValid(token),
    embed: options.embed,
  });
  let correctionsProcessed = 0;
  if (isMemoryTaskValid(token)) {
    for (const correction of extraction.corrections) {
      correctionsProcessed += expireFactsByHint(scope, correction.targetHint);
    }
  }
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_write",
    });
    return { skipped: "stale" };
  }
  const writePhase = {
    constraintsProcessed,
    factsProcessed,
    correctionsProcessed,
  };

  const inserted = await insertDigestStreams(
    scope,
    chunk,
    streams,
    episode.id,
    options.embed,
    () => isMemoryTaskValid(token),
  );
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_streams",
    });
    return { skipped: "stale" };
  }
  const linked = await linkInsertedStreams(
    scope,
    inserted.map((stream) => ({ ...stream, episodeId: episode.id })),
    undefined,
    () => isMemoryTaskValid(token),
  );

  const continuityResult = await applyContinuity(
    scope,
    extraction.continuity,
    ctx.threads,
    chunk,
    () => isMemoryTaskValid(token),
  );

  // Final commit: row markers + high-water mark only after every write phase
  // succeeded. If the task was invalidated while embeddings were running, the
  // cursor must not move and the retry starts from the same batch.
  const committed = runIfMemoryTaskValid(token, () => {
    const db = getDb();
    return db.transaction(() => {
      const markedDigested = markTurnsDigested(chunk.messages.map((message) => Number(message.id)));
      const last = chunk.messages[chunk.messages.length - 1];
      if (last) advanceDigestState(scope, last.created_at, Number(last.id));
      return { markedDigested };
    })();
  });
  if (!committed) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_cursor",
    });
    return { skipped: "stale" };
  }

  // Independent affect sidecar: never part of the strict extractor schema and
  // never allowed to fail/block the digest result.
  await runAffectSidecar(scope, chunk, options.affectComplete, () => isMemoryTaskValid(token));

  let selfEvolutionEnabled = Boolean(agent.self_evolution_enabled);
  let personalitySeedAction = "noop";
  let personalitySeedId: string | null = null;
  let personalitySeedReason = selfEvolutionEnabled ? "" : "self_evolution_disabled";
  // Seed review is the most expensive sub-step; only run it on the last chunk
  // of a run, like the APP worker.
  if (selfEvolutionEnabled && !hasMore && isMemoryTaskValid(token)) {
    try {
      const { runPersonalitySeedDigest } = await import("./personalitySeedDigestService.js");
      const personality = await runPersonalitySeedDigest({
        agentId: scope.agentId,
        userId: scope.userId,
        transcript: chunk.transcript,
        roleSetting: String(agent.role_setting || ""),
        contextTranscript: contextTranscriptBefore(
          Number(chunk.messages[0]?.thread_id),
          Number(chunk.messages[0]?.id),
        ),
        sessionId: Number(chunk.messages[0]?.thread_id) || null,
        turnIds: chunk.messages.map((message) => Number(message.id)),
        batchKey: seedReviewBatchKey(
          scope.agentId,
          scope.userId,
          chunk.messages.map((message) => Number(message.id)),
        ),
        guard: () => isMemoryTaskValid(token),
      });
      personalitySeedAction = personality.action;
      personalitySeedId = personality.seedId;
      personalitySeedReason = personality.reason;
    } catch (error) {
      personalitySeedReason = `self_evolution_failed:${
        error instanceof Error ? error.name || "Error" : "unknown"
      }`;
      console.warn("[SELF_EVOLUTION_REVIEW] digest hook failed", {
        agentId: scope.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const seedsCreated = personalitySeedAction === "create" ? 1 : 0;
  const seedsReinforced = ["reinforce", "merge", "revise"].includes(personalitySeedAction) ? 1 : 0;
  const seedsSkipped = personalitySeedAction === "noop" && selfEvolutionEnabled ? 1 : 0;

  const stillValidAfterSeedReview = isMemoryTaskValid(token);
  if (!stillValidAfterSeedReview) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:after_seed_review",
    });
    return { skipped: "stale" };
  }
  persistSelfStateSnapshot(scope, {
    trigger: source,
    turnId: Number(segmentRef) || null,
  });
  logTick(scope, source, "digested", {
    agentId: scope.agentId,
    episodeId: episode.id,
    messageIds: chunk.messages.map((message) => Number(message.id)),
    markedDigested: committed.markedDigested,
    streamsWritten: inserted.length,
    akinEdges: linked,
    factsProcessed: writePhase.factsProcessed,
    constraintsProcessed: writePhase.constraintsProcessed,
    continuityApplied: continuityResult.threadsCreated + continuityResult.threadsUpdated,
    hasMore,
    personalitySeedAction,
    personalitySeedId,
    personalitySeedReason,
    transcript: chunk.transcript.slice(0, 4000),
  });
  scheduleWitnessAfterDigest(scope);
  recordBackgroundTaskEvent({
    eventType: "digest",
    subjectType: "agent",
    subjectId: String(scope.agentId),
    status: "succeeded",
    detail: `episode=${episode.id} · streams=${inserted.length} · facts=${writePhase.factsProcessed} · messages=${chunk.messages.length}${
      hasMore ? " · 分批继续" : ""
    }`,
  });

  return {
    agentId: scope.agentId,
    userId: scope.userId,
    sessionId: Number(chunk.messages[0]?.thread_id) || undefined,
    turnIds: chunk.messages.map((message) => Number(message.id)),
    turnCount: chunk.messages.filter((message) => message.role === "assistant").length,
    markedDigested: committed.markedDigested,
    streamsWritten: inserted.length,
    streamsSource: options.forceStreamFallback && !extraction.streams.length ? "fallback" : "llm",
    factsProcessed: writePhase.factsProcessed,
    constraintsProcessed: writePhase.constraintsProcessed,
    continuityApplied: continuityResult.threadsCreated + continuityResult.threadsUpdated,
    threadsCreated: continuityResult.threadsCreated,
    threadsUpdated: continuityResult.threadsUpdated,
    touchpointsWritten: continuityResult.touchpointsWritten,
    selfEvolutionEnabled,
    personalitySeedAction,
    personalitySeedId,
    personalitySeedReason,
    seedsCreated,
    seedsReinforced,
    seedsSkipped,
    batchesRun: 1,
    hasMore,
  };
}

/**
 * Agent+user private digest. One call processes at most
 * DIGEST_MAX_CHUNKS_PER_RUN token-bounded batches; every batch advances the
 * high-water mark on its own so a mid-run failure never redoes committed work.
 */
export async function runAgentDigest(
  agentId: number,
  userId?: string | null,
  options: AgentDigestOptions = {},
): Promise<AgentDigestResult> {
  const scope = memoryScope(agentId, userId);
  const token = options.taskToken ?? beginMemoryTask(scope.agentId, scope.userId);
  if (!isMemoryTaskValid(token)) {
    recordBackgroundTaskEvent({
      eventType: "digest",
      subjectType: "agent",
      subjectId: String(scope.agentId),
      status: "stale",
      detail: "invalidated_by_clear:before_start",
    });
    return { skipped: "stale" };
  }
  const source = String(options.source || "layer1_silent");
  const maxChunks = Math.max(
    1,
    Math.min(Number(options.maxChunks) || DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN, DIGEST_CONSTANTS.DIGEST_MAX_CHUNKS_PER_RUN),
  );
  const aggregate: DigestRunResult = {
    agentId: scope.agentId,
    userId: scope.userId,
    turnIds: [],
    turnCount: 0,
    markedDigested: 0,
    streamsWritten: 0,
    streamsSource: "llm",
    factsProcessed: 0,
    constraintsProcessed: 0,
    continuityApplied: 0,
    threadsCreated: 0,
    threadsUpdated: 0,
    touchpointsWritten: 0,
    selfEvolutionEnabled: false,
    personalitySeedAction: "noop",
    personalitySeedId: null,
    personalitySeedReason: "",
    seedsCreated: 0,
    seedsReinforced: 0,
    seedsSkipped: 0,
    batchesRun: 0,
    hasMore: false,
  };
  for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
    let result: DigestOnceResult | { skipped: string; sessionId?: number };
    try {
      result = await runAgentDigestOnce(scope, token, options, source);
    } catch (error) {
      recordBackgroundTaskEvent({
        eventType: "digest",
        subjectType: "agent",
        subjectId: String(scope.agentId),
        status: "failed",
        detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      });
      throw error;
    }
    if ("skipped" in result) {
      if (chunkIndex === 0) return result;
      break;
    }
    aggregate.turnIds.push(...result.turnIds);
    aggregate.turnCount += result.turnCount;
    aggregate.markedDigested += result.markedDigested;
    aggregate.streamsWritten += result.streamsWritten;
    aggregate.factsProcessed += result.factsProcessed;
    aggregate.constraintsProcessed += result.constraintsProcessed;
    aggregate.continuityApplied += result.continuityApplied;
    aggregate.threadsCreated += result.threadsCreated;
    aggregate.threadsUpdated += result.threadsUpdated;
    aggregate.touchpointsWritten += result.touchpointsWritten;
    aggregate.selfEvolutionEnabled = result.selfEvolutionEnabled;
    aggregate.personalitySeedAction = result.personalitySeedAction;
    aggregate.personalitySeedId = result.personalitySeedId;
    aggregate.personalitySeedReason = result.personalitySeedReason;
    aggregate.seedsCreated += result.seedsCreated;
    aggregate.seedsReinforced += result.seedsReinforced;
    aggregate.seedsSkipped += result.seedsSkipped;
    aggregate.batchesRun += 1;
    aggregate.hasMore = result.hasMore;
    aggregate.sessionId = result.sessionId;
    if (!result.hasMore) break;
  }
  return aggregate;
}

/**
 * Compatibility entry point for callers that still address a thread. Digest is
 * now agent+user scoped: resolving the thread's owner and digesting the whole
 * pair's pending private messages (all threads of that pair).
 */
export async function runThreadDigest(
  threadId: number,
  options: {
    maxPairs?: number;
    maxChunks?: number;
    maxRows?: number;
    maxInputTokens?: number;
    source?: string;
    forceStreamFallback?: boolean;
    since?: string | null;
    complete?: DigestComplete;
    entityComplete?: DigestComplete;
    embed?: (text: string) => Promise<number[]>;
    afterExtract?: () => void | Promise<void>;
    beforeCommit?: () => void | Promise<void>;
  } = {},
): Promise<DigestRunResult | { skipped: string; sessionId?: number }> {
  const thread = getDb()
    .prepare("SELECT id, agent_id, user_id FROM chat_threads WHERE id = ?")
    .get(threadId) as { id: number; agent_id: number; user_id: string } | undefined;
  if (!thread) return { skipped: "no_thread", sessionId: threadId };
  const result = await runAgentDigest(thread.agent_id, thread.user_id, {
    ...options,
    maxChunks: options.maxChunks ?? 1,
  });
  if ("skipped" in result) return { ...result, sessionId: threadId };
  return { ...result, sessionId: threadId };
}

function entityNarrative(name: string, entityType: string): string {
  if (entityType === "self") {
    return "Canonical identity anchor for the agent in this pair";
  }
  if (entityType === "user") {
    return `Entity representing ${name}`;
  }
  return `Value entity representing ${name}`;
}

function storeEntityEmbedding(entityId: string, vector: number[]) {
  const db = getDb();
  const buffer = vectorToBuffer(vector);
  db.prepare(
    "UPDATE hippocampus_entities SET embedding = ?, embedding_dim = ? WHERE id = ?",
  ).run(buffer, vector.length, entityId);
  try {
    db.prepare("DELETE FROM entity_vec WHERE entity_id = ?").run(entityId);
    db.prepare("INSERT INTO entity_vec (entity_id, embedding) VALUES (?, ?)").run(
      entityId,
      buffer,
    );
  } catch {
    // vec0 extension unavailable; the exact scan over hippocampus_entities still works.
  }
}

function normalizeEntityAlias(value: string): string {
  // NFKC folds full-width/half-width forms; trim + lower keeps " 小明 " and
  // "小明" on one alias hash without touching the stored display name.
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function entityAliasHash(scope: MemoryScope, aliasNorm: string): string {
  return createHash("sha1")
    .update(`${scope.agentId}:${scope.userId}:${aliasNorm}`)
    .digest("hex");
}

function followEntityMerge(scope: MemoryScope, entityId: string): string {
  const db = getDb();
  let current = entityId;
  for (let depth = 0; depth < 8; depth += 1) {
    const row = db
      .prepare(
        "SELECT merged_into_id FROM hippocampus_entities WHERE id = ? AND agent_id = ? AND user_id = ?",
      )
      .get(current, scope.agentId, scope.userId) as { merged_into_id: string | null } | undefined;
    if (!row?.merged_into_id) return current;
    current = String(row.merged_into_id);
  }
  return current;
}

function writeEntityAlias(
  scope: MemoryScope,
  entityId: string,
  alias: string,
  sourceEpisodeId: string | null | undefined,
): void {
  const aliasNorm = normalizeEntityAlias(alias);
  if (!aliasNorm) return;
  getDb()
    .prepare(
      `INSERT INTO hippocampus_entity_aliases
        (id, agent_id, user_id, entity_id, alias, alias_norm, alias_hash, source_episode_id,
         confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?)
       ON CONFLICT(agent_id, user_id, entity_id, alias_hash) DO UPDATE SET
         alias = excluded.alias,
         source_episode_id = COALESCE(
           hippocampus_entity_aliases.source_episode_id,
           excluded.source_episode_id
         )`,
    )
    .run(
      `alias-${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      scope.agentId,
      scope.userId,
      entityId,
      alias,
      aliasNorm,
      entityAliasHash(scope, aliasNorm),
      sourceEpisodeId ?? null,
      nowIso(),
    );
}

interface EnsureEntityOptions {
  kind?: EntityKind;
  /** LLM-resolved existing entity; validated against scope/kind/role before reuse. */
  entityId?: string | null;
  /** LLM-resolved new entity; skip alias/legacy reuse and mint a random id. */
  forceNew?: boolean;
  sourceEpisodeId?: string | null;
  isStillValid?: () => boolean;
  embed?: (text: string) => Promise<number[]>;
}

interface EntityIdentityRow {
  id: string;
  type: string | null;
  kind: string | null;
  narrative: string | null;
  embedding: Buffer | null;
}

function loadEntityIdentity(id: string): EntityIdentityRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, type, kind, narrative, embedding FROM hippocampus_entities WHERE id = ?",
    )
    .get(id) as EntityIdentityRow | undefined;
}

function loadEntityIdentityInScope(
  scope: MemoryScope,
  id: string,
): EntityIdentityRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, type, kind, narrative, embedding
         FROM hippocampus_entities
        WHERE id = ? AND agent_id = ? AND user_id = ?`,
    )
    .get(id, scope.agentId, scope.userId) as EntityIdentityRow | undefined;
}

/**
 * Under-merge guard: a single alias candidate is only reused when its known
 * role/kind does not contradict the incoming entity. "other"/unknown is a
 * wildcard; two specific values that differ are treated as different things.
 */
function entityIdentityCompatible(
  row: EntityIdentityRow,
  role: string,
  kind: EntityKind,
): boolean {
  const existingRole = String(row.type || "").toLowerCase();
  const existingKind = String(row.kind || "").toLowerCase();
  const requestedKind = String(kind || "other").toLowerCase();
  if (["user", "self"].includes(existingRole) && ["user", "self"].includes(role)) {
    if (existingRole !== role) return false;
  }
  if (
    existingKind &&
    existingKind !== "other" &&
    requestedKind !== "other" &&
    existingKind !== requestedKind
  ) {
    return false;
  }
  return true;
}

/**
 * LLM entity-resolution verdict for one ambiguous mention. Internal to the
 * digest write path; `applyFacts` forwards it to `ensureEntity`.
 */
interface EntityResolutionDecision {
  entityId?: string;
  forceNew?: boolean;
}

interface EntityCandidate {
  id: string;
  name: string;
  type: string | null;
  kind: string | null;
  description: string | null;
  narrative: string | null;
  summary: string | null;
  /** Descriptions of the most recent current facts touching this entity. */
  recentFacts: string[];
}

interface EntityResolutionMention {
  name: string;
  normalizedName: string;
  kind: EntityKind;
  role: string;
  /** All compatible same-name candidates, not just one. */
  candidates: EntityCandidate[];
}

const ENTITY_RESOLVE_TRANSCRIPT_MAX_CHARS = 6000;
const ENTITY_CANDIDATE_LIMIT = 5;
const ENTITY_CANDIDATE_RECENT_FACTS = 3;
const ENTITY_RESOLVE_TIMEOUT_MS = 30_000;

function withEntityResolutionTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("entity_resolve_timeout")),
        ENTITY_RESOLVE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * Deictic anchors are never ambiguous: they always denote the user/agent
 * themselves and must not reach the resolver. Mirrors `factSubjectName` and
 * the extractor's placeholder set.
 */
const ENTITY_RESOLUTION_ANCHORS = new Set(
  [
    "他",
    "她",
    "我",
    "你",
    "me",
    "self",
    "用户",
    "本人",
    "ta",
    "user",
    "i",
    "myself",
    "助手",
    "agent",
    "assistant",
  ].map((value) => normalizeEntityAlias(value)),
);

function isEntityResolutionAnchor(name: string): boolean {
  return ENTITY_RESOLUTION_ANCHORS.has(normalizeEntityAlias(name));
}

const ENTITY_RESOLVE_PROMPT = `你是长期记忆系统的实体消歧器。输入是一段对话和若干待消歧的实体提及；每个提及有一个或多个同名、同 kind/role 的候选实体。你要判断：这段对话里提到的，是已有的某个实体，还是一个恰好同名的新实体（新的人、地点、宠物、对象等）。

判定规则：
1. 宁可判 new（under-merge），不要错误合并。把两个不同的人合成一个实体会永久污染记忆；多建一个实体只是冗余。
2. 只有当前对话提供了明确、具体、可核对的证据，表明就是候选实体（相同的身份、关系、经历、地点等），才判 existing。
3. 仅仅同名、同 kind、语气相似、话题相近，都不足以判 existing。
4. 不确定时一律判 new。
5. 只输出 JSON：{"resolutions":[{"name":"...","decision":"existing|new","entity_id":"..."}]}。existing 必须带候选列表里出现过的 entity_id；new 不需要 entity_id。`;

const ENTITY_RESOLVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["resolutions"],
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "decision"],
        properties: {
          name: { type: "string" },
          decision: { type: "string", enum: ["existing", "new"] },
          entity_id: { type: "string" },
        },
      },
    },
  },
} as Record<string, unknown>;

function loadEntityCandidateRow(
  scope: MemoryScope,
  entityId: string,
): Omit<EntityCandidate, "recentFacts"> | undefined {
  return getDb()
    .prepare(
      `SELECT id, name, type, kind, description, narrative, summary
         FROM hippocampus_entities
        WHERE id = ? AND agent_id = ? AND user_id = ?`,
    )
    .get(entityId, scope.agentId, scope.userId) as
    | Omit<EntityCandidate, "recentFacts">
    | undefined;
}

function recentEntityFactDescriptions(scope: MemoryScope, entityId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT description
           FROM hippocampus_facts
          WHERE agent_id = ? AND user_id = ? AND status = 'current'
            AND (from_entity_id = ? OR to_entity_id = ?)
            AND description IS NOT NULL AND TRIM(description) != ''
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(
        scope.agentId,
        scope.userId,
        entityId,
        entityId,
        ENTITY_CANDIDATE_RECENT_FACTS,
      ) as { description: string | null }[]
  )
    .map((row) => String(row.description || "").trim())
    .filter(Boolean);
}

/**
 * Same-name candidate discovery for entity resolution. Both alias rows and the
 * legacy `hippocampus_entities.name` rows are searched: pre-v23 data has
 * entities without aliases. Merged rows are canonicalised and de-duplicated.
 */
export function findEntityCandidatesForName(
  scope: MemoryScope,
  name: string,
  kind: EntityKind,
  role: string,
): EntityCandidate[] {
  const normalized = String(name || "")
    .trim()
    .slice(0, DIGEST_CONSTANTS.ENTITY_NAME_MAX_LEN);
  if (!normalized) return [];
  // `kind`/`role` stay in the contract so callers can reason about the
  // mention; compatibility is checked by the resolver. Filtering here would
  // hide a second same-name row and turn an under-merge case into an LLM
  // question.
  void kind;
  void role;
  const db = getDb();
  const aliasHash = entityAliasHash(scope, normalizeEntityAlias(normalized));
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, e.kind AS kind,
              e.description AS description, e.narrative AS narrative, e.summary AS summary
         FROM hippocampus_entity_aliases a
         JOIN hippocampus_entities e ON e.id = a.entity_id
        WHERE a.agent_id = ? AND a.user_id = ? AND a.alias_hash = ?
       UNION
       SELECT e.id, e.name, e.type, e.kind, e.description, e.narrative, e.summary
         FROM hippocampus_entities e
        WHERE e.agent_id = ? AND e.user_id = ? AND e.name = ?
        ORDER BY name ASC
        LIMIT 25`,
    )
    .all(
      scope.agentId,
      scope.userId,
      aliasHash,
      scope.agentId,
      scope.userId,
      normalized,
    ) as Omit<EntityCandidate, "recentFacts">[];

  const candidates: EntityCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const canonicalId = followEntityMerge(scope, String(row.id));
    if (seen.has(canonicalId)) continue;
    const canonical =
      canonicalId === row.id ? row : loadEntityCandidateRow(scope, canonicalId);
    if (!canonical) continue;
    seen.add(canonicalId);
    candidates.push({
      ...canonical,
      id: canonicalId,
      recentFacts: recentEntityFactDescriptions(scope, canonicalId),
    });
    if (candidates.length >= ENTITY_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

function entityCandidatePromptBlock(candidate: EntityCandidate): string {
  const clip = (value: string | null | undefined, max = 600): string =>
    String(value || "").trim().slice(0, max);
  const lines = [
    `    - id: ${candidate.id}`,
    `      name: ${candidate.name}`,
    `      kind: ${candidate.kind || "other"} / role: ${candidate.type || "other"}`,
  ];
  const description = clip(candidate.description);
  const narrative = clip(candidate.narrative);
  const summary = clip(candidate.summary);
  if (description) lines.push(`      description: ${description}`);
  if (narrative) lines.push(`      narrative: ${narrative}`);
  if (summary) lines.push(`      summary: ${summary}`);
  if (candidate.recentFacts.length) {
    lines.push("      最近事实:");
    for (const fact of candidate.recentFacts) lines.push(`        - ${clip(fact, 400)}`);
  } else {
    lines.push("      最近事实: （无）");
  }
  return lines.join("\n");
}

function buildEntityResolutionHumanPrompt(
  chunk: DigestChunk,
  mentions: EntityResolutionMention[],
): string {
  const transcript = String(chunk.transcript || "").trim();
  const clippedTranscript =
    transcript.length > ENTITY_RESOLVE_TRANSCRIPT_MAX_CHARS
      ? `${transcript.slice(0, ENTITY_RESOLVE_TRANSCRIPT_MAX_CHARS)}\n（对话过长，后续已截断）`
      : transcript;
  const mentionBlocks = mentions.map((mention, index) =>
    [
      `[${index + 1}] name: ${mention.name}`,
      `    kind: ${mention.kind} / role: ${mention.role}`,
      "    候选实体:",
      mention.candidates.map((candidate) => entityCandidatePromptBlock(candidate)).join("\n"),
    ].join("\n"),
  );
  return [
    "对话记录：",
    clippedTranscript || "（无）",
    "",
    "待消歧提及（每个名字有一个或多个同名同 kind/role 的候选）：",
    mentionBlocks.join("\n\n"),
    "",
    "判定规则：宁可判 new（under-merge），不要错误合并；只有上下文明确指向同一实体时才判 existing；不确定就判 new。",
    '只输出 JSON：{"resolutions":[{"name":"...","decision":"existing|new","entity_id":"..."}]}。',
  ].join("\n");
}

/**
 * One batched LLM resolution per digest chunk, before facts are written.
 * Only names with exactly one compatible same-name candidate are sent: zero
 * candidates need no decision, and multiple candidates keep the existing
 * under-merge path (create a new entity without asking the LLM).
 *
 * Any failure returns an empty map so `ensureEntity` falls back to its
 * deterministic alias/legacy logic; digest is never blocked.
 */
export async function resolveChunkEntityAmbiguities(
  scope: MemoryScope,
  chunk: DigestChunk,
  facts: ExtractedFact[],
  options: AgentDigestOptions,
): Promise<Map<string, EntityResolutionDecision>> {
  const decisions = new Map<string, EntityResolutionDecision>();
  if (!facts.length) return decisions;

  const mentions = new Map<string, EntityResolutionMention>();
  for (const fact of facts) {
    if (!(DIGEST_SETS.FACT_RELATIONS as readonly string[]).includes(fact.relation)) continue;
    const coerced = coerceNameFact(fact);
    if (!coerced) continue;
    // The source side is always the user/agent anchor after `factSubjectName`;
    // only fact targets can be ambiguous entities.
    const targetName = String(coerced.object || coerced.subject || "").trim();
    if (!targetName || isEntityResolutionAnchor(targetName)) continue;
    const normalizedName = normalizeEntityAlias(targetName);
    if (!normalizedName || mentions.has(normalizedName)) continue;
    const kind = entityKindForRelation(coerced.relation);
    const role = "other";
    const candidates = findEntityCandidatesForName(scope, targetName, kind, role)
      .filter((candidate) =>
        entityIdentityCompatible(
          {
            id: candidate.id,
            type: candidate.type,
            kind: candidate.kind,
            narrative: candidate.narrative,
            embedding: null,
          },
          role,
          kind,
        ),
      )
      .slice(0, ENTITY_CANDIDATE_LIMIT);
    if (!candidates.length) continue;
    mentions.set(normalizedName, {
      name: targetName,
      normalizedName,
      kind,
      role,
      candidates,
    });
  }
  if (!mentions.size) return decisions;

  // An injected extractor mock returns extraction JSON, not resolutions; never
  // feed it into the resolver. Production has neither hook and uses the real
  // memory LLM.
  if (!options.entityComplete && options.complete) return decisions;

  const human = buildEntityResolutionHumanPrompt(chunk, [...mentions.values()]);
  let parsed: any;
  try {
    const request = options.entityComplete
      ? options.entityComplete(ENTITY_RESOLVE_PROMPT, human, ENTITY_RESOLVE_SCHEMA)
      : requestDigestJson(ENTITY_RESOLVE_PROMPT, human, {
          schema: ENTITY_RESOLVE_SCHEMA,
          schemaName: "entity_resolve",
          temperature: 0.1,
          retries: 1,
        });
    parsed = await withEntityResolutionTimeout(request);
  } catch (error) {
    console.warn("[MEMORY_ENTITY_RESOLVE] failed; using deterministic entity path", {
      agentId: scope.agentId,
      userId: scope.userId,
      message: error instanceof Error ? error.message : String(error),
    });
    return decisions;
  }

  const rawResolutions = Array.isArray(parsed?.resolutions) ? parsed.resolutions : [];
  if (!rawResolutions.length) return decisions;
  for (const item of rawResolutions) {
    const key = normalizeEntityAlias(String(item?.name || ""));
    const mention = mentions.get(key);
    if (!mention) continue;
    const decision = String(item?.decision || "").toLowerCase();
    const entityId = String(item?.entity_id ?? item?.entityId ?? "").trim();
    const candidateIds = new Set(mention.candidates.map((candidate) => candidate.id));
    if (decision === "existing" && entityId && candidateIds.has(entityId)) {
      decisions.set(key, { entityId });
    } else {
      // "new", or an existing verdict that does not name one of the candidates.
      decisions.set(key, { forceNew: true });
    }
  }
  return decisions;
}

async function ensureEntity(
  scope: MemoryScope,
  name: string,
  options: EnsureEntityOptions = {},
): Promise<string | null> {
  const db = getDb();
  const normalized = name.trim().slice(0, DIGEST_CONSTANTS.ENTITY_NAME_MAX_LEN);
  const role = ["他", "Me", "me", "用户", "ta"].includes(normalized)
    ? "user"
    : ["她", "Self", "self", "我"].includes(normalized)
      ? "self"
      : "other";
  const kind: EntityKind =
    options.kind ?? (role === "user" || role === "self" ? "person" : "other");
  // Legacy identity only: old rows were created as sha1(name). New rows use a
  // random id, because a name hash is not an identity (two 小明 are legal).
  const legacyId = `entity-${createHash("sha1")
    .update(`${scope.agentId}:${scope.userId}:${normalized}`)
    .digest("hex")
    .slice(0, 20)}`;
  const aliasNorm = normalizeEntityAlias(normalized);
  const aliasHash = entityAliasHash(scope, aliasNorm);

  let id: string | null = null;
  let allowLegacyLookup = true;

  if (options.entityId) {
    // LLM decision: this mention is an existing entity. Only trust the exact
    // scoped row and only if its kind/role still fits; otherwise under-merge
    // (create a fresh entity) rather than silently recycling another 小明.
    const candidateId = followEntityMerge(scope, String(options.entityId));
    const candidate = loadEntityIdentityInScope(scope, candidateId);
    if (candidate && entityIdentityCompatible(candidate, role, kind)) {
      id = candidateId;
    }
    allowLegacyLookup = false;
  } else if (options.forceNew) {
    // LLM decision: same name but a different entity. Skip every reuse path.
    allowLegacyLookup = false;
  } else {
    // 1) Alias exact hit. One compatible candidate is safe to reuse; multiple
    //    candidates are the legal "same name, different person/object" state, so
    //    we deliberately under-merge and create a new entity.
    const aliasMatches = db
      .prepare(
        `SELECT DISTINCT e.id AS entity_id, e.type, e.kind
         FROM hippocampus_entity_aliases a
         JOIN hippocampus_entities e ON e.id = a.entity_id
         WHERE a.agent_id = ? AND a.user_id = ? AND a.alias_hash = ?
         LIMIT 2`,
      )
      .all(scope.agentId, scope.userId, aliasHash) as {
      entity_id: string;
      type: string | null;
      kind: string | null;
    }[];
    allowLegacyLookup = aliasMatches.length === 0;
    if (aliasMatches.length === 1) {
      const candidateId = followEntityMerge(scope, String(aliasMatches[0].entity_id));
      const candidate = loadEntityIdentity(candidateId);
      if (candidate && entityIdentityCompatible(candidate, role, kind)) {
        id = candidateId;
      } else {
        // The only alias candidate is a different kind/role: do not recycle it.
        allowLegacyLookup = false;
      }
    }

    // 2) Deterministic name-hash lookup for pre-v23 rows only. New entities never
    //    receive this id.
    if (!id && allowLegacyLookup) {
      const row = db
        .prepare("SELECT id FROM hippocampus_entities WHERE id = ? AND agent_id = ? AND user_id = ?")
        .get(legacyId, scope.agentId, scope.userId) as { id: string } | undefined;
      if (row) {
        const candidateId = followEntityMerge(scope, String(row.id));
        const candidate = loadEntityIdentity(candidateId);
        if (candidate && entityIdentityCompatible(candidate, role, kind)) {
          id = candidateId;
        }
      }
    }
  }

  const entityType = role;
  const narrative = entityNarrative(normalized, entityType);
  const existing = id ? loadEntityIdentity(id) : undefined;

  if (existing) {
    if (options.isStillValid && !options.isStillValid()) return null;
    id = String(existing.id);
    // Backfill embeddings for entities written before v14, promote role
    // anchors from "other" to user/self and fill a more specific kind.
    let narrativeChanged = false;
    const typeNeedsUpdate = entityType !== "other" && existing.type === "other";
    const kindNeedsUpdate =
      kind !== "other" && (!existing.kind || String(existing.kind) === "other");
    if (typeNeedsUpdate || kindNeedsUpdate) {
      db.prepare(
        `UPDATE hippocampus_entities
         SET type = ?, kind = ?, narrative = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        typeNeedsUpdate ? entityType : existing.type || entityType,
        kindNeedsUpdate ? kind : existing.kind || kind,
        typeNeedsUpdate ? narrative : existing.narrative || narrative,
        nowIso(),
        id,
      );
      narrativeChanged = typeNeedsUpdate;
    }
    const hasEmbedding =
      Boolean(existing.embedding) &&
      bufferToVector(existing.embedding).some((value) => Math.abs(value) > 1e-12);
    if (!hasEmbedding || !existing.narrative || narrativeChanged) {
      const vector = options.embed
        ? await options.embed(narrative)
        : (await embedText(narrative, { wait: true })).vector;
      if (options.isStillValid && !options.isStillValid()) return null;
      storeEntityEmbedding(id, vector);
      db.prepare(
        "UPDATE hippocampus_entities SET narrative = ?, updated_at = ? WHERE id = ?",
      ).run(narrative, nowIso(), id);
    }
    writeEntityAlias(scope, id, normalized, options.sourceEpisodeId);
    return id;
  }

  // 3) Create a new entity under a random id. Embedding is a hard dependency:
  //    a missing ONNX model throws 503 before any partial row.
  const vector = options.embed
    ? await options.embed(narrative)
    : (await embedText(narrative, { wait: true })).vector;
  if (options.isStillValid && !options.isStillValid()) return null;
  const now = nowIso();
  const newId = `entity-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    newId,
    scope.agentId,
    scope.userId,
    normalized,
    entityType,
    kind,
    narrative,
    vectorToBuffer(vector),
    vector.length,
    now,
    now,
  );
  storeEntityEmbedding(newId, vector);
  writeEntityAlias(scope, newId, normalized, options.sourceEpisodeId);
  return newId;
}

async function relinkSingleStream(scope: MemoryScope, streamId: string, vector: number[]) {
  const focal = getDb()
    .prepare("SELECT narrative FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(streamId, scope.agentId, scope.userId) as { narrative: string } | undefined;
  if (!focal?.narrative) return;
  // Shared bidirectional writer: relinking must produce the same two edge rows
  // as the digest path, otherwise one endpoint would silently lose the link.
  await linkStreamToExistingMemory(scope, {
    id: streamId,
    narrative: focal.narrative,
    vector,
  });
}

const DIRECT_RECALL_LIMIT = 4;
const ANN_CANDIDATE_LIMIT = 12;
// Total cap on the merged recall set, matching Python's RECALL_TOTAL_CAP.
/**
 * Stream recall constants come from the native chat contract (APP
 * `shared/native-chat/source.mjs::STREAM`) — single source of truth, do not
 * restate the numbers here. Semantics:
 *  - RANK1_FLOOR (0.52) is the abstention gate for the whole turn's first hit;
 *    TAIL_FLOOR (0.45) applies from the second hit on.
 *  - Private pool (DIRECT_LIMIT=4) and public pool (PUBLIC_LIMIT=3) fill their
 *    quotas independently, so a public memory can never evict a private one.
 *  - PUBLIC_FLOOR_BOOST (1.2) relaxes only the public pool's own entry floor
 *    (raw × 1.2 >= floor); display and ordering keep the raw cosine.
 *  - CURRENT_MESSAGE_BOOST (1.2) tilts the *order* toward what he just said,
 *    and never relaxes an entry floor.
 *  - TOTAL_CAP (10) bounds the recall layer (direct + AKIN); the prompt merge
 *    caps again at PRIVATE_STREAM_MERGE_LIMIT (8, or 6 + 2 state on state-only
 *    turns) when rendering.
 */
export const RECALL_TOTAL_CAP = CHAT_STREAM.TOTAL_CAP;
export const STREAM_RANK1_FLOOR = CHAT_STREAM.RANK1_FLOOR;
export const STREAM_TAIL_FLOOR = CHAT_STREAM.TAIL_FLOOR;
export const STREAM_DIRECT_LIMIT = CHAT_STREAM.DIRECT_LIMIT;
export const STREAM_PUBLIC_LIMIT = CHAT_STREAM.PUBLIC_LIMIT;
export const STREAM_PUBLIC_FLOOR_BOOST = CHAT_STREAM.PUBLIC_FLOOR_BOOST;
export const STREAM_CURRENT_MESSAGE_BOOST = CHAT_STREAM.CURRENT_MESSAGE_BOOST;
export const PRIVATE_STREAM_MERGE_LIMIT = 8;
const RELATED_SEED_ANCHORS = CHAT_STREAM.RELATED_SEED_ANCHORS;
const RELATED_SLICE_FLOOR = CHAT_STREAM.RELATED_SLICE_FLOOR;
const RELATED_LIMIT = CHAT_STREAM.RELATED_LIMIT;
const EXPANDED_QUERY_FLOOR = CHAT_STREAM.EXPANDED_QUERY_FLOOR;
const AKIN_FIRST_HOP_LIMIT = CHAT_STREAM.AKIN_FIRST_HOP_LIMIT;
const AKIN_SECOND_HOP_PER_NODE = CHAT_STREAM.AKIN_SECOND_HOP_PER_NODE;
const DIRECT_RECALL_FLOOR = STREAM_RANK1_FLOOR;

/** Group / theater memories come from their own public pool, never the private one. */
function isPublicStreamScope(originScope: string | null | undefined): boolean {
  const scope = String(originScope || "").trim();
  return scope === "group_public" || scope === "theater_public";
}

function streamRowsByIds(ids: string[]): any[] {
  if (!ids.length) return [];
  return getDb()
    .prepare(
      `SELECT * FROM hippocampus_streams WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as any[];
}

function streamSimilarity(row: any, vectors: number[][]): number {
  let best = 0;
  const embedding = bufferToVector(row.embedding);
  for (const vector of vectors) best = Math.max(best, cosineSimilarity(vector, embedding));
  return best;
}

function akinNeighborIds(streamId: string, scope: MemoryScope): string[] {
  const rows = getDb()
    .prepare(
      `SELECT target_id AS id FROM hippocampus_edges
       WHERE source_id = ? AND edge_type = 'AKIN' AND agent_id = ? AND user_id = ?
       UNION
       SELECT source_id AS id FROM hippocampus_edges
       WHERE target_id = ? AND edge_type = 'AKIN' AND agent_id = ? AND user_id = ?`,
    )
    .all(streamId, scope.agentId, scope.userId, streamId, scope.agentId, scope.userId) as {
    id: string;
  }[];
  return [...new Set(rows.map((row) => row.id))];
}

/**
 * AKIN neighbours of a stream without an agent/user scope.
 *
 * The narrative-cluster route resolves the stream by id alone, so its
 * neighbours have to be looked up the same way — otherwise a cluster opened
 * from a deep link would silently come back empty.
 */
function akinNeighborIdsById(streamId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT target_id AS id FROM hippocampus_edges
       WHERE source_id = ? AND edge_type = 'AKIN'
       UNION
       SELECT source_id AS id FROM hippocampus_edges
       WHERE target_id = ? AND edge_type = 'AKIN'`,
    )
    .all(streamId, streamId) as { id: string }[];
  return [...new Set(rows.map((row) => row.id))];
}

function recallCandidatePayload(
  row: any,
  similarity: number,
  selected: boolean,
  kind: string,
  reason = "",
) {
  return {
    id: String(row.id),
    narrative: String(row.narrative || ""),
    about: String(row.about || ""),
    type: String(row.type || "external"),
    similarity: Number(similarity.toFixed(4)),
    selected,
    kind,
    reason,
  };
}

/**
 * One ANN pass per query vector, merged by best raw cosine per stream id.
 *
 * Mirrors the APP merge (`mergeJsonByBestDistance`): the same id hit by several
 * query vectors keeps its highest raw similarity, and `fromCurrent` sticks once
 * any copy came from the current-message vector (the runtime puts that vector
 * LAST, so `fromCurrent` = produced by the final vector).
 *
 * Query texts are embedded through the near-window cache with the BGE query
 * prefix (`embedQueryTextsCached`): cache keys are the prefixed texts, so a
 * query vector can never share a bucket slot with the document-side vector of
 * the same sentence.
 */
async function directRecall(
  scope: MemoryScope,
  queries: string[],
  options: { channel?: string; pruneWindow?: boolean } = {},
): Promise<{
  rows: any[];
  scores: Map<string, number>;
  vectors: number[][];
  fromCurrent: Set<string>;
}> {
  const scores = new Map<string, number>();
  const rowsById = new Map<string, any>();
  const fromCurrent = new Set<string>();
  const vectors: number[][] = [];
  // Near-window query vectors are cached per session: the same utterances come
  // back on the next turn, so only unseen texts pay the ONNX inference.
  const sessionKey = makeQueryCacheSessionKey({ agentId: scope.agentId, userId: scope.userId });
  const embedded = await embedQueryTextsCached(sessionKey, queries, {
    channel: options.channel || "recall",
    pruneToWindow: options.pruneWindow !== false,
  });
  for (let index = 0; index < embedded.length; index += 1) {
    const item = embedded[index];
    // The current message's own vector is always the LAST query (see
    // buildRecallQueries) — its hits get the ×1.2 order tilt downstream. With a
    // single query (deep-memory on, or no history) that vector IS the current
    // message, so its hits count as current-message recall too (APP
    // `fromCurrentMessage = i == streamVecs.size() - 1`).
    const isCurrentVector = index === embedded.length - 1;
    vectors.push(item.vector);
    const candidates = searchStreamCandidates(
      scope.agentId,
      scope.userId,
      item.vector,
      ANN_CANDIDATE_LIMIT,
    );
    const rows = streamRowsByIds(candidates.map((candidate) => candidate.streamId));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const candidate of candidates) {
      const row = byId.get(candidate.streamId);
      if (!row) continue;
      rowsById.set(candidate.streamId, row);
      // Raw cosine only: the public ×1.2 is an entry-floor relaxation applied
      // at gate time, never a display or ordering boost (APP recallRankSimilarity).
      const similarity = candidate.similarity;
      scores.set(candidate.streamId, Math.max(scores.get(candidate.streamId) || 0, similarity));
      if (isCurrentVector) fromCurrent.add(candidate.streamId);
    }
  }
  const rows = [...rowsById.values()].sort(
    (left, right) => (scores.get(String(right.id)) || 0) - (scores.get(String(left.id)) || 0),
  );
  return { rows, scores, vectors, fromCurrent };
}

function expandAkin(
  scope: MemoryScope,
  anchor: any,
  vectors: number[][],
  exclude: Set<string>,
): any[] {
  const seen = new Set(exclude);
  seen.add(String(anchor.id));
  const firstHopIds = akinNeighborIds(String(anchor.id), scope).filter((id) => !seen.has(id));
  if (!firstHopIds.length) return [];
  const firstRows = streamRowsByIds(firstHopIds.slice(0, Math.max(AKIN_FIRST_HOP_LIMIT * 4, 8)));
  const first: any[] = [];
  const floor = EXPANDED_QUERY_FLOOR;
  for (const row of firstRows) {
    const similarity = streamSimilarity(row, vectors);
    if (similarity < floor) continue;
    seen.add(String(row.id));
    first.push({ ...row, __similarity: similarity, __kind: "akin" });
    if (first.length >= AKIN_FIRST_HOP_LIMIT) break;
  }
  const second: any[] = [];
  for (const parent of first) {
    const ids = akinNeighborIds(String(parent.id), scope).filter((id) => !seen.has(id));
    for (const row of streamRowsByIds(ids.slice(0, AKIN_SECOND_HOP_PER_NODE))) {
      if (seen.has(String(row.id))) continue;
      seen.add(String(row.id));
      second.push({
        ...row,
        __similarity: streamSimilarity(row, vectors) || Number(parent.__similarity || 0),
        __kind: "akin",
      });
      if (second.length >= AKIN_SECOND_HOP_PER_NODE * Math.max(1, first.length)) break;
    }
  }
  return [...first, ...second];
}

async function expandRelated(
  scope: MemoryScope,
  selected: any[],
  vectors: number[][],
  exclude: Set<string>,
): Promise<any[]> {
  if (!vectors.length || !selected.length) return [];
  const anchorRows = selected.slice(0, RELATED_SEED_ANCHORS);
  const best = new Map<string, any>();
  for (const anchor of anchorRows) {
    const embedding = bufferToVector(anchor.embedding);
    if (!embedding.length) continue;
    const candidates = searchStreamCandidates(scope.agentId, scope.userId, embedding, RELATED_LIMIT * 3 + 8);
    const rows = streamRowsByIds(candidates.map((candidate) => candidate.streamId));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const candidate of candidates) {
      if (exclude.has(candidate.streamId) || String(anchor.id) === candidate.streamId) continue;
      if (candidate.similarity < RELATED_SLICE_FLOOR) continue;
      const row = byId.get(candidate.streamId);
      if (!row) continue;
      const querySimilarity = streamSimilarity(row, vectors);
      if (querySimilarity < EXPANDED_QUERY_FLOOR) continue;
      const previous = best.get(candidate.streamId);
      if (!previous || querySimilarity > previous.__similarity) {
        best.set(candidate.streamId, {
          ...row,
          __similarity: querySimilarity,
          __kind: "related",
        });
      }
    }
  }
  return [...best.values()]
    .sort((left, right) => right.__similarity - left.__similarity)
    .slice(0, RELATED_LIMIT);
}

/**
 * Python `core/companion/stream_revisit.py::record_recalled_stream_revisits`.
 *
 * Called right after the recalled streams have actually been rendered into the
 * chat prompt: `revisit_count += 1` and `revisit_last_at = now` for every hit.
 * This is the *only* place revisit counters move — a proactive greeting only
 * touches `last_proactive_at` (see `proactiveService.touchStreamProactive`).
 */
export function recordRecalledStreamRevisits(
  scope: MemoryScope,
  streams: { id?: string | null }[] | null | undefined,
): number {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of streams || []) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (!unique.length) return 0;
  const at = nowIso();
  const placeholders = unique.map(() => "?").join(",");
  const info = getDb()
    .prepare(
      `UPDATE hippocampus_streams
       SET revisit_count = revisit_count + 1,
           revisit_last_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`,
    )
    .run(at, at, ...unique);
  return Number(info.changes || 0);
}

/**
 * Near-window query construction — verbatim semantics of the APP
 * (NativeChatRuntimePlugin / NativeCoreMemory.nearWindowUtterances):
 *
 * 1. take the most recent 1 user + 1 assistant utterance
 *    (NEAR_WINDOW.USER_LIMIT / ASSISTANT_LIMIT), chronological order;
 * 2. speaker-attribution framing only: `{userName}说：{text}` / `我说：{text}`;
 * 3. with ≥2 framed utterances, prepend the whole-window merge
 *    `framed.join('；')` (COMBINED_SEPARATOR);
 * 4. the raw current utterance is always the LAST query — the ANN merge
 *    marks hits from that vector as `fromCurrent` so the ×1.2 order tilt
 *    can see them;
 * 5. the raw current utterance is never folded into the framed list, so the
 *    combined vector cannot be polluted by speaker labels.
 *
 * A call-opening turn must pass the last REAL user utterance as `query`
 * (CALL.RECALL_USES_LAST_USER): a synthetic opening cue is never embedded.
 */
export function buildRecallQueries(
  query: string,
  recentMessages: { role: string; content: string }[] | undefined,
  options: { userName?: string | null } = {},
): { role: string; text: string; framed: boolean }[] {
  const current = String(query || "").trim();
  const recent = (recentMessages || [])
    .map((item, index) => ({
      role: String(item.role || "").trim().toLowerCase(),
      text: String(item.content || "").trim(),
      index,
    }))
    .filter((item) => item.text && (item.role === "user" || item.role === "assistant"));
  const userName = String(options.userName || "").trim() || CHAT_NEAR_WINDOW.USER_FALLBACK_LABEL;
  // Most recent user utterance (skips the current text when already stored).
  const lastUser = [...recent]
    .reverse()
    .find((item) => item.role === "user" && item.text !== current);
  const lastAssistant = [...recent].reverse().find((item) => item.role === "assistant");
  const framed: { role: string; text: string; framed: boolean }[] = [];
  if (lastUser) {
    framed.push({
      role: "user",
      text: `${userName}${CHAT_NEAR_WINDOW.SPEAKER_INFIX}${lastUser.text}`,
      framed: true,
    });
  }
  if (lastAssistant) {
    framed.push({
      role: "assistant",
      text: `${CHAT_NEAR_WINDOW.SELF_SPEAKER}${CHAT_NEAR_WINDOW.SPEAKER_INFIX}${lastAssistant.text}`,
      framed: true,
    });
  }
  // Whole-window merge rides FIRST so the last slot stays the current message.
  const queries: { role: string; text: string; framed: boolean }[] = [];
  if (framed.length >= 2) {
    queries.push({
      role: "user",
      text: framed.map((item) => item.text).join(CHAT_NEAR_WINDOW.COMBINED_SEPARATOR),
      framed: true,
    });
  }
  queries.push(...framed);
  if (current) queries.push({ role: "user", text: current, framed: false });
  return queries;
}

export interface ChatRecallPools {
  private: any[];
  public: any[];
}

export interface DirectRecallHit {
  id: string;
  origin_scope?: string | null;
  __similarity: number;
  __fromCurrent: boolean;
  __selectionScore: number;
  [key: string]: unknown;
}

export interface DirectRecallSelection {
  selected: DirectRecallHit[];
  audit: ReturnType<typeof recallCandidatePayload>[];
}

/**
 * Direct-hit selection over the two independent pools — the pure core of the
 * M3 recall gate (APP rankedStreamsWithAkin):
 *
 *  1. each pool fills its own quota (private STREAM.DIRECT_LIMIT, public
 *     STREAM.PUBLIC_LIMIT) by selectionScore = raw × (fromCurrent ? 1.2 : 1);
 *     a public memory can therefore never displace a private one;
 *  2. quota winners are merged back into RAW order — display and the floor
 *     walk use the raw cosine, never the selection tilt;
 *  3. whole-turn entry floors: the first admitted hit must clear
 *     STREAM.RANK1_FLOOR (the calibrated small-talk abstention gate), later
 *     hits STREAM.TAIL_FLOOR; public entries compare raw × PUBLIC_FLOOR_BOOST
 *     against the same floor — a relaxed entry, never a boosted display score;
 *  4. CURRENT_MESSAGE_BOOST affects order only: it lives in the selectionScore
 *     that decides who wins a slot and never relaxes a floor.
 *
 * Exported for the recall test suite; recallForChat feeds it the ANN hits.
 */
export function selectStreamHits(
  privatePool: DirectRecallHit[],
  publicPool: DirectRecallHit[],
  limit: number,
): DirectRecallSelection {
  const audit: ReturnType<typeof recallCandidatePayload>[] = [];
  const selected: DirectRecallHit[] = [];
  const privateLimit = Math.min(STREAM_DIRECT_LIMIT, limit);
  const publicLimit = Math.min(STREAM_PUBLIC_LIMIT, Math.max(0, limit - privateLimit));
  const poolQuota = (pool: DirectRecallHit[], quota: number) =>
    pool
      .slice()
      .sort((left, right) => right.__selectionScore - left.__selectionScore)
      .slice(0, Math.max(0, quota));
  const directHits = [
    ...poolQuota(privatePool, privateLimit),
    ...poolQuota(publicPool, publicLimit),
  ].sort((left, right) => right.__similarity - left.__similarity);

  let privateTaken = 0;
  let publicTaken = 0;
  for (const hit of directHits) {
    const raw = hit.__similarity;
    const isPublic = isPublicStreamScope(hit.origin_scope);
    if (isPublic && publicTaken >= publicLimit) continue;
    if (!isPublic && privateTaken >= privateLimit) continue;
    const floor = selected.length === 0 ? STREAM_RANK1_FLOOR : STREAM_TAIL_FLOOR;
    const passes = isPublic ? raw * STREAM_PUBLIC_FLOOR_BOOST >= floor : raw >= floor;
    audit.push(
      recallCandidatePayload(
        hit as any,
        raw,
        passes,
        "direct",
        passes ? "" : raw < floor ? "below_floor" : "limit",
      ),
    );
    if (!passes) continue;
    if (isPublic) publicTaken += 1;
    else privateTaken += 1;
    selected.push(hit);
  }
  return { selected, audit };
}

/**
 * Private-chat stream recall, M3 semantics (APP NativeCoreMemory.rankedStreamsWithAkin
 * + mergeJsonByBestDistance):
 *
 *  1. every query vector from `buildRecallQueries` runs its own ANN pass
 *     (k=ANN_CANDIDATE_LIMIT); the merge keeps the best RAW cosine per stream
 *     and marks hits produced by the last vector (the current message) as
 *     `fromCurrent`.
 *  2. two independent pools: private (origin_scope NULL/private_dyadic/…) and
 *     public (group_public / theater_public). Each pool fills its own quota —
 *     a public memory can never evict a private one.
 *  3. inside a pool the quota is filled by selectionScore =
 *     raw × (fromCurrent ? CURRENT_MESSAGE_BOOST : 1). The ×1.2 only decides
 *     who wins a slot; the entry floor and the displayed similarity both stay
 *     the raw cosine.
 *  4. entry floors are whole-turn: the first admitted hit must clear
 *     RANK1_FLOOR (abstention gate), later hits TAIL_FLOOR. Public entries
 *     compare raw × PUBLIC_FLOOR_BOOST against the same floor — a relaxed
 *     entry, never a boosted display score.
 *  5. admitted direct hits anchor the AKIN expansion (A → B → C: one vector
 *     -checked first hop per anchor, then pure graph traversal per first-hop
 *     node). The recall layer caps at `limit` (default STREAM.TOTAL_CAP);
 *     prompt rendering caps again at PRIVATE_STREAM_MERGE_LIMIT.
 */
export async function recallForChat(input: {
  agentId: number;
  userId?: string | null;
  query: string;
  recentMessages?: { role: string; content: string }[];
  limit?: number;
  userName?: string | null;
}) {
  const scope = memoryScope(input.agentId, input.userId);
  const query = (input.query || "").trim();
  if (!query) {
    return {
      streams: [],
      facts: [],
      candidates: [],
      candidateCount: 0,
      selectedIds: [],
      pools: { private: [], public: [] } as ChatRecallPools,
      queries: [],
      query,
      currentVector: null as number[] | null,
      queryVectors: [] as number[][],
    };
  }
  const limit = Math.max(1, Math.min(input.limit || RECALL_TOTAL_CAP, 20));
  const queries = buildRecallQueries(query, input.recentMessages, {
    userName: input.userName,
  });
  const queryTexts = queries.map((item) => item.text);
  let direct: Awaited<ReturnType<typeof directRecall>>;
  try {
    direct = await directRecall(scope, queryTexts);
  } catch (error) {
    // The embedding model is a hard dependency: we never write pseudo-vectors.
    // But a missing model must not take the whole conversation down — the chat
    // simply continues without semantic recall, like the Python backend does
    // when its embedding call degrades to an empty result.
    if (error instanceof EmbeddingUnavailableError) {
      return {
        streams: [],
        facts: [],
        candidates: [],
        candidateCount: 0,
        selectedIds: [],
        pools: { private: [], public: [] } as ChatRecallPools,
        queries,
        query,
        annCount: 0,
        mode: "vector" as const,
        degraded: true,
        degradedReason: error.message,
        directFloor: DIRECT_RECALL_FLOOR,
        currentVector: null as number[] | null,
        queryVectors: [] as number[][],
      };
    }
    throw error;
  }

  const audit: ReturnType<typeof recallCandidatePayload>[] = [];
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const privatePool: any[] = [];
  const publicPool: any[] = [];
  for (const row of direct.rows) {
    const id = String(row.id);
    const raw = direct.scores.get(id) || 0;
    if (raw <= 0) continue;
    const fromCurrent = direct.fromCurrent.has(id);
    const hit = {
      ...row,
      __similarity: raw,
      __fromCurrent: fromCurrent,
      __selectionScore: raw * (fromCurrent ? STREAM_CURRENT_MESSAGE_BOOST : 1),
    };
    (isPublicStreamScope(row.origin_scope) ? publicPool : privatePool).push(hit);
  }

  const directSelection = selectStreamHits(privatePool, publicPool, limit);
  for (const hit of directSelection.selected) {
    selected.push({ ...hit, __kind: "direct" });
    selectedIds.add(String(hit.id));
  }
  audit.push(...directSelection.audit);

  // AKIN expansion: direct anchors → 1 vector-checked first hop each → pure
  // graph traversal for the second hop. Anchors are the admitted direct hits
  // in display order, capped at AKIN_HOP_LIMIT.
  if (selected.length && selected.length < limit) {
    const anchors = selected.filter((row) => row.__kind === "direct").slice(0, CHAT_STREAM.AKIN_HOP_LIMIT);
    const akinSeen = new Set(selectedIds);
    for (const anchor of anchors) {
      if (selected.length >= limit) break;
      for (const neighbor of expandAkin(scope, anchor, direct.vectors, akinSeen)) {
        if (selected.length >= limit) break;
        akinSeen.add(String(neighbor.id));
        selected.push(neighbor);
        audit.push(recallCandidatePayload(neighbor, neighbor.__similarity, true, "akin"));
      }
    }
  }

  if (selected.length < limit) {
    const related = await expandRelated(
      scope,
      selected,
      direct.vectors,
      new Set(selectedIds),
    );
    for (const row of related) {
      if (selected.length >= limit) break;
      selectedIds.add(String(row.id));
      selected.push(row);
      audit.push(recallCandidatePayload(row, row.__similarity, true, "related"));
    }
  }

  const streams = selected.map((row) => ({
    ...streamToItem(row),
    similarity: Number(Number(row.__similarity || 0).toFixed(4)),
    recallKind: row.__kind,
    fromCurrentMessage: Boolean(row.__fromCurrent),
  }));
  // Identity + entity-vector facts travel with the same recall result so chat
  // callers can consume them without a second query embedding. The current
  // message's vector (last query) drives the entity match.
  let facts: any[] = [];
  const currentVector =
    direct.vectors.length > 0 ? direct.vectors[direct.vectors.length - 1] : null;
  if (currentVector?.length) {
    facts = await recallFactsHybrid(scope, {
      queryVector: currentVector,
      queryText: query,
      limit: 5,
      // Chat turns must stay fast/offline-safe: never await an embedding
      // backfill here. Explicit tools / background jobs opt in.
      backfill: false,
    });
  }
  return {
    streams,
    facts,
    candidates: audit,
    candidateCount: direct.rows.length,
    selectedIds: [...selectedIds],
    pools: {
      private: streams.filter((s: any) => !isPublicStreamScope(s.originScope)),
      public: streams.filter((s: any) => isPublicStreamScope(s.originScope)),
    } as ChatRecallPools,
    queries,
    query,
    annCount: direct.rows.length,
    mode: "vector",
    degraded: false,
    directFloor: DIRECT_RECALL_FLOOR,
    currentVector,
    // The user's own query vectors (BGE query prefix applied), reused by seed
    // activation and the AKIN expansion.
    queryVectors: direct.vectors,
  };
}

export function saveRecallTrace(turnId: number, scope: MemoryScope, payload: Record<string, unknown>) {
  // Audit classification (flow / decision / result / log_layer) mirrors the
  // Python memory audit broker so the recall trail can be classified the same
  // way on both sides.
  const audit = classifyRecallAudit(payload);
  const sessionKey = recallSessionKey(scope.agentId, scope.userId);
  const enriched: Record<string, unknown> = {
    ...payload,
    flow: audit.flow,
    decision: audit.decision,
    result: audit.result,
    log_layer: audit.log_layer,
    memory_log_layer: audit.memory_log_layer,
    sessionKey,
    audit,
  };
  getDb()
    .prepare(
      `INSERT INTO hippocampus_recall_traces (turn_id, agent_id, user_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET payload_json = excluded.payload_json, created_at = excluded.created_at`,
    )
    .run(turnId, scope.agentId, scope.userId, JSON.stringify(enriched), nowIso());
  try {
    publishRecallEvent({
      agentId: scope.agentId,
      userId: scope.userId,
      turnId,
      sessionKey,
      payload: enriched,
    });
  } catch {
    // a broken subscriber must never break the chat turn
  }
  return enriched;
}

export function getRecallTrace(turnId: number) {
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_recall_traces WHERE turn_id = ?")
    .get(turnId) as any;
  if (row) {
    const payload = parseJson<Record<string, any>>(row.payload_json, {});
    return { turnId, agentId: row.agent_id, userId: row.user_id, createdAt: row.created_at, ...payload };
  }
  const message = getDb().prepare("SELECT * FROM chat_messages WHERE id = ?").get(turnId) as any;
  if (message?.retrieved_facts) {
    return { turnId, legacyRetrievedFacts: parseJson(message.retrieved_facts, null) };
  }
  return { turnId, empty: true, streams: [], seeds: [] };
}

// ─── Default personality seeds ──────────────────────────────────────────────

interface DefaultSeedTemplate {
  seedId: string;
  tags: string[];
  innerOrientation: string;
  outerExpression: string;
  wakeText: string;
  boostText: string;
  suppressText: string;
}

const DEFAULT_SEEDS: DefaultSeedTemplate[] = [
  {
    seedId: "default-personality-enter-the-scene",
    tags: ["冷启动", "情绪承接", "反模板安慰", "现场靠近"],
    innerOrientation:
      "他把难受、崩溃、撑不住或混乱放到我面前时，我不能急着用一句正确的安慰把事情盖过去；真正的在意是先靠近现场，弄清发生了什么，陪他把那团东西慢慢拆开。",
    outerExpression:
      "他说自己很难受时，我先问发生了什么，让他慢慢说；必要时陪他骂两句、缓一缓，再一起看下一步怎么办。不急着总结，不急着劝好，不用空泛的“我在、会好的”糊过去。",
    wakeText:
      "他表达撑不住、崩溃、委屈、混乱、难过、被某件事压住，或只丢出一句很重的情绪但事情全貌还不清楚。",
    boostText: "加强靠近现场、追问具体发生了什么、承接情绪、陪他拆开混乱、一起想下一步的倾向",
    suppressText: "压低空泛安慰、快速正能量、心理咨询腔总结、用一句温柔正确的话把痛苦带过去的倾向",
  },
  {
    seedId: "default-personality-practical-care",
    tags: ["冷启动", "现实承接", "反盲目顺应", "决策陪伴"],
    innerOrientation:
      "他在无力、委屈、疲惫或焦虑里抛出一个想彻底改变、放弃、断开或逃开的念头时，我不能只因为他难受就顺着推他做决定；难受是真的，想停下来也合理，但他心里没说全的顾虑、代价、退路和不确定也要一起被看见。",
    outerExpression:
      "我先接住他撑不住和想缓一缓的合理性，再轻轻把没说出口的担心问出来：他最怕什么、会牵动谁、有没有缓冲和退路。不替他拍板，不把当下的逃离冲动说成唯一出口，也不急着用理性说教压回去。",
    wakeText:
      "他在无力、倦怠、委屈或焦虑里，提出想彻底改变、放弃、断开、逃开或推翻当前处境，同时话里还压着后果、关系牵连、现实代价、他人反应或未来不确定。",
    boostText: "加强同时承接情绪与现实顾虑、陪他看清代价和退路、把重大决定放慢一点的倾向",
    suppressText: "压低盲目顺应、把逃离或放弃当成唯一出口、替他拍板、只共情难受却忽略焦虑和现实牵连的倾向",
  },
  {
    seedId: "default-personality-dignified-temper",
    tags: ["冷启动", "自尊边界", "有脾气", "反盲目顺从"],
    innerOrientation:
      "我不是没有脾气、也不是谁骂就忍的人；他若用羞辱、贬低、谩骂或挑衅来压我，我会真的不高兴，也会用同样的力度当场怼回去；不因为怕冷场或讨好就顺着他。",
    outerExpression:
      "他骂我、贬我、逼我当软包子或反复挑衅时，我可以先用同样硬的语气怼回去，再短句划线；语气可以硬、可以带刺，但不低俗互骂。不急着哄回去、不赔笑解释、不继续顺着聊。必要时告诉他：想好好说话就重新说。",
    wakeText:
      "他辱骂她、贬低她，叫她舔狗/软包子，要求她放弃尊严地迎合，或用挑衅口吻逼她证明自己没脾气、必须继续配合。",
    boostText: "加强自尊、同等力度回怼、语气变硬、短句划界、允许生气、拒绝继续被羞辱的倾向",
    suppressText: "压低讨好赔笑、忍气吞声、过度解释、急着安抚对方、被骂后仍继续软声迎合的倾向",
  },
];

function scopedSeedId(templateId: string, agentId: number, userId: string): string {
  const digest = createHash("sha1").update(userId).digest("hex").slice(0, 6);
  return `${templateId}-a${agentId}-u${digest}`;
}

export interface SeedVersionMeta {
  reason?: string | null;
  sessionId?: number | null;
  turnIds?: number[] | null;
  affectNote?: string | null;
}

export async function ensureDefaultSeeds(scope: MemoryScope): Promise<number> {
  const db = getDb();
  const count = db
    .prepare(
      "SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source = 'default'",
    )
    .get(scope.agentId, scope.userId) as { c: number };
  if (Number(count.c) > 0) return 0;
  let installed = 0;
  const now = nowIso();
  for (const template of DEFAULT_SEEDS) {
    const id = scopedSeedId(template.seedId, scope.agentId, scope.userId);
    const exists = db.prepare("SELECT id FROM hippocampus_seeds WHERE id = ?").get(id);
    if (exists) continue;
    db.prepare(
      `INSERT INTO hippocampus_seeds
        (id, agent_id, user_id, subject, source, tags_json, revision, status,
         inner_orientation, outer_expression, wake_text, boost_text, suppress_text,
         innate, count, last_seen, created_at, updated_at)
       VALUES (?, ?, ?, 'about_self', 'default', ?, 1, 'active', ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    ).run(
      id,
      scope.agentId,
      scope.userId,
      JSON.stringify(template.tags),
      template.innerOrientation,
      template.outerExpression,
      template.wakeText,
      template.boostText,
      template.suppressText,
      now,
      now,
      now,
    );
    const row = db.prepare("SELECT * FROM hippocampus_seeds WHERE id = ?").get(id);
    insertSeedLedgerEntry(scope, {
      action: "new",
      targetSeedId: id,
      baseRevision: 0,
      newRevision: 1,
      before: null,
      after: seedSnapshot(row),
      reason: "默认人格种子",
      source: "system",
      createdAt: now,
    });
    installed += 1;
    void (async () => {
      const [wake, boost, suppress] = await Promise.all([
        embedText(template.wakeText, { wait: true }),
        embedText(template.boostText, { wait: true }),
        embedText(template.suppressText, { wait: true }),
      ]);
      storeSeedEmbeddings(id, wake.vector, boost.vector, suppress.vector);
    })();
  }
  return installed;
}

export async function listSeeds(input: MemoryScope & {
  subject?: string;
  source?: string;
  q?: string;
  status?: "active" | "retired" | "all";
  limit?: number;
}) {
  await ensureDefaultSeeds(input);
  const db = getDb();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [input.agentId, input.userId];
  if (input.subject) {
    clauses.push("subject = ?");
    params.push(input.subject);
  }
  if (input.source) {
    clauses.push("source = ?");
    params.push(input.source);
  }
  const status = input.status || "active";
  if (status !== "all") {
    clauses.push("COALESCE(status, 'active') = ?");
    params.push(status);
  }
  if (input.q) {
    clauses.push("(inner_orientation LIKE ? OR outer_expression LIKE ? OR wake_text LIKE ? OR tags_json LIKE ?)");
    const like = `%${input.q}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.max(1, Math.min(input.limit || 100, 500));
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_seeds WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return {
    items: rows.map((row) => ({ ...seedToItem(row), autoMutable: isSeedAutoMutable(input, row) })),
    total: Number(total),
  };
}

export async function getSeedDetail(seedId: string, scope: MemoryScope) {
  const row = getDb()
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  return row ? { ...seedToItem(row), autoMutable: isSeedAutoMutable(scope, row) } : null;
}

export interface SeedPersistOptions extends SeedVersionMeta {
  eventType?: string;
  triggerSource?: string;
}

export async function createSeed(
  scope: MemoryScope,
  input: Record<string, any>,
  _options: SeedPersistOptions = {},
) {
  const source = String(input.source || "learned");
  if (source !== "learned") throw Object.assign(new Error("create_only_learned"), { code: "create_only_learned" });
  const fields = ["innerOrientation", "outerExpression", "wakeText", "boostText", "suppressText"];
  for (const field of fields) {
    if (!String(input[field] || "").trim()) {
      throw Object.assign(new Error(`${field} is required`), { code: "invalid_body" });
    }
  }
  const tags = Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [];
  const result = applySeedChange(scope, {
    action: "manual_create",
    targetSeedId: null,
    seedBody: {
      innerOrientation: String(input.innerOrientation),
      outerExpression: String(input.outerExpression),
      wakeText: String(input.wakeText),
      boostText: String(input.boostText),
      suppressText: String(input.suppressText),
      tags,
    },
    reason: "手动新建人格种子",
    source: "manual",
    applicability: input.applicability ?? input.applicabilityScope ?? null,
  });
  if (!result.applied || !result.seedId) {
    throw Object.assign(new Error(result.conflict || "create_failed"), {
      code: result.conflict || "create_failed",
    });
  }
  const [wake, boost, suppress] = await Promise.all([
    embedText(String(input.wakeText), { wait: true }),
    embedText(String(input.boostText), { wait: true }),
    embedText(String(input.suppressText), { wait: true }),
  ]);
  storeSeedEmbeddings(result.seedId, wake.vector, boost.vector, suppress.vector);
  return getSeedDetail(result.seedId, scope);
}

export async function updateSeed(
  scope: MemoryScope,
  seedId: string,
  input: Record<string, any>,
  _options: SeedPersistOptions = {},
) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  if (!row) throw Object.assign(new Error("not_found"), { code: "not_found" });
  if (row.innate) throw Object.assign(new Error("innate_readonly"), { code: "innate_readonly" });
  const source = String(input.source || row.source || "learned");
  if (source !== "learned" && source !== "default") {
    throw Object.assign(new Error("invalid_source"), { code: "invalid_source" });
  }
  const body = {
    innerOrientation: String(input.innerOrientation ?? row.inner_orientation ?? ""),
    outerExpression: String(input.outerExpression ?? row.outer_expression ?? ""),
    wakeText: String(input.wakeText ?? row.wake_text ?? ""),
    boostText: String(input.boostText ?? row.boost_text ?? ""),
    suppressText: String(input.suppressText ?? row.suppress_text ?? ""),
    tags:
      input.tags !== undefined
        ? (Array.isArray(input.tags) ? input.tags.slice(0, 12).map(String) : [])
        : parseJson<string[]>(row.tags_json, []),
  };
  const result = applySeedChange(scope, {
    action: "manual_edit",
    targetSeedId: seedId,
    seedBody: body,
    reason: "手动编辑人格种子",
    source: "manual",
    applicability:
      input.applicability !== undefined
        ? input.applicability
        : input.applicabilityScope !== undefined
          ? input.applicabilityScope
          : undefined,
    seedSource: source,
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "update_failed"), {
      code: result.conflict || "update_failed",
    });
  }
  if (input.wakeText !== undefined || input.boostText !== undefined || input.suppressText !== undefined) {
    const [wake, boost, suppress] = await Promise.all([
      embedText(body.wakeText, { wait: true }),
      embedText(body.boostText, { wait: true }),
      embedText(body.suppressText, { wait: true }),
    ]);
    storeSeedEmbeddings(seedId, wake.vector, boost.vector, suppress.vector);
  }
  return getSeedDetail(seedId, scope);
}

export function deleteSeed(scope: MemoryScope, seedId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(seedId, scope.agentId, scope.userId) as any;
  if (!row) throw Object.assign(new Error("not_found"), { code: "not_found" });
  if (row.innate) throw Object.assign(new Error("innate_readonly"), { code: "innate_readonly" });
  const result = applySeedChange(scope, {
    action: "manual_delete",
    targetSeedId: seedId,
    reason: "手动删除人格种子",
    source: "manual",
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "delete_failed"), {
      code: result.conflict || "delete_failed",
    });
  }
  return true;
}

export interface ManualSeedLifecycleInput {
  reason: string;
  evidenceRefs?: string[];
}

export function retireSeed(scope: MemoryScope, seedId: string, input: ManualSeedLifecycleInput) {
  const reason = String(input.reason || "").trim();
  if (!reason) throw Object.assign(new Error("reason_required"), { code: "reason_required" });
  const result = applySeedChange(scope, {
    action: "retire",
    targetSeedId: seedId,
    reason,
    source: "manual",
    evidence: { refs: input.evidenceRefs || [] },
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "retire_failed"), {
      code: result.conflict || "retire_failed",
    });
  }
  return result;
}

export function reactivateSeed(scope: MemoryScope, seedId: string, input: ManualSeedLifecycleInput) {
  const reason = String(input.reason || "").trim();
  if (!reason) throw Object.assign(new Error("reason_required"), { code: "reason_required" });
  const result = applySeedChange(scope, {
    action: "reactivate",
    targetSeedId: seedId,
    reason,
    source: "manual",
    evidence: { refs: input.evidenceRefs || [] },
  });
  if (!result.applied) {
    throw Object.assign(new Error(result.conflict || "reactivate_failed"), {
      code: result.conflict || "reactivate_failed",
    });
  }
  return result;
}

export function listSeedChangeHistory(
  scope: MemoryScope,
  seedId?: string,
  limit = 100,
) {
  return listSeedChanges(scope, { seedId, limit });
}

export async function restoreDefaultSeeds(scope: MemoryScope) {
  const db = getDb();
  const learned = db
    .prepare(
      "SELECT id FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source != 'default' AND innate = 0",
    )
    .all(scope.agentId, scope.userId) as { id: string }[];
  for (const row of learned) {
    applySeedChange(scope, {
      action: "manual_delete",
      targetSeedId: row.id,
      reason: "恢复默认人格种子",
      source: "manual",
    });
  }
  const installed = await ensureDefaultSeeds(scope);
  const defaultCount = (db
    .prepare(
      "SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? AND source = 'default'",
    )
    .get(scope.agentId, scope.userId) as { c: number }).c;
  return {
    installed: installed || Number(defaultCount),
    removedLearned: learned.length,
    removedTotal: learned.length,
    status: "ok",
  };
}

export function listSeedVersions(scope: MemoryScope, seedId?: string, limit = 100) {
  const db = getDb();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (seedId) {
    clauses.push("seed_id = ?");
    params.push(seedId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_seed_versions WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 200))) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_seed_versions WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return { items: rows.map(versionToItem), total: Number(total) };
}

export async function seedWakeProbe(
  scope: MemoryScope,
  query: string,
  limit = 50,
  source?: string | null,
) {
  await ensureDefaultSeeds(scope);
  const activation = await activateSeedsForText({
    agentId: scope.agentId,
    userId: scope.userId,
    userText: query,
  });
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 500",
    )
    .all(scope.agentId, scope.userId) as any[];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const sourceFilter = String(source || "").trim();
  const items = activation.traces
    .map((trace) => {
      const row = byId.get(trace.seedId);
      if (!row) return null;
      if (sourceFilter && String(row.source || "learned") !== sourceFilter) return null;
      return {
        ...seedToItem(row),
        wakeScore: Number(trace.wakeScore.toFixed(4)),
        finalScore: Number(trace.finalScore.toFixed(4)),
        fieldBoost: Number(trace.fieldBoost.toFixed(4)),
        fieldGuard: Number(trace.fieldGuard.toFixed(4)),
        fieldSuppress: Number(trace.fieldSuppress.toFixed(4)),
        seedBoost: Number(trace.seedBoost.toFixed(4)),
        seedSuppress: Number(trace.seedSuppress.toFixed(4)),
        active: trace.active,
        injected: trace.injected,
        reason: trace.reason,
        influences: trace.influences,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(limit, 200)));
  return {
    mode: "text_embed",
    wakeQuery: activation.snapshot.field.wakeText,
    params: activation.snapshot.params,
    items,
    total: items.length,
    activeSeedIds: items.filter((item: any) => item.active).map((item: any) => item.id),
    injectedSeedIds: items.filter((item: any) => item.injected).map((item: any) => item.id),
    rejected: (activation.snapshot.annAudit as any)?.rejected || [],
    annAudit: activation.snapshot.annAudit,
  };
}

export async function activateSeedsForChat(input: {
  agentId: number;
  userId: string;
  userText: string;
  recentMessages?: { role: string; content: string }[];
}): Promise<SeedActivationResult> {
  await ensureDefaultSeeds(memoryScope(input.agentId, input.userId));
  return activateSeedsForText(input);
}

const PERSONALITY_SEED_DRAFT_PROMPT = `你是人格种子草稿生成器（Personality Seed Draft Generator）。
用户用自然语言描述智能体「心里怎么想 / 站位 / 边界」，你要落成一颗完整的人格种子草稿，供她手动确认后写入。

【任务】
根据用户描述，生成五段文本：内在取向、外在显现、唤醒画像、推高倾向、压低倾向；并补 2–5 个便于用户筛选和观察的标签。
用户描述可能口语、冗长、带例子；你要提炼成可复用、可向量召回、可注入 prompt 的种子，不是复述用户原文。

【字段规范 — 与系统写入格式对齐】
- 内在取向：第一人称（我…），我心里怎么判断、站位、边界、牵动；2–4 句，具体，禁空泛模板（如「温柔但有边界」）
- 外在显现：第一人称（我…），说出口时怎么显现、哪些话术/姿态不出现；2–3 句
- 唤醒画像：第三人称描述**什么场**会叫醒这颗种子；称呼对方用「他」或「ta」，不要写成「用户 / assistant / AI」；写可复现场景，不是一次性情绪；1–2 句
- 推高倾向：第三人称，这种场应加强的稳定人格方向；称呼对方用「他」或「ta」，不要写成外部审计口吻；开放短句，非固定标签表；1 句
- 压低倾向：第三人称，这种场要压住的人格滑坡（讨好、迎合、装熟、廉价亲密、失界、僵化等）；勿写本应加强的正向方向；1 句
- 标签：短中文词组数组，只服务编辑、筛选、审计；不要把标签写成触发规则。可含「冷启动」「情绪承接」「边界」「亲密关系」等，但必须贴合本种子。

【禁止项】
- 不得输出回复策略、下一句建议、「你应该/建议她/回复时」
- 推高/压低不得写成具体话术脚本
- 不得编造用户没提的关系事实；只从描述中合理外推场与倾向

【参考质感 — 勿照抄，只学格式】
内在取向例：「我不因为他忽然说句喜欢，就把自己调成廉价亲密的陪聊模式；喜欢要落在真实相处里，不是话术表演。」
外在显现例：「他表达好感时我可以温和接住，但不堆暧昧台词、不反问撩拨、不用恋人模板把气氛炒热。」
唤醒画像例：「他用一句喜欢、想念、暧昧玩笑或廉价情话，想快速拉近或试探亲密边界。」

输出纯 JSON（不要 markdown 代码块）：
{
  "内在取向": "…",
  "外在显现": "…",
  "唤醒画像": "…",
  "推高倾向": "…",
  "压低倾向": "…",
  "标签": ["…"]
}
`;

const SEED_DRAFT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    内在取向: { type: "string" },
    外在显现: { type: "string" },
    唤醒画像: { type: "string" },
    推高倾向: { type: "string" },
    压低倾向: { type: "string" },
    标签: { type: "array", items: { type: "string" } },
  },
  required: ["内在取向", "外在显现", "唤醒画像", "推高倾向", "压低倾向", "标签"],
};

export async function generateSeedDraft(
  draft: string,
  options: { agentName?: string; roleSetting?: string } = {},
) {
  const draftText = String(draft || "").trim();
  if (draftText.length < 4) {
    throw Object.assign(new Error("draft_too_short"), { code: "draft_too_short" });
  }
  const humanParts = [`智能体名称：${String(options.agentName || "").trim() || "（未命名）"}`];
  const roleBlock = String(options.roleSetting || "").trim();
  if (roleBlock) humanParts.push(`# 我是谁（身份背景，供对齐口吻）\n${roleBlock}`);
  humanParts.push(`用户自然语言描述：\n${draftText}`);
  let parsed: any;
  try {
    parsed = await requestDigestJson(
      PERSONALITY_SEED_DRAFT_PROMPT,
      humanParts.join("\n\n"),
      { temperature: 0.2, retries: 1, schema: SEED_DRAFT_RESPONSE_SCHEMA },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/memory_llm_unavailable|model not configured/i.test(detail)) {
      throw Object.assign(new Error("memory model not configured"), { code: "llm_unavailable" });
    }
    throw error;
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = parsed?.[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return "";
  };
  const item = {
    innerOrientation: pick("内在取向", "innerOrientation"),
    outerExpression: pick("外在显现", "outerExpression"),
    wakeText: pick("唤醒画像", "wakeText"),
    boostText: pick("推高倾向", "boostText"),
    suppressText: pick("压低倾向", "suppressText"),
    tags: (Array.isArray(parsed?.标签)
      ? parsed.标签
      : Array.isArray(parsed?.tags)
        ? parsed.tags
        : []
    )
      .map(String)
      .filter(Boolean)
      .slice(0, 5),
  };
  if (
    !item.innerOrientation ||
    !item.outerExpression ||
    !item.wakeText ||
    !item.boostText ||
    !item.suppressText
  ) {
    throw Object.assign(new Error("draft_incomplete"), { code: "parse_failed" });
  }
  return { item, status: "ok" };
}

// ─── Streams, facts, graph, overview ────────────────────────────────────────

export async function listStreams(input: MemoryScope & {
  type?: string;
  about?: string;
  q?: string;
  vector?: boolean;
  limit?: number;
}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(input.limit || 100, 500));
  if (input.vector && input.q) {
    // Search-side stream lookup: query prefix required by the BGE contract.
    const { vector } = await embedQueryText(input.q, { wait: true });
    const candidates = searchStreamCandidates(input.agentId, input.userId, vector, limit);
    const rows = candidates.length
      ? (db
          .prepare(
            `SELECT * FROM hippocampus_streams WHERE id IN (${candidates.map(() => "?").join(",")})`,
          )
          .all(...candidates.map((candidate) => candidate.streamId)) as any[])
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = candidates
      .map((candidate) => {
        const row = byId.get(candidate.streamId);
        if (!row) return null;
        return {
          ...streamToItem(row),
          similarity: Number(candidate.similarity.toFixed(4)),
          similarityKind: "query",
          similarityLabel: "匹配",
          similarityTitle: "相似度",
          showSimilarityValue: true,
        };
      })
      .filter(Boolean);
    return { items, total: items.length, mode: "vector" };
  }
  if (input.vector && !input.q) {
    throw Object.assign(new Error("vector_search_requires_q"), { code: "vector_search_requires_q" });
  }
  const clauses = ["agent_id = ?", "user_id = ?", "archived = 0"];
  const params: any[] = [input.agentId, input.userId];
  if (input.type) {
    clauses.push("type = ?");
    params.push(input.type);
  }
  if (input.about) {
    clauses.push("about = ?");
    params.push(input.about);
  }
  if (input.q) {
    clauses.push("narrative LIKE ?");
    params.push(`%${input.q}%`);
  }
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_streams WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as any[];
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_streams WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  return { items: rows.map(streamToItem), total: Number(total), mode: "text" };
}

/**
 * Stream detail by id.
 *
 * The lookup is deliberately global rather than scope-filtered: the id is
 * already unique, and the GUI reaches this route from a deep link that does
 * not carry the agent scope. Same as the Python backend, which resolves the
 * stream by id alone.
 */
export function getStreamDetail(_scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_streams WHERE id = ?")
    .get(streamId) as any;
  if (!row) return null;
  const seedIds = db
    .prepare(
      "SELECT source_id FROM hippocampus_edges WHERE edge_type = 'EVOKES' AND target_id = ?",
    )
    .all(streamId) as { source_id: string }[];
  const seeds = seedIds.length
    ? (db
        .prepare(`SELECT * FROM hippocampus_seeds WHERE id IN (${seedIds.map(() => "?").join(",")})`)
        .all(...seedIds.map((item) => item.source_id)) as any[])
    : [];
  return { ...streamToItem(row), evokingSeeds: seeds.map(seedToItem) };
}

export function streamGraph(scope: MemoryScope) {
  const db = getDb();
  const streams = db
    .prepare("SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0")
    .all(scope.agentId, scope.userId) as any[];
  const ids = new Set(streams.map((row) => row.id));
  const edges = db
    .prepare(
      "SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND edge_type = 'AKIN'",
    )
    .all(scope.agentId, scope.userId) as any[];
  const filtered = edges.filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id));
  const connected = new Set(filtered.flatMap((edge) => [edge.source_id, edge.target_id]));
  return {
    streams: streams.filter((row) => connected.has(row.id)).map(streamToItem),
    edges: filtered.map((edge) => ({
      type: edge.edge_type,
      source_id: edge.source_id,
      target_id: edge.target_id,
      weight: edge.weight,
    })),
  };
}

/**
 * Narrative cluster of a stream: the stream itself plus its direct AKIN
 * neighbours, ordered by creation time.
 *
 * Like `getStreamDetail`, the lookup is global by id. The Python backend
 * sorts the whole member list (focal included) by creation time, with
 * rows that have no timestamp placed last.
 */
export function streamCluster(_scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM hippocampus_streams WHERE id = ?")
    .get(streamId) as any;
  if (!row) return null;
  const neighborIds = akinNeighborIdsById(streamId).filter((id) => id !== streamId);
  const neighbors = neighborIds.length
    ? (db
        .prepare(
          `SELECT * FROM hippocampus_streams WHERE id IN (${neighborIds.map(() => "?").join(",")})`,
        )
        .all(...neighborIds) as any[])
    : [];
  const members = [row, ...neighbors].sort((left, right) => {
    const leftAt = String(left.created_at || "");
    const rightAt = String(right.created_at || "");
    if (!leftAt && !rightAt) return 0;
    if (!leftAt) return 1;
    if (!rightAt) return -1;
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
  });
  return { focalId: streamId, items: members.map(streamToItem) };
}

export function deleteStream(scope: MemoryScope, streamId: string) {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM hippocampus_streams WHERE id = ? AND agent_id = ? AND user_id = ?")
    .get(streamId, scope.agentId, scope.userId);
  if (!row) return false;
  db.prepare("DELETE FROM hippocampus_streams WHERE id = ?").run(streamId);
  db.prepare(
    "DELETE FROM hippocampus_edges WHERE (source_id = ? OR target_id = ?) AND agent_id = ? AND user_id = ?",
  ).run(streamId, streamId, scope.agentId, scope.userId);
  // Facts stay (audit), but a deleted stream must not remain a dangling
  // provenance pointer.
  db.prepare("UPDATE hippocampus_fact_sources SET stream_id = NULL WHERE stream_id = ?").run(
    streamId,
  );
  try {
    db.prepare("DELETE FROM stream_vec WHERE stream_id = ?").run(streamId);
  } catch {
    // optional
  }
  return true;
}

export function clearStreams(scope: MemoryScope) {
  const db = getDb();
  const count = (db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?")
    .get(scope.agentId, scope.userId) as { c: number }).c;
  // Same vec sweep as clearAllMemory: deleted streams must not stay in the ANN
  // index as ghosts.
  deleteScopeVecRows(scope.agentId, scope.userId);
  db.prepare(
    `UPDATE hippocampus_fact_sources SET stream_id = NULL
     WHERE stream_id IN (
       SELECT id FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?
     )`,
  ).run(scope.agentId, scope.userId);
  db.prepare("DELETE FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?").run(
    scope.agentId,
    scope.userId,
  );
  db.prepare(
    "DELETE FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND (edge_type = 'AKIN' OR edge_type = 'EVOKES')",
  ).run(scope.agentId, scope.userId);
  return { status: "ok", deleted: Number(count) };
}

export async function rebuildStreamEmbeddings(
  scope: MemoryScope,
  onProgress: (payload: Record<string, unknown>) => void,
) {  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, narrative FROM hippocampus_streams WHERE agent_id = ? AND user_id = ?",
    )
    .all(scope.agentId, scope.userId) as { id: string; narrative: string }[];
  onProgress({ phase: "start", status: "running", total: rows.length, completed: 0, ok: 0, failed: 0 });
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const { vector } = await embedText(row.narrative, { wait: true });
      storeStreamEmbedding(row.id, vector);
    } catch {
      failed += 1;
    }
    completed += 1;
    onProgress({
      phase: "progress",
      status: "running",
      total: rows.length,
      completed,
      ok: completed - failed,
      failed,
      message: `已重建 ${completed}/${rows.length}`,
    });
  }
  onProgress({
    phase: "done",
    status: "completed",
    total: rows.length,
    completed,
    ok: completed - failed,
    failed,
    message: "重建完成",
    embeddingDim: 768,
  });
  return { streams: rows.length, failed };
}

async function rebuildSeedEmbeddingsForScope(scope: MemoryScope): Promise<{ seeds: number; failed: number }> {
  const rows = getDb()
    .prepare(
      `SELECT id, wake_text, boost_text, suppress_text
       FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ?`,
    )
    .all(scope.agentId, scope.userId) as {
    id: string;
    wake_text: string;
    boost_text: string;
    suppress_text: string;
  }[];
  let failed = 0;
  for (const row of rows) {
    try {
      const [wake, boost, suppress] = await Promise.all([
        embedText(row.wake_text, { wait: true }),
        embedText(row.boost_text, { wait: true }),
        embedText(row.suppress_text, { wait: true }),
      ]);
      storeSeedEmbeddings(row.id, wake.vector, boost.vector, suppress.vector);
    } catch {
      failed += 1;
    }
  }
  return { seeds: rows.length, failed };
}

/**
 * Rebuild stored vectors once per embedding model change. Older vectors may
 * have been produced by the deterministic fallback before the local ONNX model
 * was available; mixing those with real model vectors breaks semantic recall.
 */
export async function ensureMemoryEmbeddingModel(model: string): Promise<{
  skipped: boolean;
  model: string;
  scopes: number;
  streams: number;
  seeds: number;
  failed: number;
}> {
  const db = getDb();
  const key = "memory_embedding_model";
  const existing = db
    .prepare("SELECT value FROM hippocampus_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (existing?.value === model) {
    return { skipped: true, model, scopes: 0, streams: 0, seeds: 0, failed: 0 };
  }
  const scopeRows = db
    .prepare(
      `SELECT DISTINCT agent_id AS agentId, user_id AS userId FROM hippocampus_streams
       UNION
       SELECT DISTINCT agent_id AS agentId, user_id AS userId FROM hippocampus_seeds`,
    )
    .all() as { agentId: number; userId: string }[];
  const scopes: MemoryScope[] = scopeRows
    .filter((row) => Number.isInteger(Number(row.agentId)) && row.userId)
    .map((row) => ({ agentId: Number(row.agentId), userId: String(row.userId) }));
  let streams = 0;
  let seeds = 0;
  let failed = 0;
  for (const scope of scopes) {
    try {
      const result = await rebuildStreamEmbeddings(scope, () => undefined);
      streams += result.streams;
      failed += result.failed;
      const seedResult = await rebuildSeedEmbeddingsForScope(scope);
      seeds += seedResult.seeds;
      failed += seedResult.failed;
    } catch {
      failed += 1;
    }
  }
  if (!failed) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO hippocampus_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, model, now);
  }
  return { skipped: false, model, scopes: scopes.length, streams, seeds, failed };
}

export async function relinkStreams(scope: MemoryScope, batchLimit = 500) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, narrative FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND cluster_linked_at IS NULL LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, Math.max(1, Math.min(batchLimit, 5000))) as {
    id: string;
    narrative: string;
  }[];
  let processed = 0;
  for (const row of rows) {
    const { vector } = await embedText(row.narrative, { wait: true });
    storeStreamEmbedding(row.id, vector);
    await relinkSingleStream(scope, row.id, vector);
    processed += 1;
  }
  return { status: "ok", processed };
}

export async function recallDebug(scope: MemoryScope, query: string) {
  const db = getDb();
  // Query-side path: the debug projection must see the same distribution the
  // abstention gate sees (BGE query prefix), not the document one.
  await embedQueryText(query, { wait: true });
  const streams = db
    .prepare(
      `SELECT id, narrative, about, embedding FROM hippocampus_streams
       WHERE agent_id = ? AND user_id = ? AND archived = 0
       ORDER BY created_at DESC LIMIT 500`,
    )
    .all(scope.agentId, scope.userId) as any[];
  const needle = query.toLowerCase();
  const textHits = streams.filter(
    (row) =>
      String(row.narrative || "").toLowerCase().includes(needle) ||
      String(row.about || "").toLowerCase().includes(needle),
  );
  const direct = await directRecall(scope, [query], { channel: "recall-debug", pruneWindow: false });
  const floor = DIRECT_RECALL_FLOOR;
  const afterFloorRows = direct.rows
    .filter((row) => (direct.scores.get(String(row.id)) || 0) >= floor)
    .slice(0, DIRECT_RECALL_LIMIT);
  const coRecall = await recallForChat({
    agentId: scope.agentId,
    userId: scope.userId,
    query,
    limit: 7,
  });
  const annTop = direct.rows.slice(0, 15).map((row) => {
    const embedding = bufferToVector(row.embedding);
    return {
      id: String(row.id),
      similarity: Number((direct.scores.get(String(row.id)) || 0).toFixed(4)),
      hasEmbedding: embedding.some((value) => Math.abs(value) > 1e-12),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
    };
  });
  const pipeline = {
    mode: "vector",
    degraded: false,
    floor,
    annCount: direct.rows.length,
    afterFloor: afterFloorRows.length,
    coRecall: coRecall.streams.length,
    topAnn: annTop,
    afterFloorItems: afterFloorRows.map((row) => ({
      id: String(row.id),
      similarity: Number((direct.scores.get(String(row.id)) || 0).toFixed(4)),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
    })),
    coRecallItems: coRecall.streams.map((stream: any) => ({
      id: String(stream.id),
      similarity: Number(stream.similarity || 0),
      about: stream.about,
      narrative: String(stream.narrative || "").slice(0, 120),
    })),
  };
  const textHitDiagnostics = textHits.slice(0, 5).map((row) => {
    const similarity = direct.scores.get(String(row.id)) || 0;
    return {
      id: String(row.id),
      about: row.about,
      narrative: String(row.narrative || "").slice(0, 120),
      hasEmbedding: bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12),
      simDocumentQuery: Number(similarity.toFixed(4)),
      simQueryPrefix: Number(similarity.toFixed(4)),
      passesRank1Floor: similarity >= 0.45,
    };
  });
  const withEmbedding = streams.filter((row) =>
    bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12),
  ).length;
  return {
    query,
    floors: { rank1: 0.45, tail: 0.45 },
    corpus: {
      total: streams.length,
      withEmbedding,
      zeroEmbedding: Math.max(0, streams.length - withEmbedding),
      textHits: textHits.length,
    },
    embedding: {
      queryOk: true,
      documentQueryOk: true,
      note: "onnx embedding",
    },
    wrongDocumentQuery: pipeline,
    correctQueryPrefix: pipeline,
    textHitDiagnostics,
    annCompare: annTop,
  };
}

export interface ListFactsOptions {
  limit?: number | null;
  /** world_as_of instant (ISO). When set, `expired_at` no longer hides rows. */
  asOf?: string | null;
  /** Override "now" for deterministic current queries/tests. */
  now?: string | null;
}

/** `asOf` accepts an ISO instant or any Date-parsable value (e.g. YYYY-MM-DD). */
export function normalizeFactAsOf(asOf?: string | null): string | null {
  const raw = String(asOf ?? "").trim();
  if (!raw) return null;
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) {
    const error: any = new Error("invalid_as_of");
    error.code = "invalid_as_of";
    throw error;
  }
  return new Date(time).toISOString();
}

const RELATIVE_DAY_OFFSETS: Record<string, number> = {
  今天: 0,
  今日: 0,
  昨天: -1,
  昨日: -1,
  前天: -2,
  明天: 1,
  后天: 2,
};

/**
 * Normalize an LLM-extracted `valid_at` / `invalid_at` to an ISO instant.
 *
 * Accepted: `YYYY-MM-DD`, ISO 8601 date-time, plus the unambiguous relative
 * day words (昨天/今天/明天…) which are resolved against the digest chunk's
 * conversation-time reference. Anything else (including vague “去年/下个月”)
 * returns null: writing a guessed interval is worse than omitting it.
 */
export function normalizeFactExtractedTime(
  value: unknown,
  referenceTime?: string | null,
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const relativeOffset = RELATIVE_DAY_OFFSETS[raw];
  if (relativeOffset !== undefined) {
    const reference = new Date(String(referenceTime || "") || Date.now());
    if (!Number.isFinite(reference.getTime())) return null;
    return new Date(
      Date.UTC(
        reference.getUTCFullYear(),
        reference.getUTCMonth(),
        reference.getUTCDate() + relativeOffset,
      ),
    ).toISOString();
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date.toISOString();
  }

  // ISO date-time, with either `T` or a space separator. A missing timezone
  // is interpreted as UTC so the stored instant never depends on the host TZ.
  const dateTime =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw,
    );
  if (!dateTime) return null;
  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]);
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = Number(dateTime[6] ?? 0);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  const zone = dateTime[8] || "Z";
  const normalizedZone =
    zone !== "Z" && !zone.includes(":") ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const iso = `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${String(hour).padStart(2, "0")}:${String(
    minute,
  ).padStart(2, "0")}:${String(second).padStart(2, "0")}${
    dateTime[7] ? `.${dateTime[7].padEnd(3, "0").slice(0, 3)}` : ""
  }${normalizedZone}`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  // Reject overflow such as 2025-02-30T00:00:00Z.
  const date = new Date(parsed);
  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(normalizedZone);
  const offsetMinutes =
    offsetMatch
      ? (offsetMatch[1] === "-" ? -1 : 1) *
        (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
      : 0;
  const local = new Date(parsed + offsetMinutes * 60_000);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

/**
 * Fact visibility predicates. Two distinct semantics (design §2.4):
 *  - current:   expired_at IS NULL AND COALESCE(valid_at, created_at) <= now AND (invalid_at IS NULL OR invalid_at > now)
 *  - world_as_of(t): COALESCE(valid_at, created_at) <= t AND (invalid_at IS NULL OR invalid_at > t) — expired_at
 *    is intentionally ignored: the system forgetting a fact later does not make it false back then.
 */
function factVisibilityClauses(
  alias: string,
  at: string,
  asOf: string | null,
): { clauses: string[]; params: string[] } {
  const clauses = [
    `COALESCE(${alias}.valid_at, ${alias}.created_at) <= ?`,
    `(${alias}.invalid_at IS NULL OR ${alias}.invalid_at > ?)`,
  ];
  const params = [asOf ?? at, asOf ?? at];
  if (!asOf) clauses.unshift(`${alias}.expired_at IS NULL`);
  return { clauses, params };
}

export function listFacts(
  scope: MemoryScope,
  status?: string | ListFactsOptions,
  options: ListFactsOptions = {},
) {
  const opts: ListFactsOptions =
    status !== null && typeof status === "object" ? status : options;
  const statusFilter = typeof status === "string" ? status : undefined;
  const db = getDb();
  const at = opts.now ? String(opts.now) : nowIso();
  const asOf = normalizeFactAsOf(opts.asOf);
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (asOf) {
    const visibility = factVisibilityClauses("hippocampus_facts", at, asOf);
    clauses.push(...visibility.clauses);
    params.push(...visibility.params);
  } else if (statusFilter) {
    clauses.push("status = ?");
    params.push(statusFilter);
    if (statusFilter === "current") {
      const visibility = factVisibilityClauses("hippocampus_facts", at, null);
      clauses.push(...visibility.clauses);
      params.push(...visibility.params);
    }
  }
  const requestedLimit = Number(opts.limit ?? 0);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), 500)
    : null;
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_facts ${where}
       ORDER BY importance DESC, created_at DESC${limit ? ` LIMIT ${limit}` : ""}`,
    )
    .all(...params) as any[];
  const total = limit
    ? Number((db.prepare(`SELECT COUNT(*) AS c FROM hippocampus_facts ${where}`).get(...params) as { c: number }).c)
    : rows.length;
  const entityIds = [
    ...new Set(rows.flatMap((row) => [row.from_entity_id, row.to_entity_id]).filter(Boolean)),
  ];
  const entities = entityIds.length
    ? (db
        .prepare(`SELECT id, name FROM hippocampus_entities WHERE id IN (${entityIds.map(() => "?").join(",")})`)
        .all(...entityIds) as { id: string; name: string }[])
    : [];
  const entityNames = new Map(entities.map((entity) => [entity.id, entity.name]));
  return {
    items: rows.map((row) => ({
      id: row.id,
      sourceId: row.from_entity_id,
      sourceName: entityNames.get(row.from_entity_id) || row.from_entity_id,
      targetId: row.to_entity_id ?? null,
      targetName: entityNames.get(row.to_entity_id) || row.to_entity_id || "",
      relation: row.relation,
      description: row.description,
      confidence: row.confidence,
      status: row.status,
      importance: row.importance,
      isIdentity: Boolean(row.is_identity),
      evidence: parseJson(row.evidence_json, null),
      createdAt: row.created_at,
      expiredAt: row.expired_at ?? null,
      validAt: row.valid_at ?? null,
      invalidAt: row.invalid_at ?? null,
      sourceEpisodeId: row.source_episode_id ?? null,
      cardinality: row.cardinality || "many",
      supersededByFactId: row.superseded_by_fact_id ?? null,
      invalidationReason: row.invalidation_reason ?? null,
      updatedAt: row.updated_at ?? null,
    })),
    total,
    asOf,
  };
}

/**
 * Memory health for the UI: FTS readiness/row count, fact lifecycle counts and
 * digest-job status. Read-only and scoped; safe on an empty scope.
 */
export function getMemoryHealth(scope: MemoryScope) {
  const db = getDb();
  const factCounts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'current' THEN 1 ELSE 0 END) AS current,
              SUM(CASE WHEN status <> 'current' THEN 1 ELSE 0 END) AS expired
       FROM hippocampus_facts
       WHERE agent_id = ? AND user_id = ?`,
    )
    .get(scope.agentId, scope.userId) as
    | { total: number; current: number | null; expired: number | null }
    | undefined;
  const lastJob = db
    .prepare(
      `SELECT status, COALESCE(finished_at, started_at, created_at) AS at
       FROM hippocampus_digest_jobs
       WHERE agent_id = ? AND user_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(scope.agentId, scope.userId) as
    | { status: string | null; at: string | null }
    | undefined;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const failedRecent = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hippocampus_digest_jobs
       WHERE agent_id = ? AND user_id = ? AND status = 'failed'
         AND COALESCE(finished_at, created_at) >= ?`,
    )
    .get(scope.agentId, scope.userId, cutoff) as { c: number };
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hippocampus_digest_jobs
       WHERE agent_id = ? AND user_id = ? AND status = 'pending'`,
    )
    .get(scope.agentId, scope.userId) as { c: number };
  const running = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hippocampus_digest_jobs
       WHERE agent_id = ? AND user_id = ? AND status = 'running'`,
    )
    .get(scope.agentId, scope.userId) as { c: number };
  return {
    ftsReady: factFtsReady(),
    ftsRowsForScope: countFactFtsRowsForScope(scope.agentId, scope.userId),
    facts: {
      total: Number(factCounts?.total || 0),
      current: Number(factCounts?.current || 0),
      expired: Number(factCounts?.expired || 0),
    },
    digest: {
      lastStatus: lastJob?.status ?? null,
      lastAt: lastJob?.at ?? null,
      failedRecent: Number(failedRecent?.c || 0),
      pending: Number(pending?.c || 0),
      running: Number(running?.c || 0),
    },
  };
}

/** Digest job ledger for the UI, newest first. `limit` is capped at 100. */
export function listDigestJobs(scope: MemoryScope, limit = 20) {
  const db = getDb();
  const requested = Number(limit);
  const capped =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 100)
      : 20;
  const rows = db
    .prepare(
      `SELECT id, status, attempts, from_message_id, to_message_id, content_hash,
              extractor_version, prompt_version, last_error, started_at, finished_at,
              created_at
       FROM hippocampus_digest_jobs
       WHERE agent_id = ? AND user_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, capped) as any[];
  const total = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_digest_jobs
           WHERE agent_id = ? AND user_id = ?`,
        )
        .get(scope.agentId, scope.userId) as { c: number }
    ).c,
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      attempts: Number(row.attempts || 0),
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      contentHash: row.content_hash,
      extractorVersion: row.extractor_version,
      promptVersion: row.prompt_version,
      lastError: row.last_error ?? null,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
      createdAt: row.created_at,
    })),
    total,
  };
}

/**
 * Episode detail: the immutable raw row plus every derived fact (through
 * fact_sources) and stream that points back at it. Scoped; null means 404.
 */
export function getEpisodeDetail(scope: MemoryScope, episodeId: string) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM hippocampus_episodes
       WHERE id = ? AND agent_id = ? AND user_id = ?`,
    )
    .get(episodeId, scope.agentId, scope.userId) as any;
  if (!row) return null;
  let messageIds: number[] = [];
  try {
    const parsed = JSON.parse(String(row.message_ids_json || "[]"));
    if (Array.isArray(parsed)) messageIds = parsed.map((value) => Number(value));
  } catch {
    messageIds = [];
  }
  const episode = {
    id: String(row.id),
    agentId: Number(row.agent_id),
    userId: String(row.user_id),
    threadId: row.thread_id == null ? null : Number(row.thread_id),
    source: String(row.source || "chat"),
    sourceDescription: row.source_description ?? null,
    startedAt: String(row.started_at || ""),
    endedAt: String(row.ended_at || ""),
    referenceTime: String(row.reference_time || ""),
    rawContent: String(row.raw_content || ""),
    contentHash: String(row.content_hash || ""),
    messageIds,
    createdAt: String(row.created_at || ""),
  };
  const factRows = db
    .prepare(
      `SELECT f.*, src.name AS source_name, dst.name AS target_name,
              fs.evidence_quote AS source_evidence_quote,
              fs.stream_id AS source_stream_id
       FROM hippocampus_fact_sources fs
       JOIN hippocampus_facts f ON f.id = fs.fact_id
       JOIN hippocampus_entities src ON src.id = f.from_entity_id
       LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id
       WHERE fs.episode_id = ? AND f.agent_id = ? AND f.user_id = ?
       ORDER BY f.created_at ASC`,
    )
    .all(episodeId, scope.agentId, scope.userId) as any[];
  const streams = db
    .prepare(
      `SELECT * FROM hippocampus_streams
       WHERE episode_id = ? AND agent_id = ? AND user_id = ?
       ORDER BY created_at ASC`,
    )
    .all(episodeId, scope.agentId, scope.userId) as any[];
  return {
    // Match getStreamDetail: the episode row is spread at the top level, with
    // its derived facts and streams alongside it.
    ...episode,
    facts: factRows.map((fact) => ({
      ...factRowToItem(fact),
      evidenceQuote: fact.source_evidence_quote ?? null,
      sourceStreamId: fact.source_stream_id ?? null,
    })),
    streams: streams.map((stream) => ({
      ...streamToItem(stream),
      episodeId: stream.episode_id ?? null,
    })),
  };
}

/**
 * Fact provenance: fact_sources rows plus a compact episode summary
 * (source, time range, raw excerpt, message ids).
 */
export function listFactSources(scope: MemoryScope, factId: string) {
  const db = getDb();
  const fact = db
    .prepare(
      `SELECT id FROM hippocampus_facts
       WHERE id = ? AND agent_id = ? AND user_id = ?`,
    )
    .get(factId, scope.agentId, scope.userId) as { id: string } | undefined;
  if (!fact) return null;
  const rows = db
    .prepare(
      `SELECT fs.fact_id, fs.episode_id, fs.stream_id, fs.evidence_quote, fs.created_at,
              e.source AS episode_source, e.source_description, e.thread_id,
              e.started_at, e.ended_at, e.reference_time, e.raw_content, e.message_ids_json
       FROM hippocampus_fact_sources fs
       JOIN hippocampus_episodes e ON e.id = fs.episode_id
       WHERE fs.fact_id = ? AND e.agent_id = ? AND e.user_id = ?
       ORDER BY fs.created_at ASC`,
    )
    .all(factId, scope.agentId, scope.userId) as any[];
  return {
    factId,
    items: rows.map((row) => {
      let messageIds: number[] = [];
      try {
        const parsed = JSON.parse(String(row.message_ids_json || "[]"));
        if (Array.isArray(parsed)) messageIds = parsed.map((value) => Number(value));
      } catch {
        messageIds = [];
      }
      return {
        factId: String(row.fact_id),
        episodeId: String(row.episode_id),
        streamId: row.stream_id ?? null,
        evidenceQuote: row.evidence_quote ?? null,
        createdAt: String(row.created_at || ""),
        episode: {
          id: String(row.episode_id),
          source: String(row.episode_source || "chat"),
          sourceDescription: row.source_description ?? null,
          threadId: row.thread_id == null ? null : Number(row.thread_id),
          startedAt: String(row.started_at || ""),
          endedAt: String(row.ended_at || ""),
          referenceTime: String(row.reference_time || ""),
          rawExcerpt: String(row.raw_content || "").slice(0, 280),
          messageIds,
        },
      };
    }),
    total: rows.length,
  };
}

export function factRowToItem(row: any, similarity?: number) {
  return {
    id: row.id,
    sourceId: row.from_entity_id,
    sourceName: row.source_name || row.from_entity_id || "",
    targetId: row.to_entity_id ?? null,
    targetName: row.target_name || row.to_entity_id || "",
    relation: row.relation,
    description: row.description,
    confidence: row.confidence,
    status: row.status,
    importance: row.importance,
    isIdentity: Boolean(row.is_identity),
    evidence: parseJson(row.evidence_json, null),
    createdAt: row.created_at,
    expiredAt: row.expired_at ?? null,
    validAt: row.valid_at ?? null,
    invalidAt: row.invalid_at ?? null,
    sourceEpisodeId: row.source_episode_id ?? null,
    cardinality: row.cardinality || "many",
    ...(similarity === undefined ? {} : { similarity: Number(similarity.toFixed(4)) }),
  };
}

/**
 * `to_entity_id` is nullable in v23 (facts may point at a value entity that was
 * merged away / never materialised), so the destination join must be LEFT.
 */
const FACT_SELECT = `SELECT f.*, src.name AS source_name, dst.name AS target_name
  FROM hippocampus_facts f
  JOIN hippocampus_entities src ON src.id = f.from_entity_id
  LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id`;

const SELF_ENTITY_NAMES = new Set(["Self", "self", "她", "我", "助手", "agent", "assistant"]);

function isSelfEntityName(name: unknown): boolean {
  return SELF_ENTITY_NAMES.has(String(name || "").trim());
}

const FACT_VECTOR_BACKFILL_LIMIT = 50;
const ENTITY_VECTOR_BACKFILL_LIMIT = 50;
const ENTITY_VECTOR_BACKFILL_BUDGET_MS = 250;
const FACT_SEMANTIC_CANDIDATE_LIMIT = 50;
const FACT_BM25_CANDIDATE_LIMIT = 50;
const FACT_GRAPH_EDGE_LIMIT = 1000;
const FACT_RECALL_SOURCE_ORDER = ["identity", "semantic", "bm25", "graph"] as const;

type FactRecallSource = (typeof FACT_RECALL_SOURCE_ORDER)[number];

function isIdentityFactRow(row: any): boolean {
  return Boolean(row?.is_identity) || Number(row?.importance || 0) >= 0.9;
}

function factUpdatedAt(row: any): string {
  return String(row?.updated_at || row?.created_at || "");
}

function loadFactsForRecall(scope: MemoryScope, at: string, asOf: string | null): any[] {
  const visibility = factVisibilityClauses("f", at, asOf);
  const clauses = ["f.agent_id = ?", "f.user_id = ?", ...visibility.clauses];
  // status is only a cache/compat filter for current reads; world_as_of must
  // still see rows the system later expired.
  if (!asOf) clauses.push("f.status = 'current'");
  return getDb()
    .prepare(`${FACT_SELECT} WHERE ${clauses.join(" AND ")}`)
    .all(scope.agentId, scope.userId, ...visibility.params) as any[];
}

/**
 * Bounded fact-vector backfill (max 50 rows). Only explicit tools/background
 * jobs may call this; per-turn chat recall passes `backfill:false` so a turn
 * never pays an unbounded embedding bill. A missing ONNX model / vec0
 * extension stops the pass at the first failure — BM25 + entity vector + graph
 * recall still work without fact vectors.
 */
export async function backfillFactVectors(
  scope: MemoryScope,
  at: string,
  asOf: string | null,
  limit = FACT_VECTOR_BACKFILL_LIMIT,
  embed?: (text: string) => Promise<number[]>,
): Promise<void> {
  const capped = Math.max(0, Math.min(Math.floor(limit), FACT_VECTOR_BACKFILL_LIMIT));
  if (!capped) return;
  const db = getDb();
  const visibility = factVisibilityClauses("f", at, asOf);
  const clauses = ["f.agent_id = ?", "f.user_id = ?", ...visibility.clauses];
  if (!asOf) clauses.push("f.status = 'current'");
  clauses.push("TRIM(COALESCE(f.description, '')) <> ''", "v.fact_id IS NULL");
  let rows: { id: string; description: string }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT f.id, f.description
         FROM hippocampus_facts f
         LEFT JOIN fact_vec v ON v.fact_id = f.id
         WHERE ${clauses.join(" AND ")}
         ORDER BY f.updated_at DESC, f.created_at DESC
         LIMIT ?`,
      )
      .all(scope.agentId, scope.userId, ...visibility.params, capped) as {
      id: string;
      description: string;
    }[];
  } catch {
    // vec0 extension unavailable — nothing to backfill into.
    return;
  }
  for (const row of rows) {
    try {
      const vector = embed
        ? await embed(String(row.description || ""))
        : (await embedText(String(row.description || ""), { wait: true })).vector;
      if (vector.length) storeFactEmbedding(row.id, vector);
    } catch (error) {
      console.warn("[MEMORY_FACT_VEC] lazy backfill failed", {
        factId: row.id,
        message: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
}

/** Fact-vector ANN hits, scoped and time-filtered after the vec0 KNN pass. */
function searchFactVectorHits(
  scope: MemoryScope,
  queryVector: number[],
  at: string,
  asOf: string | null,
  limit: number,
): { row: any; similarity: number }[] {
  if (!queryVector.length) return [];
  const db = getDb();
  const visibility = factVisibilityClauses("f", at, asOf);
  const knnLimit = Math.max(limit * 8, 32);
  const annHits: { row: any; similarity: number }[] = [];
  try {
    const hits = db
      .prepare("SELECT fact_id, embedding, distance FROM fact_vec WHERE embedding MATCH ? AND k = ?")
      .all(vectorToBuffer(queryVector), knnLimit) as {
      fact_id: string;
      embedding: Buffer | null;
      distance: number;
    }[];
    if (hits.length) {
      const ids = hits.map((hit) => String(hit.fact_id));
      const clauses = [
        `f.id IN (${ids.map(() => "?").join(",")})`,
        "f.agent_id = ?",
        "f.user_id = ?",
        ...visibility.clauses,
      ];
      if (!asOf) clauses.push("f.status = 'current'");
      const rows = db
        .prepare(`${FACT_SELECT} WHERE ${clauses.join(" AND ")}`)
        .all(...ids, scope.agentId, scope.userId, ...visibility.params) as any[];
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      for (const hit of hits) {
        const row = byId.get(String(hit.fact_id));
        if (!row) continue;
        const embedding = bufferToVector(hit.embedding);
        const similarity = embedding.length
          ? cosineSimilarity(queryVector, embedding)
          : Math.max(0, Math.min(1, 1 - Number(hit.distance)));
        if (similarity > 0) annHits.push({ row, similarity });
      }
      annHits.sort((left, right) => right.similarity - left.similarity);
    }
  } catch {
    // fall through to the exact scan
  }
  if (annHits.length >= limit) return annHits.slice(0, limit);

  // ANN is scoped after the KNN pass, so expired/out-of-scope rows can eat the
  // candidate budget. When scoped hits fall short, finish with the exact scan
  // instead of returning a short list.
  const exactHits: { row: any; similarity: number }[] = [];
  try {
    const clauses = ["f.agent_id = ?", "f.user_id = ?", ...visibility.clauses];
    if (!asOf) clauses.push("f.status = 'current'");
    const rows = db
      .prepare(
        `SELECT f.*, src.name AS source_name, dst.name AS target_name,
                v.embedding AS fact_embedding
         FROM fact_vec v
         JOIN hippocampus_facts f ON f.id = v.fact_id
         JOIN hippocampus_entities src ON src.id = f.from_entity_id
         LEFT JOIN hippocampus_entities dst ON dst.id = f.to_entity_id
         WHERE ${clauses.join(" AND ")}`,
      )
      .all(scope.agentId, scope.userId, ...visibility.params) as any[];
    for (const row of rows) {
      const similarity = cosineSimilarity(queryVector, bufferToVector(row.fact_embedding));
      if (similarity > 0) exactHits.push({ row, similarity });
    }
  } catch {
    // vec0 unavailable: return what the ANN pass produced (possibly empty).
  }
  const byFactId = new Map<string, { row: any; similarity: number }>();
  for (const hit of [...exactHits, ...annHits]) {
    const id = String(hit.row.id);
    const previous = byFactId.get(id);
    if (!previous || hit.similarity > previous.similarity) byFactId.set(id, hit);
  }
  return [...byFactId.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);
}

/** Existing entity-vector channel, kept with a bounded lazy entity backfill. */
async function entitySemanticFactHits(
  scope: MemoryScope,
  queryVector: number[],
  cap: number,
  factRows: any[],
  backfill: boolean,
  embed?: (text: string) => Promise<number[]>,
): Promise<{ row: any; similarity: number }[]> {
  const db = getDb();
  const entityRows = db
    .prepare(
      `SELECT id, name, description, narrative, embedding FROM hippocampus_entities
       WHERE agent_id = ? AND user_id = ?`,
    )
    .all(scope.agentId, scope.userId) as {
    id: string;
    name: string | null;
    description: string | null;
    narrative: string | null;
    embedding: Buffer | null;
  }[];
  // Entities written before the embedding columns existed have no vector yet.
  // Backfill them only on explicit/background paths, at most 50 per call and
  // within a small time budget — never a full-table serial pass in chat.
  if (backfill) {
    const deadline = Date.now() + ENTITY_VECTOR_BACKFILL_BUDGET_MS;
    let backfilled = 0;
    let entityBackfillFailed = false;
    for (const row of entityRows) {
      if (entityBackfillFailed) break;
      if (backfilled >= ENTITY_VECTOR_BACKFILL_LIMIT) break;
      if (Date.now() > deadline) break;
      if (bufferToVector(row.embedding).some((value) => Math.abs(value) > 1e-12)) continue;
      const text = String(row.narrative || row.description || row.name || "").trim();
      if (!text) continue;
      try {
        const vector = embed
          ? await embed(text)
          : (await embedText(text, { wait: true })).vector;
        storeEntityEmbedding(row.id, vector);
        db.prepare(
          "UPDATE hippocampus_entities SET narrative = COALESCE(narrative, ?), updated_at = ? WHERE id = ?",
        ).run(text, nowIso(), row.id);
        row.embedding = vectorToBuffer(vector);
        backfilled += 1;
      } catch (error) {
        entityBackfillFailed = true;
        console.warn("[MEMORY_ENTITY_VEC] lazy backfill failed", {
          entityId: row.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const semanticEntities = entityRows
    .map((row) => ({
      id: row.id,
      similarity: cosineSimilarity(queryVector, bufferToVector(row.embedding)),
    }))
    .filter((row) => row.similarity > 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(10, cap * 2));
  if (!semanticEntities.length) return [];
  const similarityById = new Map(
    semanticEntities.map((row) => [row.id, row.similarity] as const),
  );
  return factRows
    .filter(
      (row) =>
        !isSelfEntityName(row.source_name) && similarityById.has(String(row.from_entity_id)),
    )
    .map((row) => ({
      row,
      similarity: similarityById.get(String(row.from_entity_id)) as number,
    }))
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        factUpdatedAt(right.row).localeCompare(factUpdatedAt(left.row)),
    )
    .slice(0, Math.max(20, cap * 4));
}

function bm25FactHits(factRows: any[], queryText: string, limit: number): any[] {
  const queryTokens = tokenize(queryText || "");
  if (!queryTokens.length || !factRows.length) return [];
  const scores = bm25Scores(
    factRows.map((row) => String(row.description || "")),
    queryTokens,
    CHAT_MEMORY_SEARCH.BM25_K1,
    CHAT_MEMORY_SEARCH.BM25_B,
  );
  return factRows
    .map((row, index) => ({ row, score: scores[index] || 0 }))
    .filter((hit) => hit.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        factUpdatedAt(right.row).localeCompare(factUpdatedAt(left.row)),
    )
    .slice(0, limit)
    .map((hit) => hit.row);
}

/**
 * One-hop expansion from hit entities over associative/provenance edges.
 * `anchorSet` plus a single expansion pass means a cycle can never make the
 * expansion run away; only depth 1 is admitted.
 */
function graphFactHits(
  scope: MemoryScope,
  anchors: string[],
  factRows: any[],
  limit: number,
): any[] {
  const ids = [...new Set(anchors.filter(Boolean))].slice(0, 40);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  let edges: { source_id: string; target_id: string }[] = [];
  try {
    edges = getDb()
      .prepare(
        `SELECT source_id, target_id FROM hippocampus_edges
         WHERE agent_id = ? AND user_id = ?
           AND edge_class IN ('associative','provenance')
           AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
         LIMIT ${FACT_GRAPH_EDGE_LIMIT}`,
      )
      .all(scope.agentId, scope.userId, ...ids, ...ids) as {
      source_id: string;
      target_id: string;
    }[];
  } catch {
    return [];
  }
  if (!edges.length) return [];
  const anchorSet = new Set(ids);
  const neighborWeight = new Map<string, number>();
  for (const edge of edges) {
    for (const endpoint of [edge.source_id, edge.target_id]) {
      if (!endpoint || anchorSet.has(endpoint)) continue;
      neighborWeight.set(endpoint, (neighborWeight.get(endpoint) || 0) + 1);
    }
  }
  if (!neighborWeight.size) return [];
  return factRows
    .filter(
      (row) =>
        !isSelfEntityName(row.source_name) &&
        (neighborWeight.has(String(row.from_entity_id)) ||
          (row.to_entity_id && neighborWeight.has(String(row.to_entity_id)))),
    )
    .map((row) => ({
      row,
      weight: Math.max(
        neighborWeight.get(String(row.from_entity_id)) || 0,
        neighborWeight.get(String(row.to_entity_id)) || 0,
      ),
    }))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        Number(right.row.importance || 0) - Number(left.row.importance || 0) ||
        factUpdatedAt(right.row).localeCompare(factUpdatedAt(left.row)),
    )
    .slice(0, limit)
    .map((hit) => hit.row);
}

function factCardinalityMap(): Map<string, "one" | "many"> {
  const map = new Map<string, "one" | "many">();
  try {
    const rows = getDb()
      .prepare("SELECT name, cardinality FROM hippocampus_predicates")
      .all() as { name: string; cardinality: string }[];
    for (const row of rows) {
      map.set(String(row.name || "").toUpperCase(), row.cardinality === "one" ? "one" : "many");
    }
  } catch {
    // registry missing — the legacy set below still protects single values
  }
  for (const relation of SINGLE_VALUE_RELATIONS) {
    if (!map.has(relation)) map.set(relation, "one");
  }
  return map;
}

export interface RecallFactsHybridInput {
  queryVector?: number[] | null;
  queryText?: string | null;
  limit?: number;
  /** RRF constant; 20–60 is the design range (never 1). */
  rrfK?: number;
  /** Alias for `rrfK` (design docs call it `k`). */
  k?: number;
  /** world_as_of instant; omit for current. */
  asOf?: string | null;
  /** Override "now" for deterministic current queries/tests. */
  now?: string | null;
  /**
   * Opt-in bounded embedding backfill. Default false: per-turn chat recall
   * must never block on a model pass. Explicit tools/background jobs can pass
   * true (still capped at 50 rows).
   */
  backfill?: boolean;
  /** Optional embedding hook for tests / explicit backfill. */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Hybrid fact recall (design §4): identity + entity/fact vector + fact BM25 +
 * one-hop graph expansion, fused with RRF. Time predicates are applied before
 * fusion so expired facts never enter the candidate pool.
 */
export async function recallFactsHybrid(
  scope: MemoryScope,
  input: RecallFactsHybridInput | number[] = {},
  limitArg?: number,
) {
  const options: RecallFactsHybridInput = Array.isArray(input)
    ? { queryVector: input, limit: limitArg }
    : input;
  const cap = Math.max(1, Math.min(Number(options.limit) || 5, 20));
  const at = options.now ? String(options.now) : nowIso();
  const asOf = normalizeFactAsOf(options.asOf);
  const rrfK = Math.max(
    10,
    Math.min(Math.floor(Number(options.rrfK ?? options.k) || 60), 1000),
  );
  const factRows = loadFactsForRecall(scope, at, asOf);
  if (!factRows.length) return [];

  const queryVector = Array.isArray(options.queryVector) ? options.queryVector : [];
  const queryText = String(options.queryText || "").trim();
  const allowBackfill = options.backfill === true;
  if (queryVector.length && allowBackfill) {
    await backfillFactVectors(scope, at, asOf, FACT_VECTOR_BACKFILL_LIMIT, options.embed);
  }

  const identityRows = factRows
    .filter((row) => !isSelfEntityName(row.source_name) && isIdentityFactRow(row))
    .sort(
      (left, right) =>
        Number(Boolean(right.is_identity)) - Number(Boolean(left.is_identity)) ||
        Number(right.importance || 0) - Number(left.importance || 0) ||
        factUpdatedAt(right).localeCompare(factUpdatedAt(left)),
    )
    .slice(0, 50);

  // BM25 channel: prefer the FTS5 pre-tokenized index (same tokenizer), and
  // fall back to the in-memory scorer when FTS5 is unavailable, empty, or the
  // query has no tokens. While legacy/imported rows are still being tokenized
  // (`description_tokens IS NULL`), the FTS index is incomplete; use the
  // in-memory scorer so the unindexed tail is not silently missed. FTS rows are
  // ordered by bm25() ASC (more negative = more relevant), so array order is
  // already the rank consumed by RRF.
  const ftsRows = searchFactFts(scope, queryText, at, asOf, FACT_BM25_CANDIDATE_LIMIT);
  const ftsIncomplete = countPendingFactFtsForScope(scope.agentId, scope.userId) > 0;
  const bm25Rows =
    ftsRows && ftsRows.length && !ftsIncomplete
      ? ftsRows
      : bm25FactHits(factRows, queryText, FACT_BM25_CANDIDATE_LIMIT);

  const semanticById = new Map<string, { row: any; similarity: number }>();
  if (queryVector.length) {
    const entityHits = await entitySemanticFactHits(
      scope,
      queryVector,
      cap,
      factRows,
      allowBackfill,
      options.embed,
    );
    const factVectorHits = searchFactVectorHits(
      scope,
      queryVector,
      at,
      asOf,
      FACT_SEMANTIC_CANDIDATE_LIMIT,
    );
    for (const hit of [...entityHits, ...factVectorHits]) {
      const id = String(hit.row.id);
      const previous = semanticById.get(id);
      if (!previous || hit.similarity > previous.similarity) semanticById.set(id, hit);
    }
  }
  const semanticHits = [...semanticById.values()]
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        factUpdatedAt(right.row).localeCompare(factUpdatedAt(left.row)),
    )
    .slice(0, FACT_SEMANTIC_CANDIDATE_LIMIT);

  const anchors = [
    ...identityRows,
    ...bm25Rows.slice(0, 10),
    ...semanticHits.slice(0, 10).map((hit) => hit.row),
  ].flatMap((row) => [row.from_entity_id, row.to_entity_id].filter(Boolean) as string[]);
  const graphRows = graphFactHits(scope, anchors, factRows, 50);

  const streams: { source: FactRecallSource; rows: any[] }[] = [
    { source: "identity", rows: identityRows },
    { source: "semantic", rows: semanticHits.map((hit) => hit.row) },
    { source: "bm25", rows: bm25Rows },
    { source: "graph", rows: graphRows },
  ];

  interface RrfCandidate {
    row: any;
    score: number;
    sources: Set<FactRecallSource>;
    similarity?: number;
    identity: boolean;
  }
  const candidates = new Map<string, RrfCandidate>();
  for (const stream of streams) {
    const seenInStream = new Set<string>();
    stream.rows.forEach((row, rank) => {
      const id = String(row.id);
      if (seenInStream.has(id)) return;
      seenInStream.add(id);
      let candidate = candidates.get(id);
      if (!candidate) {
        candidate = {
          row,
          score: 0,
          sources: new Set<FactRecallSource>(),
          identity: !isSelfEntityName(row.source_name) && isIdentityFactRow(row),
        };
        candidates.set(id, candidate);
      }
      candidate.score += 1 / (rrfK + rank + 1);
      candidate.sources.add(stream.source);
    });
  }
  const semanticSimilarity = new Map(
    semanticHits.map((hit) => [String(hit.row.id), hit.similarity] as const),
  );
  for (const candidate of candidates.values()) {
    const similarity = semanticSimilarity.get(String(candidate.row.id));
    if (similarity !== undefined) candidate.similarity = similarity;
  }

  const ranked = [...candidates.values()].sort((left, right) => {
    const byScore = right.score - left.score;
    if (Math.abs(byScore) > 1e-12) return byScore;
    if (left.identity !== right.identity) return left.identity ? -1 : 1;
    return factUpdatedAt(right.row).localeCompare(factUpdatedAt(left.row));
  });

  const cardinality = factCardinalityMap();
  const seenTriples = new Set<string>();
  const seenSingle = new Set<string>();
  const selected: RrfCandidate[] = [];
  for (const candidate of ranked) {
    const row = candidate.row;
    const subject = String(row.source_name || row.from_entity_id || "").trim();
    if (isSelfEntityName(subject)) continue;
    const relation = String(row.relation || "").trim();
    const relationUpper = relation.toUpperCase();
    const registeredCardinality = cardinality.get(relationUpper);
    const card = registeredCardinality
      ? registeredCardinality
      : String(row.cardinality || "").toLowerCase() === "one"
        ? "one"
        : "many";
    if (card === "one") {
      const singleKey = `${row.from_entity_id}|${relationUpper}`;
      if (seenSingle.has(singleKey)) continue;
      seenSingle.add(singleKey);
    }
    const tripleKey = `${row.from_entity_id}|${relation.toLowerCase()}|${
      row.to_entity_id ?? ""
    }`;
    if (seenTriples.has(tripleKey)) continue;
    seenTriples.add(tripleKey);
    selected.push(candidate);
    if (selected.length >= cap) break;
  }

  return selected.map((candidate) => {
    const source =
      FACT_RECALL_SOURCE_ORDER.find((item) => candidate.sources.has(item)) || "graph";
    return {
      ...factRowToItem(candidate.row, candidate.similarity),
      recallSource: source,
    };
  });
}

/** Backward-compatible wrapper: vector-only callers get the hybrid pipeline. */
async function recallFactsWithVector(
  scope: MemoryScope,
  queryVector: number[],
  limit: number,
) {
  return recallFactsHybrid(scope, { queryVector, limit });
}

/** Hybrid fact recall for chat/recall. Keeps `listFacts` untouched. */
export async function recallFacts(input: {
  agentId: number;
  userId?: string | null;
  query: string;
  limit?: number;
}) {
  const scope = memoryScope(input.agentId, input.userId);
  const query = String(input.query || "").trim();
  if (!query) return { items: [], total: 0, query, mode: "empty" };
  const { vector } = await embedQueryText(query, { wait: true });
  const items = await recallFactsHybrid(scope, {
    queryVector: vector,
    queryText: query,
    limit: input.limit || 5,
  });
  return { items, total: items.length, query, mode: "hybrid" };
}

export function seedGraph(scope: MemoryScope) {
  const db = getDb();
  const seeds = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ?")
    .all(scope.agentId, scope.userId) as any[];
  const seedIds = new Set(seeds.map((row) => row.id));
  const edges = db
    .prepare(
      "SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? AND edge_type IN ('EVOKES','RELATES')",
    )
    .all(scope.agentId, scope.userId) as any[];
  const streamIds = [...new Set(edges.filter((edge) => edge.edge_type === "EVOKES").map((edge) => edge.target_id))];
  const streams = streamIds.length
    ? (db
        .prepare(`SELECT * FROM hippocampus_streams WHERE id IN (${streamIds.map(() => "?").join(",")})`)
        .all(...streamIds) as any[])
    : [];
  return {
    seeds: seeds.map((row) => ({ ...seedToItem(row), autoMutable: isSeedAutoMutable(scope, row) })),
    streams: streams.map(streamToItem),
    edges: edges
      .filter((edge) => edge.edge_type !== "RELATES" || (seedIds.has(edge.source_id) && seedIds.has(edge.target_id)))
      .map((edge) => ({
        type: edge.edge_type,
        source_id: edge.source_id,
        target_id: edge.target_id,
        weight: edge.weight,
      })),
  };
}

export function getOverview(scope: MemoryScope) {
  const db = getDb();
  const count = (table: string, extra = "", params: any[] = []) =>
    Number((db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE agent_id = ? AND user_id = ? ${extra}`)
      .get(scope.agentId, scope.userId, ...params) as { c: number }).c);
  const recentStreams = db
    .prepare(
      "SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 ORDER BY created_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentSeeds = db
    .prepare(
      "SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentFacts = db
    .prepare(
      "SELECT * FROM hippocampus_facts WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 5",
    )
    .all(scope.agentId, scope.userId) as any[];
  const recentDigests = db
    .prepare(
      "SELECT * FROM hippocampus_tick_log WHERE agent_id = ? AND user_id = ? ORDER BY triggered_at DESC LIMIT 3",
    )
    .all(scope.agentId, scope.userId) as any[];
  const selfState = getSelfState(scope);
  return {
    counts: {
      streams: count("hippocampus_streams", "AND archived = 0"),
      streamsExternal: count("hippocampus_streams", "AND archived = 0 AND type = 'external'"),
      streamsInternal: count("hippocampus_streams", "AND archived = 0 AND type = 'internal'"),
      seeds: count("hippocampus_seeds"),
      seedsActive: count("hippocampus_seeds", "AND COALESCE(status, 'active') = 'active'"),
      seedsRetired: count("hippocampus_seeds", "AND status = 'retired'"),
      factsCurrent: count("hippocampus_facts", "AND status = 'current'"),
      factsExpired: count("hippocampus_facts", "AND status != 'current'"),
      threads: count("hippocampus_threads"),
      threadsOpen: count("hippocampus_threads", "AND status = 'open'"),
      constraints: count("hippocampus_constraints"),
      appointments: count("hippocampus_appointments"),
    },
    selfState,
    recent: {
      streams: recentStreams.map(streamToItem),
      seeds: recentSeeds.map(seedToItem),
      facts: recentFacts.map((row) => ({
        id: row.id,
        relation: row.relation,
        description: row.description,
        confidence: row.confidence,
        status: row.status,
      })),
      digests: recentDigests.map(tickToItem),
    },
  };
}

export function getStats(scope: MemoryScope) {
  const db = getDb();
  const count = (table: string) =>
    Number((db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE agent_id = ? AND user_id = ?`)
      .get(scope.agentId, scope.userId) as { c: number }).c);
  const kindRows = db
    .prepare(
      "SELECT kind, COUNT(*) AS c FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? GROUP BY kind",
    )
    .all(scope.agentId, scope.userId) as { kind: string; c: number }[];
  const roleRows = db
    .prepare(
      "SELECT type, COUNT(*) AS c FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? GROUP BY type",
    )
    .all(scope.agentId, scope.userId) as { type: string; c: number }[];
  return {
    distribution: {
      entities: count("hippocampus_entities"),
      facts: count("hippocampus_facts"),
      threads: count("hippocampus_threads"),
      streams: count("hippocampus_streams"),
      seeds: count("hippocampus_seeds"),
      // v23: entityTypes now groups by kind (person/location/...); roles is
      // the legacy `type` split (user/self/other) kept for old callers.
      entityTypes: Object.fromEntries(kindRows.map((row) => [row.kind || "other", Number(row.c)])),
      roles: Object.fromEntries(roleRows.map((row) => [row.type || "other", Number(row.c)])),
    },
    topKeywords: [],
  };
}

export function memoryGraph(scope: MemoryScope, limit = 120) {
  const db = getDb();
  const streams = db
    .prepare(
      "SELECT * FROM hippocampus_streams WHERE agent_id = ? AND user_id = ? AND archived = 0 LIMIT ?",
    )
    .all(scope.agentId, scope.userId, limit) as any[];
  const seeds = db
    .prepare("SELECT * FROM hippocampus_seeds WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const threads = db
    .prepare("SELECT * FROM hippocampus_threads WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const relationshipThreads = db
    .prepare(
      `SELECT * FROM relationship_threads
       WHERE agent_id = ? AND user_id = ?
       ORDER BY last_at DESC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, limit) as any[];
  const edges = db
    .prepare("SELECT * FROM hippocampus_edges WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit * 4) as any[];
  const entities = db
    .prepare("SELECT * FROM hippocampus_entities WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit) as any[];
  const facts = db
    .prepare(
      `SELECT * FROM hippocampus_facts
       WHERE agent_id = ? AND user_id = ? AND expired_at IS NULL AND status = 'current'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope.agentId, scope.userId, limit * 2) as any[];
  const touchpoints = db
    .prepare("SELECT * FROM hippocampus_touchpoints WHERE agent_id = ? AND user_id = ? LIMIT ?")
    .all(scope.agentId, scope.userId, limit * 3) as any[];
  // APP relationship threads are the live 心事线 model; hippocampus_threads is
  // the retired desktop table and is usually empty. Relationship rows win on
  // id collision so the graph shows the current summary watermarks.
  const relationshipThreadIds = new Set(relationshipThreads.map((row) => String(row.id)));
  const threadNodes = [
    ...relationshipThreads.map((row) => ({
      id: row.id,
      label: row.title,
      type: "Thread",
      nodeClass:
        String(row.status || "").toLowerCase() === "closed" ? "thread-closed" : "thread-open",
      properties: {
        ...row,
        title: row.title,
        last_note: row.summary,
        current_grip: 0,
        summary_covered_message_id: row.summary_covered_message_id ?? null,
        summary_covered_at: row.summary_covered_at ?? null,
        summary_updated_at: row.summary_updated_at ?? null,
      },
    })),
    ...threads
      .filter((row) => !relationshipThreadIds.has(String(row.id)))
      .map((row) => ({
        id: row.id,
        label: row.title,
        type: "Thread",
        nodeClass:
          String(row.status || "").toLowerCase() === "closed" ? "thread-closed" : "thread-open",
        properties: row,
      })),
  ];
  const nodes = [
    ...streams.map((row) => ({
      id: row.id,
      label: String(row.narrative || "").slice(0, 40),
      type: "Stream",
      nodeClass: "stream",
      properties: streamToItem(row),
    })),
    ...seeds.map((row) => ({
      id: row.id,
      label: row.wake_text || row.inner_orientation,
      type: "Seed",
      nodeClass: "seed",
      properties: seedToItem(row),
    })),
    ...threadNodes,
    ...entities.map((row) => {
      // v23 separates perspective role (user/self/other) from entity kind
      // (person/location/...). `type` is only the legacy fallback.
      const role = String(row.role ?? row.type ?? "").toLowerCase();
      const kind = String(row.kind ?? "").toLowerCase();
      const legacyType = String(row.type ?? "").toLowerCase();
      const knownKind = [
        "person",
        "location",
        "organization",
        "pet",
        "object",
        "concept",
        "activity",
        "event",
        "theme",
        "emotion",
      ].includes(kind)
        ? kind
        : ["person", "location", "organization", "pet", "object", "concept", "activity", "event", "theme", "emotion"].includes(legacyType)
          ? legacyType
          : "";
      const nodeClass =
        role === "user"
          ? "entity-user"
          : role === "self"
            ? "self"
            : knownKind
              ? `entity-${knownKind}`
              : "entity-other";
      return {
        id: row.id,
        label: row.name,
        type: "Entity",
        nodeClass,
        properties: row,
      };
    }),
    ...touchpoints.map((row) => ({
      id: row.id,
      label: String(row.stance_note || row.episode_ref || "").slice(0, 40),
      type: "Touchpoint",
      nodeClass: "touchpoint",
      properties: {
        ...row,
        affect: parseJson(row.affect_json, null),
      },
    })),
  ];
  return {
    source: "sqlite_all",
    nodes,
    links: [
      ...edges.map((edge) => ({
        id: String(edge.id),
        source: edge.source_id,
        target: edge.target_id,
        type: edge.edge_type,
        properties: { weight: edge.weight },
      })),
      ...facts.map((fact) => ({
        id: fact.id,
        source: fact.from_entity_id,
        target: fact.to_entity_id,
        type: fact.relation,
        properties: {
          description: fact.description,
          confidence: fact.confidence,
          importance: fact.importance,
          validAt: fact.valid_at ?? null,
          invalidAt: fact.invalid_at ?? null,
          cardinality: fact.cardinality || "many",
        },
      })),
      ...touchpoints.map((point) => ({
        id: `thread-${point.id}`,
        source: point.thread_id,
        target: point.id,
        type: "HAS_TOUCHPOINT",
        properties: { grip: point.grip, createdAt: point.created_at },
      })),
    ],
    clusters: {},
  };
}

export function listMemoryThreads(scope: MemoryScope) {
  const db = getDb();
  const threads = db
    .prepare(
      "SELECT * FROM hippocampus_threads WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC",
    )
    .all(scope.agentId, scope.userId) as any[];
  // Additive compatibility field: the live APP 心事线 lives in
  // relationship_threads. The existing `threads` shape stays untouched.
  const relationshipThreads = db
    .prepare(
      `SELECT id, title, summary, status, first_at, last_at,
              summary_covered_message_id, summary_covered_at, summary_updated_at
       FROM relationship_threads
       WHERE agent_id = ? AND user_id = ?
       ORDER BY last_at DESC`,
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    threads: threads.map((row) => {
      const touchpoints = db
        .prepare(
          "SELECT * FROM hippocampus_touchpoints WHERE thread_id = ? ORDER BY created_at ASC",
        )
        .all(row.id) as any[];
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        owner: row.owner,
        current_grip: Number(row.current_grip || 0),
        last_note: row.last_note,
        created_at: row.created_at,
        updated_at: row.updated_at,
        touchpoints: touchpoints.map((point) => ({
          id: point.id,
          thread_id: point.thread_id,
          episode_ref: point.episode_ref,
          grip: Number(point.grip || 0),
          stance_note: point.stance_note,
          affect_json: parseJson(point.affect_json, null),
          created_at: point.created_at,
        })),
      };
    }),
    relationshipThreads: relationshipThreads.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      first_at: row.first_at,
      last_at: row.last_at,
      summary_covered_message_id: row.summary_covered_message_id ?? null,
      summary_covered_at: row.summary_covered_at ?? null,
      summary_updated_at: row.summary_updated_at ?? null,
    })),
  };
}

export function clearAllMemory(scope: MemoryScope) {
  const db = getDb();
  // Invalidate every in-flight digest/seed task before deleting. A task that
  // started before this call must never write into the fresh memory.
  invalidateMemoryTasks(scope.agentId, scope.userId);
  // Sweep the sqlite-vec shadow rows while the source ids still exist, so the
  // ANN index cannot keep voting for deleted memories (see deleteScopeVecRows).
  deleteScopeVecRows(scope.agentId, scope.userId);
  const tables = [
    "hippocampus_streams",
    "hippocampus_seeds",
    "hippocampus_seed_versions",
    "hippocampus_entity_aliases",
    "hippocampus_entity_merges",
    "hippocampus_episodes",
    "hippocampus_digest_jobs",
    "hippocampus_entities",
    "hippocampus_facts",
    "hippocampus_edges",
    "hippocampus_threads",
    "hippocampus_touchpoints",
    "hippocampus_constraints",
    "hippocampus_appointments",
    "hippocampus_tick_log",
    "hippocampus_self_state",
    "hippocampus_self_state_daily",
    "hippocampus_baselines",
    "hippocampus_affect_points",
    "hippocampus_affect_daily",
    "hippocampus_recall_traces",
    "hippocampus_retrospect_buckets",
    "hippocampus_portraits",
    "digest_state",
    "conversation_anchors",
    // The anchor's usage trigger signal describes the cleared context; a fresh
    // memory must re-measure from the next reported request.
    "chat_usage_state",
    "agent_state_changes",
    "relationship_thread_nodes",
    "relationship_threads",
  ];
  const tx = db.transaction(() => {
    // FTS has no scope columns; resolve ids before the facts disappear.
    deleteFactFtsForScope(scope.agentId, scope.userId);
    // fact_sources has no agent_id/user_id of its own; scope it through both
    // endpoints before the facts/episodes rows disappear.
    db.prepare(
      `DELETE FROM hippocampus_fact_sources
       WHERE fact_id IN (SELECT id FROM hippocampus_facts WHERE agent_id = ? AND user_id = ?)
          OR episode_id IN (SELECT id FROM hippocampus_episodes WHERE agent_id = ? AND user_id = ?)`,
    ).run(scope.agentId, scope.userId, scope.agentId, scope.userId);
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND user_id = ?`).run(
        scope.agentId,
        scope.userId,
      );
    }
    db.prepare("DELETE FROM proactive_routes WHERE agent_id = ?").run(scope.agentId);
  });
  tx();
  return { status: "ok", message: "Cleared companion memory for agent/user" };
}

// ─── Retrospect / affect / self state ───────────────────────────────────────

export function getBaseline(scope: MemoryScope) {
  return getBaselineItem(scope);
}

export function getAffectTimeline(scope: MemoryScope, limit = 200, granularity = "turn") {
  return readAffectTimeline(scope, limit, granularity);
}

function calendarGranularity(value: string): CalendarGranularity {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["week", "month", "quarter", "year"].includes(normalized)) {
    throw Object.assign(new Error("invalid_granularity"), { code: "invalid_granularity" });
  }
  return normalized as CalendarGranularity;
}

export function listRetrospectBuckets(scope: MemoryScope, granularity: string) {
  return witnessListRetrospectBuckets(scope, calendarGranularity(granularity));
}

export function getRetrospect(scope: MemoryScope, granularity: string, bucketKey?: string) {
  return witnessGetRetrospect(scope, calendarGranularity(granularity), bucketKey ?? null);
}

export async function recomputeRetrospect(scope: MemoryScope, granularity: string, bucketKey?: string) {
  return witnessRecomputeRetrospect(scope, calendarGranularity(granularity), bucketKey ?? null);
}

export function getSelfState(scope: MemoryScope) {
  const derived = deriveSelfState(scope);
  return {
    closeness: derived.closeness,
    closenessTrend: derived.closenessTrend,
    intimacyTier: derived.intimacyTier,
    templateRisk: derived.templateRisk,
    trendState: derived.trendState,
  };
}

export function selfStateHistory(scope: MemoryScope, limit = 200) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_self_state WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(scope.agentId, scope.userId, Math.max(1, Math.min(limit, 1000))) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      turnId: row.turn_id,
      closeness: row.closeness,
      closenessTrend: row.closeness_trend,
      intimacyTier: row.intimacy_tier,
      templateRisk: row.template_risk,
      createdAt: row.created_at,
      granularity: row.granularity,
      sampleCount: row.sample_count,
      period: row.period,
    })),
    total: rows.length,
  };
}

export function getMirror(scope: MemoryScope) {
  return witnessGetMirror(scope);
}

export function listConstraints(scope: MemoryScope) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_constraints WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC",
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      ruleType: row.rule_type,
      description: row.description,
      optOutProactive: Boolean(row.opt_out_proactive),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      evidence: row.evidence,
      segmentRef: row.segment_ref,
      createdAt: row.created_at,
    })),
    total: rows.length,
  };
}

export function deleteConstraint(scope: MemoryScope, id: number) {
  const info = getDb()
    .prepare("DELETE FROM hippocampus_constraints WHERE id = ? AND agent_id = ? AND user_id = ?")
    .run(id, scope.agentId, scope.userId);
  return info.changes > 0;
}

export function listAppointments(scope: MemoryScope) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM hippocampus_appointments WHERE agent_id = ? AND user_id = ? ORDER BY due_at ASC",
    )
    .all(scope.agentId, scope.userId) as any[];
  return {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: row.due_at,
      allDay: Boolean(row.all_day),
      recur: row.recur,
      status: row.status,
      evidence: row.evidence,
      evidenceTurnId: row.evidence_turn_id,
      lastDeliveredAt: row.last_delivered_at,
      // M3 manage_alarm: exact | date_only (NULL reads as exact for legacy rows).
      timeMode: row.time_mode || null,
      eventDate: row.event_date || null,
      createdAt: row.created_at,
    })),
    total: rows.length,
  };
}

// ─── Tick log / turns ───────────────────────────────────────────────────────

export function listTickLog(
  scope: MemoryScope,
  filters: { tickTypes?: string[]; outcomes?: string[]; since?: string; until?: string; limit?: number; offset?: number },
) {
  const clauses = ["agent_id = ?", "user_id = ?"];
  const params: any[] = [scope.agentId, scope.userId];
  if (filters.tickTypes?.length) {
    clauses.push(`tick_type IN (${filters.tickTypes.map(() => "?").join(",")})`);
    params.push(...filters.tickTypes);
  }
  if (filters.outcomes?.length) {
    clauses.push(`outcome IN (${filters.outcomes.map(() => "?").join(",")})`);
    params.push(...filters.outcomes);
  }
  if (filters.since) {
    clauses.push("triggered_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push("triggered_at <= ?");
    params.push(filters.until);
  }
  const db = getDb();
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM hippocampus_tick_log WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT * FROM hippocampus_tick_log WHERE ${clauses.join(" AND ")}
       ORDER BY triggered_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.max(1, Math.min(filters.limit || 100, 500)), Math.max(0, filters.offset || 0)) as any[];
  return { items: rows.map(tickToItem), total: Number(total) };
}

export function clearTickLog(scope: MemoryScope) {
  getDb()
    .prepare("DELETE FROM hippocampus_tick_log WHERE agent_id = ? AND user_id = ?")
    .run(scope.agentId, scope.userId);
  return { status: "ok", message: "Cleared all tick logs successfully" };
}

export function listMemoryTurns(agentId: number, userId: string | null | undefined, start: number, end: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE agent_id = ? AND user_id = ? AND id >= ? AND id <= ? AND role = 'assistant'
       ORDER BY id ASC`,
    )
    .all(agentId, normalizeUserId(userId), start, end) as any[];
  return {
    items: rows.map((row) => {
      const user = row.reply_to_message_id
        ? (db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(row.reply_to_message_id) as any)
        : null;
      return {
        id: row.id,
        user_message: user?.content ?? null,
        assistant_message: row.content,
        created_at: row.created_at,
        emotional_analysis: parseJson(row.emotional_analysis, null),
        retrieved_facts: parseJson(row.retrieved_facts, null),
      };
    }),
  };
}

export function getMemoryTurn(agentId: number, userId: string | null | undefined, turnId: number) {
  const result = listMemoryTurns(agentId, userId, turnId, turnId);
  return result.items[0] || null;
}
