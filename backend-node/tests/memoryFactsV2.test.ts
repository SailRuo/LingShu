import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-facts-v2-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "0";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const chatMessages = await import("../src/services/chatMessageService.js");
const factStore = await import("../src/services/memoryFactStore.js");

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

function createThread(agentId: number, userId = "default_user"): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, agentId, now, now);
  return Number(info.lastInsertRowid);
}

function addMessage(input: {
  threadId: number;
  agentId: number;
  role: "user" | "assistant";
  content: string;
  llmContent?: string | null;
  createdAt: string;
  userId?: string;
  turnPairId?: number | null;
  replyToMessageId?: number | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, llm_content, status,
         created_at, turn_pair_id, reply_to_message_id)
       VALUES (?, ?, ?, ?, 'chat', ?, ?, 'completed', ?, ?, ?)`,
    )
    .run(
      input.threadId,
      input.userId ?? "default_user",
      input.agentId,
      input.role,
      input.content,
      input.llmContent ?? null,
      input.createdAt,
      input.turnPairId ?? null,
      input.replyToMessageId ?? null,
    );
  return Number(info.lastInsertRowid);
}

function turn(
  threadId: number,
  agentId: number,
  userText: string,
  assistantText: string,
  at: number,
  llmContent?: string | null,
): { user: number; assistant: number } {
  const userId = addMessage({
    threadId,
    agentId,
    role: "user",
    content: userText,
    llmContent: llmContent ?? null,
    createdAt: new Date(at).toISOString(),
  });
  db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(userId, userId);
  const assistant = addMessage({
    threadId,
    agentId,
    role: "assistant",
    content: assistantText,
    createdAt: new Date(at + 1).toISOString(),
    turnPairId: userId,
    replyToMessageId: userId,
  });
  return { user: userId, assistant };
}

function embedStub(text: string): number[] {
  const vector = new Array(768).fill(0);
  vector[0] = 1;
  vector[1] = Math.max(0.01, Math.min(0.99, text.length / 1000));
  return vector;
}

function digestResponse(facts: any[], streams: any[] = []) {
  return {
    should_write: facts.length > 0,
    constraints: [],
    facts,
    streams,
    corrections: [],
    continuity: [],
  };
}

async function runDigest(agentId: number, response: any, options: Record<string, any> = {}) {
  const calls: any[] = [];
  const result = await memory.runAgentDigest(agentId, "default_user", {
    ...options,
    complete: async (system: any, human: any, schema: any) => {
      calls.push({ system, human, schema });
      return response;
    },
    embed: async (text: string) => embedStub(text),
  });
  assert.ok(!("skipped" in result), JSON.stringify(result));
  return { result, calls };
}

function insertEntity(agentId: number, userId: string, name: string): string {
  const id = `entity-${createHash("sha1")
    .update(`${agentId}:${userId}:${name}`)
    .digest("hex")
    .slice(0, 20)}`;
  const vector = new Array(768).fill(0).map((_, index) => (index % 17) / 100);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'other', 'other', '[]', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentId,
    userId,
    name,
    name,
    Buffer.from(new Float32Array(vector).buffer),
    vector.length,
    now,
    now,
  );
  return id;
}

test("digest creates an episode and streams/facts/fact_sources point back to it", async () => {
  const agentId = createAgent("episode");
  const threadId = createThread(agentId);
  const ids = turn(
    threadId,
    agentId,
    "我搬到杭州了",
    "杭州挺好的。",
    Date.now() - 30_000,
    "【本轮场景】我搬到杭州了",
  );

  await runDigest(
    agentId,
    digestResponse(
      [
        {
          subject: "Me",
          relation: "LIVES_IN",
          object: "杭州",
          description: "他住在杭州",
          evidence: "我搬到杭州了",
          confidence: 0.9,
          importance: 0.7,
        },
      ],
      [
        {
          narrative: "他告诉我他搬到杭州了。",
          about: "他·日常",
          stream_type: "external",
          significance: 0.6,
        },
      ],
    ),
  );

  const episode = db
    .prepare("SELECT * FROM hippocampus_episodes WHERE agent_id = ? AND user_id = 'default_user'")
    .get(agentId) as any;
  assert.ok(episode);
  assert.equal(episode.source, "chat");
  assert.match(episode.raw_content, /\[user\] 【本轮场景】我搬到杭州了/);
  assert.match(episode.raw_content, /\[assistant\] 杭州挺好的。/);
  assert.doesNotMatch(episode.raw_content, /\[user\] 我搬到杭州了/);
  assert.deepEqual(JSON.parse(episode.message_ids_json), [ids.user, ids.assistant]);
  assert.ok(episode.started_at);
  assert.ok(episode.ended_at);

  const stream = db
    .prepare("SELECT * FROM hippocampus_streams WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(stream.episode_id, episode.id);
  assert.deepEqual(JSON.parse(stream.source_message_ids_json), [ids.user, ids.assistant]);

  const fact = db.prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any;
  assert.equal(fact.source_episode_id, episode.id);
  assert.equal(fact.cardinality, "one");
  assert.equal(fact.status, "current");
  assert.equal(fact.extractor_version, "v23");
  assert.equal(fact.prompt_version, "graphiti-v1");

  const source = db
    .prepare("SELECT * FROM hippocampus_fact_sources WHERE fact_id = ?")
    .get(fact.id) as any;
  assert.equal(source.episode_id, episode.id);
  assert.equal(source.evidence_quote, "我搬到杭州了");

  const job = db
    .prepare("SELECT * FROM hippocampus_digest_jobs WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(job.status, "done");
  assert.equal(job.extractor_version, "v23");
  assert.equal(job.prompt_version, "graphiti-v1");
  assert.equal(Number(job.from_message_id), ids.user);
  assert.equal(Number(job.to_message_id), ids.assistant);

  // Alias rows are written for both endpoints of the fact.
  const aliases = db
    .prepare("SELECT * FROM hippocampus_entity_aliases WHERE agent_id = ? ORDER BY alias")
    .all(agentId) as any[];
  assert.ok(aliases.some((row) => row.alias === "他"));
  assert.ok(aliases.some((row) => row.alias === "杭州"));
});

test("single-value change soft-invalidates the old fact and links superseded_by", async () => {
  const agentId = createAgent("换工作");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;

  turn(threadId, agentId, "我在甲公司上班", "知道了。", base);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "OCCUPATION",
        object: "甲公司",
        description: "他在甲公司上班",
        evidence: "我在甲公司上班",
        confidence: 0.9,
      },
    ]),
  );

  turn(threadId, agentId, "我换工作了，现在在乙公司", "祝你顺利。", base + 10_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "OCCUPATION",
        object: "乙公司",
        description: "他在乙公司上班",
        evidence: "我换工作了，现在在乙公司",
        confidence: 0.95,
      },
    ]),
  );

  const facts = db
    .prepare(
      `SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'OCCUPATION'
       ORDER BY rowid ASC`,
    )
    .all(agentId) as any[];
  assert.equal(facts.length, 2);
  const [oldFact, newFact] = facts;
  assert.equal(oldFact.status, "expired");
  assert.ok(oldFact.expired_at);
  assert.ok(oldFact.invalid_at);
  assert.equal(oldFact.invalidation_reason, "contradicted");
  assert.equal(oldFact.superseded_by_fact_id, newFact.id);
  assert.equal(newFact.status, "current");
  assert.equal(newFact.expired_at, null);
  assert.equal(newFact.cardinality, "one");
  assert.equal(oldFact.invalid_at, newFact.valid_at, "old invalid_at = new valid_at");
  assert.equal(
    Number(
      (db.prepare("SELECT COUNT(*) AS c FROM fact_vec WHERE fact_id = ?").get(oldFact.id) as any).c,
    ),
    0,
    "superseded fact vectors are removed",
  );

  const secondEpisode = db
    .prepare(
      `SELECT * FROM hippocampus_episodes WHERE agent_id = ?
       ORDER BY ended_at DESC LIMIT 1`,
    )
    .get(agentId) as any;
  assert.equal(newFact.source_episode_id, secondEpisode.id);
});

test("multi-value LIKES facts coexist without invalidation", async () => {
  const agentId = createAgent("多值");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;

  turn(threadId, agentId, "我喜欢咖啡", "记住了。", base);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIKES",
        object: "咖啡",
        description: "他喜欢咖啡",
        evidence: "我喜欢咖啡",
        confidence: 0.8,
      },
    ]),
  );

  turn(threadId, agentId, "我也喜欢茶", "好。", base + 10_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIKES",
        object: "茶",
        description: "他喜欢茶",
        evidence: "我也喜欢茶",
        confidence: 0.8,
      },
    ]),
  );

  const facts = db
    .prepare(
      `SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'LIKES'
       ORDER BY rowid ASC`,
    )
    .all(agentId) as any[];
  assert.equal(facts.length, 2);
  for (const fact of facts) {
    assert.equal(fact.status, "current");
    assert.equal(fact.expired_at, null);
    assert.equal(fact.cardinality, "many");
  }
});

test("repeated statement adds a fact_source instead of a new fact row", async () => {
  const agentId = createAgent("重复");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;
  const response = digestResponse([
    {
      subject: "Me",
      relation: "LIVES_IN",
      object: "上海",
      description: "他住在上海",
      evidence: "我住在上海",
      confidence: 0.7,
    },
  ]);

  turn(threadId, agentId, "我住在上海", "好的。", base);
  await runDigest(agentId, response);
  turn(threadId, agentId, "我住在上海", "知道了。", base + 10_000);
  await runDigest(agentId, response);

  const facts = db
    .prepare(
      `SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'LIVES_IN'`,
    )
    .all(agentId) as any[];
  assert.equal(facts.length, 1);
  const sources = db
    .prepare("SELECT * FROM hippocampus_fact_sources WHERE fact_id = ?")
    .all(facts[0].id) as any[];
  assert.equal(sources.length, 2);
  assert.ok(sources.every((row) => row.evidence_quote === "我住在上海"));
  const episodes = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_episodes WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(Number(episodes.c), 2);
});

test("saveMemory uses the shared writeFact pipeline with a proactive episode", async () => {
  const agentId = createAgent("主动保存");
  const userId = "default_user";
  const threadId = createThread(agentId, userId);
  const userLine = "我住在广州";
  addMessage({
    threadId,
    agentId,
    role: "user",
    content: userLine,
    createdAt: new Date().toISOString(),
  });
  insertEntity(agentId, userId, "他");
  insertEntity(agentId, userId, "广州");

  const first = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "fact",
    relation: "LIVES_IN",
    object: "广州",
    description: "他住在广州",
    evidence: userLine,
    confidence: 0.8,
  });
  assert.equal(first.ok, true);
  assert.ok(first.factId);

  const fact = db
    .prepare("SELECT * FROM hippocampus_facts WHERE id = ?")
    .get(first.factId) as any;
  assert.equal(fact.status, "current");
  assert.equal(fact.cardinality, "one");
  assert.equal(fact.extractor_version, "v23");
  const episode = db
    .prepare("SELECT * FROM hippocampus_episodes WHERE id = ?")
    .get(fact.source_episode_id) as any;
  assert.equal(episode.source, "proactive-save");
  assert.equal(episode.raw_content, userLine);
  const source = db
    .prepare("SELECT * FROM hippocampus_fact_sources WHERE fact_id = ?")
    .get(fact.id) as any;
  assert.equal(source.episode_id, episode.id);
  assert.equal(source.evidence_quote, userLine);

  const duplicate = await memory.saveMemory({
    agentId,
    userId,
    threadId,
    memoryType: "fact",
    relation: "LIVES_IN",
    object: "广州",
    description: "他住在广州",
    evidence: userLine,
    confidence: 0.8,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.merged, true);
  assert.equal(duplicate.factId, first.factId);
  const factCount = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_facts WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(Number(factCount.c), 1);
});

test("entity alias lookup reuses the same entity across case differences", async () => {
  const agentId = createAgent("alias");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;

  turn(threadId, agentId, "Alice 是我的朋友", "好。", base);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "Alice",
        description: "Alice 是他的朋友",
        evidence: "Alice 是我的朋友",
        confidence: 0.8,
      },
    ]),
  );
  turn(threadId, agentId, "alice 最近很忙", "嗯。", base + 10_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "alice",
        description: "Alice 最近很忙",
        evidence: "alice 最近很忙",
        confidence: 0.6,
      },
    ]),
  );

  const aliceEntities = db
    .prepare(
      `SELECT * FROM hippocampus_entities
       WHERE agent_id = ? AND LOWER(name) = 'alice'`,
    )
    .all(agentId) as any[];
  assert.equal(aliceEntities.length, 1, "alias hit must not create a second Alice");
  const aliases = db
    .prepare("SELECT * FROM hippocampus_entity_aliases WHERE entity_id = ?")
    .all(aliceEntities[0].id) as any[];
  assert.ok(aliases.some((row) => row.alias_norm === "alice"));
});

test("digest job records failure and the cursor never advances", async () => {
  const agentId = createAgent("job失败");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "这条会失败", "这条也失败", Date.now() - 5_000);
  await assert.rejects(
    memory.runAgentDigest(agentId, "default_user", {
      complete: async () => {
        throw new Error("llm_down");
      },
      embed: async (text: string) => embedStub(text),
    }),
    /llm_down/,
  );
  const job = db
    .prepare("SELECT * FROM hippocampus_digest_jobs WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(job.status, "failed");
  assert.match(String(job.last_error), /llm_down/);
  assert.equal(memory.readDigestState(agentId, "default_user"), null);
});

test("clearAllMemory removes episodes, fact sources and digest jobs", async () => {
  const agentId = createAgent("清空v23");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "我养了一只猫", "叫什么名字？", Date.now() - 20_000);
  await runDigest(
    agentId,
    digestResponse(
      [
        {
          subject: "Me",
          relation: "HAS_PET",
          object: "猫",
          description: "他养了一只猫",
          evidence: "我养了一只猫",
          confidence: 0.8,
        },
      ],
      [
        {
          narrative: "他说自己养了一只猫。",
          about: "他·日常",
          stream_type: "external",
          significance: 0.5,
        },
      ],
    ),
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_episodes WHERE agent_id = ?").get(agentId) as any).c),
    1,
  );
  const factId = String(
    (db.prepare("SELECT id FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any).id,
  );
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_fact_sources WHERE fact_id = ?").get(factId) as any).c),
    1,
  );

  memory.clearAllMemory({ agentId, userId: "default_user" });
  for (const table of ["hippocampus_episodes", "hippocampus_facts", "hippocampus_digest_jobs"]) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE agent_id = ?`).get(agentId) as any;
    assert.equal(Number(row.c), 0, table);
  }
  const sources = db
    .prepare("SELECT COUNT(*) AS c FROM hippocampus_fact_sources WHERE fact_id = ?")
    .get(factId) as any;
  assert.equal(Number(sources.c), 0, "hippocampus_fact_sources");
});

