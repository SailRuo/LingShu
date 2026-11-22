import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-recall-v2-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "0";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const promptBlocks = await import("../src/services/memoryPromptBlocks.js");
const embedding = await import("../src/services/embeddingService.js");

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

function insertEntity(
  agentId: number,
  userId: string,
  name: string,
  options: { kind?: string; embedding?: number[] } = {},
): string {
  const id = `entity-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const vector = options.embedding ?? new Array(768).fill(0);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', ?, '[]', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentId,
    userId,
    name,
    options.kind ?? "other",
    name,
    Buffer.from(new Float32Array(vector).buffer),
    vector.length,
    now,
    now,
  );
  return id;
}

function insertFact(input: {
  agentId: number;
  userId?: string;
  fromEntityId: string;
  toEntityId?: string | null;
  relation: string;
  description: string;
  confidence?: number;
  importance?: number;
  isIdentity?: boolean;
  status?: string;
  validAt?: string | null;
  invalidAt?: string | null;
  expiredAt?: string | null;
  cardinality?: "one" | "many";
  sourceEpisodeId?: string | null;
  createdAt?: string;
}): string {
  const id = `fact-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_facts
      (id, agent_id, user_id, from_entity_id, to_entity_id, relation, description,
       confidence, importance, is_identity, status, valid_at, invalid_at, created_at,
       updated_at, expired_at, source_episode_id, cardinality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.userId ?? "default_user",
    input.fromEntityId,
    input.toEntityId ?? null,
    input.relation,
    input.description,
    input.confidence ?? 0.8,
    input.importance ?? 0.5,
    input.isIdentity ? 1 : 0,
    input.status ?? "current",
    input.validAt ?? null,
    input.invalidAt ?? null,
    now,
    now,
    input.expiredAt ?? null,
    input.sourceEpisodeId ?? null,
    input.cardinality ?? "many",
  );
  return id;
}

function unitVector(index: number): number[] {
  const vector = new Array(768).fill(0);
  vector[index] = 1;
  return vector;
}

function insertEpisode(agentId: number, userId: string, rawContent: string): string {
  const id = `episode-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO hippocampus_episodes
      (id, agent_id, user_id, thread_id, source, source_description, started_at, ended_at,
       reference_time, raw_content, content_hash, message_ids_json, created_at)
     VALUES (?, ?, ?, NULL, 'chat', 'digest:test', ?, ?, ?, ?, ?, '[]', ?)`,
  ).run(id, agentId, userId, now, now, now, rawContent, `hash-${id}`, now);
  return id;
}

test("current hides a soft-invalidated old fact; world_as_of returns it", async () => {
  const agentId = createAgent("时间窗");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const shanghai = insertEntity(agentId, "default_user", "上海", { kind: "location" });
  const hangzhou = insertEntity(agentId, "default_user", "杭州", { kind: "location" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: shanghai,
    relation: "LIVES_IN",
    description: "他住在上海",
    validAt: "2024-01-01T00:00:00.000Z",
    invalidAt: "2025-01-01T00:00:00.000Z",
    expiredAt: "2025-01-01T00:00:00.000Z",
    status: "expired",
    cardinality: "one",
  });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: hangzhou,
    relation: "LIVES_IN",
    description: "他住在杭州",
    validAt: "2025-01-01T00:00:00.000Z",
    cardinality: "one",
  });

  const current = memory.listFacts(scope, "current");
  assert.deepEqual(current.items.map((item: any) => item.description), ["他住在杭州"]);

  const asOf = "2024-06-01T00:00:00.000Z";
  const historical = memory.listFacts(scope, undefined, { asOf });
  assert.equal(historical.asOf, asOf);
  assert.equal(historical.total, 1);
  assert.equal(historical.items[0].description, "他住在上海");
  assert.equal(historical.items[0].expiredAt, "2025-01-01T00:00:00.000Z");
  assert.equal(historical.items[0].invalidAt, "2025-01-01T00:00:00.000Z");

  // The recall pipeline must apply the same predicate before ranking.
  const currentRecall = await memory.recallFactsHybrid(scope, {
    queryText: "上海",
    limit: 5,
    backfill: false,
  }) as any;
  assert.equal(currentRecall.length, 0);
  const historicalRecall = await memory.recallFactsHybrid(scope, {
    queryText: "上海",
    asOf,
    limit: 5,
    backfill: false,
  }) as any;
  assert.equal(historicalRecall.length, 1);
  assert.equal(historicalRecall[0].description, "他住在上海");
});

