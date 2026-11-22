import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-memory-entity-resolution-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "0";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");

const db = getDb();
const USER_ID = "default_user";

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

function createThread(agentId: number): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_threads (user_id, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(USER_ID, agentId, now, now);
  return Number(info.lastInsertRowid);
}

function addMessage(input: {
  threadId: number;
  agentId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  turnPairId?: number | null;
  replyToMessageId?: number | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, llm_content, status,
         created_at, turn_pair_id, reply_to_message_id)
       VALUES (?, ?, ?, ?, 'chat', ?, NULL, 'completed', ?, ?, ?)`,
    )
    .run(
      input.threadId,
      USER_ID,
      input.agentId,
      input.role,
      input.content,
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
): void {
  const userId = addMessage({
    threadId,
    agentId,
    role: "user",
    content: userText,
    createdAt: new Date(at).toISOString(),
  });
  db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(userId, userId);
  addMessage({
    threadId,
    agentId,
    role: "assistant",
    content: assistantText,
    createdAt: new Date(at + 1).toISOString(),
    turnPairId: userId,
    replyToMessageId: userId,
  });
}

function embedStub(text: string): number[] {
  const vector = new Array(768).fill(0);
  vector[0] = 1;
  vector[1] = Math.max(0.01, Math.min(0.99, text.length / 1000));
  return vector;
}

function digestResponse(facts: any[]) {
  return {
    should_write: facts.length > 0,
    constraints: [],
    facts,
    streams: [],
    corrections: [],
    continuity: [],
  };
}

function friendFact(object: string, description: string, evidence: string) {
  return {
    subject: "Me",
    relation: "HAS_FRIEND",
    object,
    description,
    evidence,
    confidence: 0.9,
    importance: 0.6,
  };
}

async function runDigest(agentId: number, response: any, options: Record<string, any> = {}) {
  const extractionCalls: any[] = [];
  const complete =
    options.complete ??
    (async (system: any, human: any, schema: any) => {
      extractionCalls.push({ system, human, schema });
      return response;
    });
  const result = await memory.runAgentDigest(agentId, USER_ID, {
    ...options,
    complete,
    embed: async (text: string) => embedStub(text),
  });
  assert.ok(!("skipped" in result), JSON.stringify(result));
  return { result, extractionCalls };
}

function entityAliasHash(agentId: number, name: string): string {
  const normalized = String(name).normalize("NFKC").trim().toLowerCase();
  return createHash("sha1").update(`${agentId}:${USER_ID}:${normalized}`).digest("hex");
}

function insertEntity(
  agentId: number,
  name: string,
  options: {
    type?: string;
    kind?: string;
    description?: string;
    narrative?: string;
    summary?: string;
    withAlias?: boolean;
  } = {},
): string {
  const id = `entity-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const now = new Date().toISOString();
  const vector = new Array(768).fill(0).map((_, index) => (index % 17) / 100);
  db.prepare(
    `INSERT INTO hippocampus_entities
      (id, agent_id, user_id, name, type, kind, labels_json, description, narrative,
       summary, embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentId,
    USER_ID,
    name,
    options.type ?? "other",
    options.kind ?? "person",
    options.description ?? null,
    options.narrative ?? `Entity representing ${name}`,
    options.summary ?? null,
    Buffer.from(new Float32Array(vector).buffer),
    vector.length,
    now,
    now,
  );
  if (options.withAlias !== false) {
    db.prepare(
      `INSERT INTO hippocampus_entity_aliases
        (id, agent_id, user_id, entity_id, alias, alias_norm, alias_hash,
         source_episode_id, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1.0, ?)`,
    ).run(
      `alias-${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      agentId,
      USER_ID,
      id,
      name,
      name.normalize("NFKC").trim().toLowerCase(),
      entityAliasHash(agentId, name),
      now,
    );
  }
  return id;
}

function entitiesNamed(agentId: number, name: string): { id: string; kind: string | null; type: string }[] {
  return db
    .prepare(
      `SELECT id, kind, type FROM hippocampus_entities
        WHERE agent_id = ? AND user_id = ? AND name = ?
        ORDER BY rowid ASC`,
    )
    .all(agentId, USER_ID, name) as { id: string; kind: string | null; type: string }[];
}

function friendFacts(agentId: number): { to_entity_id: string }[] {
  return db
    .prepare(
      `SELECT to_entity_id FROM hippocampus_facts
        WHERE agent_id = ? AND user_id = ? AND relation = 'HAS_FRIEND'
        ORDER BY rowid ASC`,
    )
    .all(agentId, USER_ID) as { to_entity_id: string }[];
}