test("per-fact validAt comes from the evidence message, not the chunk end", async () => {
  const agentId = createAgent("逐条validAt");
  const threadId = createThread(agentId);
  const firstAt = Date.now() - 40 * 60_000;
  const secondAt = Date.now() - 30 * 60_000;

  const first = turn(threadId, agentId, "我喜欢咖啡", "记住了。", firstAt);
  const second = turn(threadId, agentId, "我也喜欢茶", "好。", secondAt);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIKES",
        object: "咖啡",
        description: "他喜欢咖啡",
        evidence: "我喜欢咖啡",
        confidence: 0.8,
      },
      {
        subject: "Me",
        relation: "LIKES",
        object: "茶",
        description: "他喜欢茶",
        evidence: "我也喜欢茶",
        confidence: 0.8,
      },
    ]),
  );

  const eps = db
    .prepare("SELECT * FROM hippocampus_episodes WHERE agent_id = ?")
    .all(agentId) as any[];
  assert.equal(eps.length, 1);
  assert.equal(eps[0].ended_at, new Date(secondAt + 1).toISOString());
  const facts = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'LIKES' ORDER BY valid_at")
    .all(agentId) as any[];
  assert.equal(facts.length, 2);
  assert.equal(facts[0].valid_at, new Date(firstAt).toISOString());
  assert.equal(facts[1].valid_at, new Date(secondAt).toISOString());
  assert.notEqual(facts[0].valid_at, facts[1].valid_at);
});