test("multi-value LIKES facts both survive dedupe", async () => {
  const agentId = createAgent("多值召回");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const coffee = insertEntity(agentId, "default_user", "咖啡", { kind: "object" });
  const tea = insertEntity(agentId, "default_user", "茶", { kind: "object" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢咖啡",
    validAt: "2024-01-01T00:00:00.000Z",
  });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: tea,
    relation: "LIKES",
    description: "他喜欢茶",
    validAt: "2024-01-01T00:00:00.000Z",
  });

  const items = await memory.recallFactsHybrid(scope, {
    queryText: "喜欢",
    limit: 5,
    backfill: false,
  }) as any[];
  assert.deepEqual(
    new Set(items.map((item) => item.description)),
    new Set(["他喜欢咖啡", "他喜欢茶"]),
  );
});

test("BM25 recalls a keyword fact even when the entity vector is orthogonal", async () => {
  const agentId = createAgent("bm25");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", {
    kind: "person",
    embedding: unitVector(0),
  });
  const coffee = insertEntity(agentId, "default_user", "手冲咖啡", { kind: "object" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢手冲咖啡",
    validAt: "2024-01-01T00:00:00.000Z",
  });

  const items = await memory.recallFactsHybrid(scope, {
    queryText: "手冲咖啡",
    queryVector: unitVector(1),
    limit: 5,
    backfill: false,
  }) as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].description, "他喜欢手冲咖啡");
  assert.equal(items[0].recallSource, "bm25");
});

test("fact_vec channel recalls a semantic fact when the entity vector misses", async () => {
  const agentId = createAgent("fact-vector");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", {
    kind: "person",
    embedding: unitVector(1),
  });
  const object = insertEntity(agentId, "default_user", "天文", { kind: "concept" });
  const factId = insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: object,
    relation: "INTERESTED_IN",
    description: "他对天文有兴趣",
    validAt: "2024-01-01T00:00:00.000Z",
  });
  embedding.storeFactEmbedding(factId, unitVector(0));

  const items = (await memory.recallFactsHybrid(scope, {
    queryVector: unitVector(0),
    queryText: "",
    limit: 5,
    backfill: false,
  })) as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].description, "他对天文有兴趣");
  assert.equal(items[0].recallSource, "semantic");
  assert.equal(items[0].similarity, 1);
});

test("prompt fact lines append YYYY-MM time windows", () => {
  const lines = promptBlocks.factLinesFromItems([
    {
      sourceName: "他",
      description: "他住在上海",
      validAt: "2024-03-15T08:00:00.000Z",
      invalidAt: "2025-01-10T08:00:00.000Z",
    },
    {
      sourceName: "他",
      description: "他搬到杭州",
      validAt: "2024-03-01T00:00:00.000Z",
    },
    {
      sourceName: "他",
      description: "他以前养猫",
      invalidAt: "2025-01-01T00:00:00.000Z",
    },
    {
      sourceName: "他",
      description: "他一直怕冷",
    },
  ]);
  assert.deepEqual(lines, [
    "他住在上海（2024-03 至 2025-01）。",
    "他搬到杭州（2024-03 起）。",
    "他以前养猫（至 2025-01）。",
    "他一直怕冷。",
  ]);
});

test("facts asOf service query returns items/total/asOf and auditable expiredAt", () => {
  const agentId = createAgent("asOf接口");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const oldJob = insertEntity(agentId, "default_user", "甲公司", { kind: "organization" });
  const newJob = insertEntity(agentId, "default_user", "乙公司", { kind: "organization" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: oldJob,
    relation: "OCCUPATION",
    description: "他在甲公司上班",
    validAt: "2024-02-01T00:00:00.000Z",
    invalidAt: "2025-02-01T00:00:00.000Z",
    expiredAt: "2025-02-01T00:00:00.000Z",
    status: "expired",
    cardinality: "one",
  });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: newJob,
    relation: "OCCUPATION",
    description: "他在乙公司上班",
    validAt: "2025-02-01T00:00:00.000Z",
    cardinality: "one",
  });

  const result = memory.listFacts(scope, undefined, {
    asOf: "2024-08-01T00:00:00.000Z",
    limit: 10,
  });
  assert.equal(result.asOf, "2024-08-01T00:00:00.000Z");
  assert.equal(result.total, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description, "他在甲公司上班");
  assert.ok(result.items[0].expiredAt);
  assert.equal(result.items[0].cardinality, "one");

  const current = memory.listFacts(scope, "current", { limit: 10 });
  assert.equal(current.total, 1);
  assert.equal(current.items[0].description, "他在乙公司上班");
});