test("entity resolution 'new' creates a second entity for the same name", async () => {
  const agentId = createAgent("entity-new");
  const threadId = createThread(agentId);
  const base = Date.now() - 120_000;

  turn(threadId, agentId, "我认识了一个叫小明的同事，他在北京工作。", "记住了。", base);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "他有个在北京工作的同事叫小明", "我认识了一个叫小明的同事，他在北京工作。"),
    ]),
  );

  const firstEntities = entitiesNamed(agentId, "小明");
  assert.equal(firstEntities.length, 1);

  const entityCalls: any[] = [];
  turn(threadId, agentId, "今天另一个叫小明的朋友来杭州找我玩。", "好的。", base + 30_000);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "他还有一个在杭州的朋友叫小明", "今天另一个叫小明的朋友来杭州找我玩。"),
    ]),
    {
      entityComplete: async (system: any, human: any, schema: any) => {
        entityCalls.push({ system, human, schema });
        return { resolutions: [{ name: "小明", decision: "new" }] };
      },
    },
  );

  assert.equal(entityCalls.length, 1, "one batched resolution call per chunk");
  const entities = entitiesNamed(agentId, "小明");
  assert.equal(entities.length, 2);
  const facts = friendFacts(agentId);
  assert.equal(facts.length, 2);
  assert.notEqual(facts[0].to_entity_id, facts[1].to_entity_id);
  assert.deepEqual(
    new Set(facts.map((fact) => fact.to_entity_id)),
    new Set(entities.map((entity) => entity.id)),
  );
});

test("entity resolution 'existing' reuses the candidate and keeps one entity", async () => {
  const agentId = createAgent("entity-existing");
  const threadId = createThread(agentId);
  const base = Date.now() - 120_000;

  turn(threadId, agentId, "我认识了一个叫小明的同事，他在北京工作。", "记住了。", base);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "他有个在北京工作的同事叫小明", "我认识了一个叫小明的同事，他在北京工作。"),
    ]),
  );
  const firstEntities = entitiesNamed(agentId, "小明");
  assert.equal(firstEntities.length, 1);
  const firstId = firstEntities[0].id;

  turn(threadId, agentId, "小明昨天还说下周来北京出差。", "好的。", base + 30_000);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "小明下周要来北京出差", "小明昨天还说下周来北京出差。"),
    ]),
    {
      entityComplete: async () => ({
        resolutions: [{ name: "小明", decision: "existing", entity_id: firstId }],
      }),
    },
  );

  const entities = entitiesNamed(agentId, "小明");
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, firstId);
  const facts = friendFacts(agentId);
  assert.equal(facts.length, 1, "same source/target/relation is merged by writeFact");
  assert.deepEqual(new Set(facts.map((fact) => fact.to_entity_id)), new Set([firstId]));
  const aliases = db
    .prepare(
      `SELECT COUNT(*) AS c FROM hippocampus_entity_aliases
        WHERE agent_id = ? AND user_id = ? AND entity_id = ? AND alias_norm = '小明'`,
    )
    .get(agentId, USER_ID, firstId) as any;
  assert.equal(Number(aliases.c), 1);
});

test("without entityComplete, an injected extractor mock falls back to deterministic reuse", async () => {
  const agentId = createAgent("entity-fallback");
  const threadId = createThread(agentId);
  const base = Date.now() - 120_000;

  turn(threadId, agentId, "我认识了一个叫小明的同事，他在北京工作。", "记住了。", base);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "他有个在北京工作的同事叫小明", "我认识了一个叫小明的同事，他在北京工作。"),
    ]),
  );
  const firstId = entitiesNamed(agentId, "小明")[0].id;

  // Only `complete` (the extraction mock) is injected. It must never be used
  // for entity resolution, and the old alias path must still reuse the entity.
  turn(threadId, agentId, "小明今天又提起北京。", "好的。", base + 30_000);
  const secondCalls: any[] = [];
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "小明今天又提起北京", "小明今天又提起北京。"),
    ]),
    {
      complete: async (_system: any, human: any, _schema: any) => {
        secondCalls.push(human);
        return digestResponse([
          friendFact("小明", "小明今天又提起北京", "小明今天又提起北京。"),
        ]);
      },
    },
  );

  assert.equal(secondCalls.length, 1, "extractor mock called once, never as resolver");
  const entities = entitiesNamed(agentId, "小明");
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, firstId);
  const facts = friendFacts(agentId);
  assert.equal(facts.length, 1);
  assert.deepEqual(new Set(facts.map((fact) => fact.to_entity_id)), new Set([firstId]));
});