test("digest extracts the desktop-only valid_at/invalid_at overlay without touching the APP contract", async () => {
  const agentId = createAgent("抽取时间");
  const threadId = createThread(agentId);
  turn(
    threadId,
    agentId,
    "我 2024 年 3 月搬到上海",
    "上海挺好的。",
    Date.now() - 10_000,
  );
  const { calls } = await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIVES_IN",
        object: "上海",
        description: "他 2024 年 3 月住在上海",
        evidence: "我 2024 年 3 月搬到上海",
        confidence: 0.9,
        valid_at: "2024-03-01",
        invalid_at: "2099-01-01",
      },
    ]),
  );

  const fact = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(fact.valid_at, "2024-03-01T00:00:00.000Z");
  assert.equal(fact.invalid_at, "2099-01-01T00:00:00.000Z");

  const schema = calls[0].schema as any;
  assert.deepEqual(schema.properties.facts.items.properties.valid_at, { type: "string" });
  assert.deepEqual(schema.properties.facts.items.properties.invalid_at, { type: "string" });
  assert.ok(!schema.properties.facts.items.required.includes("valid_at"));
  assert.ok(!schema.properties.facts.items.required.includes("invalid_at"));
  assert.match(
    String(calls[0].human),
    /valid_at：这件事在现实世界开始为真的时间/,
    "time rules must be appended to the human prompt",
  );
  assert.match(String(calls[0].human), /没有明确时间就省略，不要猜/);

  // The APP-generated mirror must stay byte-identical: desktop-only means the
  // overlay lives in memoryService, not in the generated contract.
  const generated = fs.readFileSync(
    new URL(
      "../src/contracts/native/generated/nativeDigestSource.generated.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(generated.includes("valid_at"), false);
  assert.equal(generated.includes("invalid_at"), false);
});