test("episode detail and fact sources stay inside the agent/user scope", () => {
  const agentId = createAgent("episode详情");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const object = insertEntity(agentId, "default_user", "杭州", { kind: "location" });
  const episodeId = insertEpisode(agentId, "default_user", "[user] 我搬到杭州了\n[assistant] 挺好的。");
  const factId = insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: object,
    relation: "LIVES_IN",
    description: "他住在杭州",
    validAt: "2024-01-01T00:00:00.000Z",
    cardinality: "one",
    sourceEpisodeId: episodeId,
  });
  db.prepare(
    `INSERT INTO hippocampus_fact_sources
      (fact_id, episode_id, stream_id, evidence_quote, created_at)
     VALUES (?, ?, NULL, '我搬到杭州了', ?)`,
  ).run(factId, episodeId, new Date().toISOString());
  const streamId = `stream-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  db.prepare(
    `INSERT INTO hippocampus_streams
      (id, agent_id, user_id, narrative, about, type, significance, created_at, updated_at,
       archived, episode_id)
     VALUES (?, ?, ?, '他搬到了杭州。', '他·日常', 'external', 0.5, ?, ?, 0, ?)`,
  ).run(streamId, agentId, "default_user", new Date().toISOString(), new Date().toISOString(), episodeId);

  const detail = memory.getEpisodeDetail(scope, episodeId) as any;
  assert.equal(detail.id, episodeId);
  assert.equal(detail.rawContent.includes("我搬到杭州了"), true);
  assert.equal(detail.facts.length, 1);
  assert.equal(detail.facts[0].id, factId);
  assert.equal(detail.facts[0].evidenceQuote, "我搬到杭州了");
  assert.equal(detail.streams.length, 1);
  assert.equal(detail.streams[0].id, streamId);

  const sources = memory.listFactSources(scope, factId) as any;
  assert.equal(sources.total, 1);
  assert.equal(sources.items[0].episodeId, episodeId);
  assert.equal(sources.items[0].evidenceQuote, "我搬到杭州了");
  assert.ok(sources.items[0].episode.rawExcerpt.includes("我搬到杭州了"));

  assert.equal(memory.getEpisodeDetail(memory.memoryScope(agentId + 1, "default_user"), episodeId), null);
  assert.equal(memory.listFactSources(memory.memoryScope(agentId + 1, "default_user"), factId), null);
});

test("memoryGraph keeps the current fact even when 300 newer historical facts exist", () => {
  const agentId = createAgent("graph-limit");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const object = insertEntity(agentId, "default_user", "上海", { kind: "location" });
  const currentId = insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: object,
    relation: "LIVES_IN",
    description: "他住在上海",
    validAt: "2020-01-01T00:00:00.000Z",
    cardinality: "one",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  for (let index = 0; index < 300; index += 1) {
    insertFact({
      agentId,
      fromEntityId: subject,
      toEntityId: object,
      relation: "LIKES",
      description: `历史事实 ${index}`,
      status: "expired",
      expiredAt: "2025-01-01T00:00:00.000Z",
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    });
  }

  const graph = memory.memoryGraph(scope, 10);
  const factLinks = graph.links.filter((link: any) => link.type === "LIVES_IN");
  assert.equal(factLinks.length, 1);
  assert.equal(factLinks[0].id, currentId);
  assert.equal(graph.nodes.length > 0, true);
});

test("getStats groups entityTypes by kind and keeps roles by type", () => {
  const agentId = createAgent("stats-kind");
  const scope = memory.memoryScope(agentId, "default_user");
  insertEntity(agentId, "default_user", "小明", { kind: "person" });
  insertEntity(agentId, "default_user", "上海", { kind: "location" });
  const stats = memory.getStats(scope);
  assert.equal(stats.distribution.entityTypes.person, 1);
  assert.equal(stats.distribution.entityTypes.location, 1);
  assert.equal(stats.distribution.roles.other, 2);
});

test("recallFactsHybrid does not backfill embeddings unless explicitly opted in", async () => {
  const agentId = createAgent("no-backfill");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const object = insertEntity(agentId, "default_user", "航海模型", { kind: "concept" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: object,
    relation: "INTERESTED_IN",
    description: "他对航海模型有兴趣",
    validAt: "2024-01-01T00:00:00.000Z",
  });

  let embedCalls = 0;
  const embed = async () => {
    embedCalls += 1;
    return unitVector(0);
  };
  await memory.recallFactsHybrid(scope, {
    queryVector: unitVector(0),
    queryText: "航海模型",
    limit: 5,
    embed,
  });
  assert.equal(embedCalls, 0, "default recall must not await embedding backfill");
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM fact_vec WHERE fact_id IN (SELECT id FROM hippocampus_facts WHERE agent_id = ?)").get(agentId) as any).c),
    0,
  );

  await memory.recallFactsHybrid(scope, {
    queryVector: unitVector(0),
    queryText: "",
    limit: 5,
    backfill: true,
    embed,
  });
  assert.ok(embedCalls > 0, "explicit backfill uses the injectable embed hook");
});

test("recall dedupe keys use entity ids, not display names", async () => {
  const agentId = createAgent("同名去重");
  const scope = memory.memoryScope(agentId, "default_user");
  const firstXiaoming = insertEntity(agentId, "default_user", "小明", { kind: "person" });
  const secondXiaoming = insertEntity(agentId, "default_user", "小明", { kind: "person" });
  const friend = insertEntity(agentId, "default_user", "小红", { kind: "person" });
  insertFact({
    agentId,
    fromEntityId: firstXiaoming,
    toEntityId: friend,
    relation: "HAS_FRIEND",
    description: "小明和小红是朋友",
    validAt: "2024-01-01T00:00:00.000Z",
  });
  insertFact({
    agentId,
    fromEntityId: secondXiaoming,
    toEntityId: friend,
    relation: "HAS_FRIEND",
    description: "小明和小红是朋友",
    validAt: "2024-01-01T00:00:00.000Z",
  });

  const items = (await memory.recallFactsHybrid(scope, {
    queryText: "小红",
    limit: 5,
    backfill: false,
  })) as any[];
  const subjects = new Set(items.map((item) => item.sourceId));
  assert.equal(subjects.size, 2, "two different 小明 ids must not collapse into one dedupe key");
});

test("fact-vector search falls back to the exact scan when scoped ANN hits are short", async () => {
  const agentId = createAgent("ann-fallback");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  const coffee = insertEntity(agentId, "default_user", "咖啡", { kind: "object" });
  const tea = insertEntity(agentId, "default_user", "茶", { kind: "object" });

  const coffeeFact = insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: coffee,
    relation: "LIKES",
    description: "他喜欢咖啡",
    validAt: "2024-01-01T00:00:00.000Z",
  });
  const teaFact = insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: tea,
    relation: "LIKES",
    description: "他喜欢茶",
    validAt: "2024-01-01T00:00:00.000Z",
  });
  embedding.storeFactEmbedding(coffeeFact, unitVector(0));
  const nearUnit = unitVector(0);
  nearUnit[1] = 0.1;
  embedding.storeFactEmbedding(teaFact, nearUnit);

  // Other agents' facts fill the global KNN top-400 so only one of this
  // scope's two vectors survives the scoped ANN pass. The exact scan must
  // still recover both.
  const otherAgent = createAgent("ann-fallback-other");
  const otherSubject = insertEntity(otherAgent, "default_user", "他", { kind: "person" });
  const otherObject = insertEntity(otherAgent, "default_user", "某物", { kind: "object" });
  for (let index = 0; index < 399; index += 1) {
    const otherFact = insertFact({
      agentId: otherAgent,
      fromEntityId: otherSubject,
      toEntityId: otherObject,
      relation: "LIKES",
      description: `其他事实 ${index}`,
      validAt: "2024-01-01T00:00:00.000Z",
    });
    embedding.storeFactEmbedding(otherFact, unitVector(0));
  }

  const items = (await memory.recallFactsHybrid(scope, {
    queryVector: unitVector(0),
    limit: 5,
    backfill: false,
  })) as any[];
  assert.deepEqual(
    new Set(items.map((item) => item.description)),
    new Set(["他喜欢咖啡", "他喜欢茶"]),
  );
});

test("FACT_SELECT survives a fact with no target entity", async () => {
  const agentId = createAgent("空目标");
  const scope = memory.memoryScope(agentId, "default_user");
  const subject = insertEntity(agentId, "default_user", "他", { kind: "person" });
  insertFact({
    agentId,
    fromEntityId: subject,
    toEntityId: null,
    relation: "INTERESTED_IN",
    description: "他对航海模型有兴趣",
    validAt: "2024-01-01T00:00:00.000Z",
  });

  const items = await memory.recallFactsHybrid(scope, {
    queryText: "航海模型",
    limit: 5,
    backfill: false,
  }) as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].targetId, null);
  assert.equal(items[0].targetName, "");
  closeDb();
});