test("one batched resolution call covers all ambiguous names and includes context", async () => {
  const agentId = createAgent("entity-batch");
  const threadId = createThread(agentId);
  const base = Date.now() - 120_000;

  turn(threadId, agentId, "我认识了小明和小红，他们都是我的同事。", "记住了。", base);
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "他有个同事叫小明", "我认识了小明和小红，他们都是我的同事。"),
      friendFact("小红", "他有个同事叫小红", "我认识了小明和小红，他们都是我的同事。"),
    ]),
  );
  const firstXiaoming = entitiesNamed(agentId, "小明")[0];
  const firstXiaohong = entitiesNamed(agentId, "小红")[0];
  assert.ok(firstXiaoming && firstXiaohong);

  turn(threadId, agentId, "今天小明和小红一起来家里吃饭。", "好的。", base + 30_000);
  const entityCalls: any[] = [];
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "小明今天来家里吃饭", "今天小明和小红一起来家里吃饭。"),
      friendFact("小红", "小红今天来家里吃饭", "今天小明和小红一起来家里吃饭。"),
    ]),
    {
      entityComplete: async (system: any, human: any, schema: any) => {
        entityCalls.push({ system, human, schema });
        return {
          resolutions: [
            { name: "小明", decision: "new" },
            { name: "小红", decision: "new" },
          ],
        };
      },
    },
  );

  assert.equal(entityCalls.length, 1, "one LLM call for the whole chunk");
  const human = String(entityCalls[0].human);
  assert.match(human, /小明/);
  assert.match(human, /小红/);
  assert.match(human, new RegExp(firstXiaoming.id));
  assert.match(human, new RegExp(firstXiaohong.id));
  assert.match(human, /今天小明和小红一起来家里吃饭/);
  const decisions =
    entityCalls[0].schema?.properties?.resolutions?.items?.properties?.decision?.enum || [];
  assert.deepEqual(decisions, ["existing", "new"]);
});

test("anchor mentions never trigger entity resolution", async () => {
  const agentId = createAgent("entity-anchor");
  // Seed one candidate for each anchor name: if the anchor guard were missing,
  // the resolver would find exactly one compatible candidate and call the LLM.
  insertEntity(agentId, "他", { type: "user", kind: "person" });
  insertEntity(agentId, "她", { type: "self", kind: "person" });

  let calls = 0;
  const decisions = await memory.resolveChunkEntityAmbiguities(
    { agentId, userId: USER_ID },
    { messages: [], transcript: "他今天来看她。", rows: [], tokenEstimate: 0 } as any,
    [
      {
        subject: "Me",
        relation: "HAS_FRIEND",
        object: "他",
        description: "他有个朋友",
        evidence: "他今天来看她。",
        confidence: 0.9,
        importance: 0.5,
        isIdentity: false,
      },
      {
        subject: "Self",
        relation: "HAS_FRIEND",
        object: "她",
        description: "她有个朋友",
        evidence: "他今天来看她。",
        confidence: 0.9,
        importance: 0.5,
        isIdentity: false,
      },
    ] as any,
    {
      entityComplete: async () => {
        calls += 1;
        return { resolutions: [] };
      },
    },
  );

  assert.equal(decisions.size, 0);
  assert.equal(calls, 0);
});

test("multiple same-name candidates use one LLM call and can choose an existing entity", async () => {
  const agentId = createAgent("entity-multiple");
  const first = insertEntity(agentId, "小明", { type: "other", kind: "person" });
  const second = insertEntity(agentId, "小明", { type: "other", kind: "person" });
  const threadId = createThread(agentId);

  turn(threadId, agentId, "小明今天来找我了。", "好的。", Date.now() - 30_000);
  let calls = 0;
  await runDigest(
    agentId,
    digestResponse([
      friendFact("小明", "小明今天来找他了", "小明今天来找我了。"),
    ]),
    {
      entityComplete: async (_system: any, human: any) => {
        calls += 1;
        assert.match(String(human), new RegExp(first));
        assert.match(String(human), new RegExp(second));
        return { resolutions: [{ name: "小明", decision: "existing", entity_id: second }] };
      },
    },
  );

  assert.equal(calls, 1, "one batched resolution call even with multiple candidates");
  const entities = entitiesNamed(agentId, "小明");
  assert.equal(entities.length, 2);
  const facts = friendFacts(agentId);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].to_entity_id, second, "fact points at the chosen existing entity");
});

test.after(() => {
  closeDb();
});