test("invalid or ambiguous extracted times never create an illegal interval", async () => {
  // Date-only / offset-less inputs normalize to a UTC instant; vague relative
  // words are dropped rather than guessed.
  assert.equal(
    memory.normalizeFactExtractedTime("2024-03-01"),
    "2024-03-01T00:00:00.000Z",
  );
  assert.equal(
    memory.normalizeFactExtractedTime("2025-03-01T10:00:00+08:00"),
    "2025-03-01T02:00:00.000Z",
  );
  assert.equal(
    memory.normalizeFactExtractedTime("昨天", "2026-03-01T10:00:00.000Z"),
    "2026-02-28T00:00:00.000Z",
  );
  assert.equal(memory.normalizeFactExtractedTime("去年", "2026-03-01T10:00:00.000Z"), null);
  assert.equal(memory.normalizeFactExtractedTime("2025-02-30"), null);
  assert.equal(memory.normalizeFactExtractedTime("not-a-date"), null);

  const agentId = createAgent("非法区间");
  const threadId = createThread(agentId);
  const messageAt = Date.now() - 10_000;
  turn(threadId, agentId, "我喜欢喝美式", "记住了。", messageAt);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIKES",
        object: "美式",
        description: "他喜欢喝美式",
        evidence: "我喜欢喝美式",
        confidence: 0.9,
        valid_at: "2025-03-01",
        invalid_at: "2024-01-01",
      },
    ]),
  );
  const fact = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(fact.valid_at, "2025-03-01T00:00:00.000Z");
  assert.equal(fact.invalid_at, null, "invalid_at <= valid_at must be dropped");

  const agentId2 = createAgent("非法字符串");
  const threadId2 = createThread(agentId2);
  const messageAt2 = Date.now() - 10_000;
  turn(threadId2, agentId2, "我也喜欢拿铁", "好。", messageAt2);
  await runDigest(
    agentId2,
    digestResponse([
      {
        subject: "Me",
        relation: "LIKES",
        object: "拿铁",
        description: "他喜欢拿铁",
        evidence: "我也喜欢拿铁",
        confidence: 0.9,
        valid_at: "not-a-date",
        invalid_at: "去年",
      },
    ]),
  );
  const fact2 = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?")
    .get(agentId2) as any;
  assert.equal(fact2.valid_at, new Date(messageAt2).toISOString());
  assert.equal(fact2.invalid_at, null);
});

test("out-of-order digest keeps the newer current fact and writes the older one as history", async () => {
  const agentId = createAgent("乱序digest");
  const threadId = createThread(agentId);
  const febUser = "2026-02-10T09:00:00.000Z";
  const janUser = "2026-01-10T09:00:00.000Z";

  turn(
    threadId,
    agentId,
    "我搬到上海了",
    "上海挺好的。",
    Date.parse(febUser),
  );
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIVES_IN",
        object: "上海",
        description: "他住在上海",
        evidence: "我搬到上海了",
        confidence: 0.9,
      },
    ]),
    { since: "2025-12-01T00:00:00.000Z" },
  );

  // Reset the high-water mark to simulate an older message arriving/digesting
  // after the newer episode (import, retry from a second device, etc.).
  db.prepare("DELETE FROM digest_state WHERE agent_id = ? AND user_id = 'default_user'").run(
    agentId,
  );
  turn(threadId, agentId, "我搬到北京了", "北京也不错。", Date.parse(janUser));
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "LIVES_IN",
        object: "北京",
        description: "他住在北京",
        evidence: "我搬到北京了",
        confidence: 0.9,
      },
    ]),
    { since: "2025-12-01T00:00:00.000Z" },
  );

  const facts = db
    .prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'LIVES_IN'")
    .all(agentId) as any[];
  assert.equal(facts.length, 2);
  const current = facts.find((fact) => fact.status === "current");
  const history = facts.find((fact) => fact.status !== "current");
  assert.ok(current);
  assert.ok(history);
  assert.equal(current.description, "他住在上海");
  assert.equal(history.description, "他住在北京");
  assert.equal(history.invalidation_reason, "out_of_order");
  assert.equal(history.valid_at, janUser);
  assert.equal(history.invalid_at, current.valid_at, "history ends when the newer fact starts");
  assert.ok(
    history.invalid_at > (history.valid_at || history.created_at),
    "history invalid_at must be after its own start",
  );
  assert.equal(history.expired_at != null, true);

  const invalid = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hippocampus_facts
       WHERE invalid_at IS NOT NULL AND invalid_at <= COALESCE(valid_at, created_at)`,
    )
    .get() as { c: number };
  assert.equal(Number(invalid.c), 0);
});

test("deleting a thread soft-deletes its facts but keeps episodes and fact_sources", async () => {
  const agentId = createAgent("删会话");
  const threadId = createThread(agentId);
  turn(threadId, agentId, "我养了一只猫", "叫什么名字？", Date.now() - 20_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_PET",
        object: "猫",
        description: "他养了一只猫",
        evidence: "我养了一只猫",
        confidence: 0.8,
      },
    ]),
  );

  const fact = db.prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any;
  const episode = db
    .prepare("SELECT * FROM hippocampus_episodes WHERE agent_id = ?")
    .get(agentId) as any;
  assert.ok(fact);
  assert.ok(episode);

  assert.equal(chatMessages.deleteThreadRecords(threadId), 2);

  const after = db.prepare("SELECT * FROM hippocampus_facts WHERE id = ?").get(fact.id) as any;
  assert.equal(after.status, "expired");
  assert.ok(after.expired_at);
  assert.ok(after.invalid_at);
  assert.equal(after.invalidation_reason, "source_deleted");
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS c FROM hippocampus_episodes WHERE id = ?").get(episode.id) as any).c),
    1,
    "episodes stay for audit",
  );
  assert.equal(
    Number(
      (db
        .prepare("SELECT COUNT(*) AS c FROM hippocampus_fact_sources WHERE fact_id = ?")
        .get(fact.id) as any).c,
    ),
    1,
    "fact_sources stay for audit",
  );
  assert.equal(
    memory.listFacts(memory.memoryScope(agentId, "default_user"), "current").total,
    0,
  );
});

test("deleting messages soft-deletes facts derived from their episodes", async () => {
  const agentId = createAgent("删消息");
  const threadId = createThread(agentId);
  const ids = turn(threadId, agentId, "我在甲公司上班", "知道了。", Date.now() - 20_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "OCCUPATION",
        object: "甲公司",
        description: "他在甲公司上班",
        evidence: "我在甲公司上班",
        confidence: 0.9,
      },
    ]),
  );
  const fact = db.prepare("SELECT * FROM hippocampus_facts WHERE agent_id = ?").get(agentId) as any;
  assert.equal(fact.status, "current");

  const result = chatMessages.deleteMessages(threadId, [ids.user], {
    agentId,
    userId: "default_user",
    includeMemory: true,
  });
  assert.equal(result.deletedMessages, 2);
  const after = db.prepare("SELECT * FROM hippocampus_facts WHERE id = ?").get(fact.id) as any;
  assert.equal(after.status, "expired");
  assert.equal(after.invalidation_reason, "source_deleted");
  assert.ok(after.invalid_at);
  assert.equal(
    memory.listFacts(memory.memoryScope(agentId, "default_user"), "current").total,
    0,
  );
});

test("same-name entities with conflicting kinds are not hard-merged", async () => {
  const agentId = createAgent("同名不同类");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;
  turn(threadId, agentId, "小明是我的朋友", "好。", base);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "小明",
        description: "小明是他的朋友",
        evidence: "小明是我的朋友",
        confidence: 0.8,
      },
    ]),
  );

  turn(threadId, agentId, "小明是我养的狗", "原来如此。", base + 10_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_PET",
        object: "小明",
        description: "小明是他养的狗",
        evidence: "小明是我养的狗",
        confidence: 0.8,
      },
    ]),
  );

  const entities = db
    .prepare("SELECT * FROM hippocampus_entities WHERE agent_id = ? AND name = '小明' ORDER BY rowid")
    .all(agentId) as any[];
  assert.equal(entities.length, 2, "a person 小明 and a pet 小明 must not share one row");
  assert.deepEqual(
    new Set(entities.map((row) => row.kind)),
    new Set(["person", "pet"]),
  );
  assert.notEqual(entities[0].id, entities[1].id);
});

test("multiple alias candidates under-merge instead of reusing one entity", async () => {
  const agentId = createAgent("同名候选");
  const threadId = createThread(agentId);
  const base = Date.now() - 60_000;
  turn(threadId, agentId, "小明是我的朋友", "好。", base);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "小明",
        description: "小明是他的朋友",
        evidence: "小明是我的朋友",
        confidence: 0.8,
      },
    ]),
  );

  const first = db
    .prepare("SELECT * FROM hippocampus_entities WHERE agent_id = ? AND name = '小明'")
    .get(agentId) as any;
  assert.ok(first);

  // Seed a second, distinct 小明 (another friend with the same name), sharing
  // the same alias hash. Alias lookup now has two legal candidates.
  const secondId = insertEntity(agentId, "default_user", "小明");
  db.prepare(
    `INSERT INTO hippocampus_entity_aliases
      (id, agent_id, user_id, entity_id, alias, alias_norm, alias_hash, source_episode_id,
       confidence, created_at)
     VALUES (?, ?, 'default_user', ?, '小明', '小明', ?, NULL, 1.0, ?)`,
  ).run(
    `alias-${createHash("sha1").update(`second-${agentId}`).digest("hex").slice(0, 20)}`,
    agentId,
    secondId,
    createHash("sha1").update(`${agentId}:default_user:小明`).digest("hex"),
    new Date().toISOString(),
  );

  turn(threadId, agentId, "小明最近很忙", "嗯。", base + 10_000);
  await runDigest(
    agentId,
    digestResponse([
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "小明",
        description: "小明最近很忙",
        evidence: "小明最近很忙",
        confidence: 0.7,
      },
    ]),
  );

  const entities = db
    .prepare("SELECT * FROM hippocampus_entities WHERE agent_id = ? AND name = '小明'")
    .all(agentId) as any[];
  assert.equal(entities.length, 3, "two candidates must trigger under-merge, not a coin flip");
  const latestFact = db
    .prepare(
      "SELECT * FROM hippocampus_facts WHERE agent_id = ? AND relation = 'HAS_FRIEND' ORDER BY rowid DESC LIMIT 1",
    )
    .get(agentId) as any;
  assert.notEqual(latestFact.to_entity_id, first.id);
  assert.notEqual(latestFact.to_entity_id, secondId);
});

test("beginDigestJob retry refreshes extractor/prompt versions", () => {
  const agentId = createAgent("job版本");
  const scope = memory.memoryScope(agentId, "default_user");
  const first = factStore.beginDigestJob({
    scope,
    fromMessageId: 1,
    toMessageId: 2,
    contentHash: "same-content",
    extractorVersion: "v23",
    promptVersion: "graphiti-v1",
  });
  assert.ok(first);
  const second = factStore.beginDigestJob({
    scope,
    fromMessageId: 1,
    toMessageId: 2,
    contentHash: "same-content",
    extractorVersion: "v24",
    promptVersion: "graphiti-v2",
  });
  assert.ok(second);
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 2);
  const row = db
    .prepare("SELECT * FROM hippocampus_digest_jobs WHERE id = ?")
    .get(first.id) as any;
  assert.equal(row.extractor_version, "v24");
  assert.equal(row.prompt_version, "graphiti-v2");
});

test("v23 memory tables and columns exist", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 23);
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
    assert.equal(row?.name, table);
  }
  const predicates = db
    .prepare("SELECT name, cardinality FROM hippocampus_predicates ORDER BY name")
    .all() as { name: string; cardinality: string }[];
  assert.equal(predicates.length, 15);
  const byName = new Map(predicates.map((row) => [row.name, row.cardinality]));
  assert.equal(byName.get("OCCUPATION"), "one");
  assert.equal(byName.get("LIKES"), "many");
  assert.equal(byName.get("HAS_WORK_PATTERN"), "one");
  const migrationEvent = db
    .prepare(
      `SELECT * FROM background_task_events
       WHERE event_type = 'schema_migration' AND detail = 'v23'`,
    )
    .get() as any;
  assert.ok(migrationEvent);
  assert.equal(migrationEvent.status, "succeeded");
  closeDb();
});
