import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-relationship-summary-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.LINGSHU_DIGEST_AFFECT_SIDECAR = "0";

const { getDb, closeDb } = await import("../src/db/sqlite.js");
const memory = await import("../src/services/memoryService.js");
const relationship = await import("../src/services/relationshipThreadService.js");

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
  userId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, status, created_at)
       VALUES (?, ?, ?, ?, 'chat', ?, 'completed', ?)`,
    )
    .run(
      input.threadId,
      input.userId ?? "default_user",
      input.agentId,
      input.role,
      input.content,
      input.createdAt,
    );
  return Number(info.lastInsertRowid);
}

test("relationship thread summary watermarks advance only with later new nodes; memoryGraph exposes them", () => {
  const columns = db.prepare("PRAGMA table_info(relationship_threads)").all() as {
    name: string;
  }[];
  for (const column of [
    "summary_covered_message_id",
    "summary_covered_at",
    "summary_updated_at",
  ]) {
    assert.ok(columns.some((item) => item.name === column), `missing column ${column}`);
  }

  const agentId = createAgent("摘要水位");
  const chatThreadId = createThread(agentId);
  const firstAt = "2025-05-01T10:00:00.000Z";
  const secondAt = "2025-05-02T10:00:00.000Z";
  const olderAt = "2025-04-01T10:00:00.000Z";
  const node1 = addMessage({
    threadId: chatThreadId,
    agentId,
    role: "user",
    content: "第一件心事",
    createdAt: firstAt,
  });
  const scope = memory.memoryScope(agentId, "default_user");

  const firstItem = {
    title: "心事线 A",
    note: "A",
    carriesIndex: -1,
    carryNote: "",
    nodes: [
      { index: 0, messageId: node1, role: "user" as const, content: "第一件心事", createdAt: firstAt },
    ],
  };
  const firstResult = relationship.applyRelationshipContinuity(
    scope,
    [firstItem],
    [],
    "relationship-summary-batch-1",
  );
  assert.equal(firstResult.threadsCreated, 1);
  assert.equal(firstResult.nodesWritten, 1);

  const threadRow = db
    .prepare("SELECT * FROM relationship_threads WHERE agent_id = ?")
    .get(agentId) as any;
  assert.equal(threadRow.summary, "A");
  assert.equal(threadRow.summary_covered_message_id, String(node1));
  assert.equal(threadRow.summary_covered_at, firstAt);
  assert.ok(threadRow.summary_updated_at);
  const initialSummaryUpdatedAt = String(threadRow.summary_updated_at);

  // Replaying the exact same batch inserts no nodes and must not overwrite the
  // existing summary or any of its watermarks.
  const duplicateResult = relationship.applyRelationshipContinuity(
    scope,
    [firstItem],
    [],
    "relationship-summary-batch-1",
  );
  assert.equal(duplicateResult.nodesWritten, 0);
  const afterDuplicate = db
    .prepare("SELECT * FROM relationship_threads WHERE id = ?")
    .get(threadRow.id) as any;
  assert.equal(afterDuplicate.summary, "A");
  assert.equal(afterDuplicate.summary_covered_message_id, String(node1));
  assert.equal(afterDuplicate.summary_covered_at, firstAt);
  assert.equal(afterDuplicate.summary_updated_at, initialSummaryUpdatedAt);

  // A genuinely later node carried into the same thread advances the summary.
  const node2 = addMessage({
    threadId: chatThreadId,
    agentId,
    role: "assistant",
    content: "第二件心事",
    createdAt: secondAt,
  });
  const candidates = relationship.listRelationshipThreadCandidates(scope);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, threadRow.id);
  const secondResult = relationship.applyRelationshipContinuity(
    scope,
    [
      {
        title: "心事线 A",
        note: "B",
        carriesIndex: 0,
        carryNote: "接着上次那件心事",
        nodes: [
          {
            index: 0,
            messageId: node2,
            role: "assistant",
            content: "第二件心事",
            createdAt: secondAt,
          },
        ],
      },
    ],
    candidates,
    "relationship-summary-batch-2",
  );
  assert.equal(secondResult.nodesWritten, 1);
  const afterSecond = db
    .prepare("SELECT * FROM relationship_threads WHERE id = ?")
    .get(threadRow.id) as any;
  assert.equal(afterSecond.summary, "B");
  assert.equal(afterSecond.summary_covered_message_id, String(node2));
  assert.equal(afterSecond.summary_covered_at, secondAt);
  assert.ok(String(afterSecond.summary_updated_at) >= initialSummaryUpdatedAt);
  assert.equal(afterSecond.status, "active");

  // An older backfill (new node, but before the covered point) must not move
  // the summary or the watermarks backwards.
  const nodeOld = addMessage({
    threadId: chatThreadId,
    agentId,
    role: "user",
    content: "更早的旧心事",
    createdAt: olderAt,
  });
  relationship.applyRelationshipContinuity(
    scope,
    [
      {
        title: "心事线 A",
        note: "旧消息不该覆盖",
        carriesIndex: 0,
        carryNote: "旧材料",
        nodes: [
          {
            index: 0,
            messageId: nodeOld,
            role: "user",
            content: "更早的旧心事",
            createdAt: olderAt,
          },
        ],
      },
    ],
    relationship.listRelationshipThreadCandidates(scope),
    "relationship-summary-batch-old",
  );
  const afterOld = db
    .prepare("SELECT * FROM relationship_threads WHERE id = ?")
    .get(threadRow.id) as any;
  assert.equal(afterOld.summary, "B");
  assert.equal(afterOld.summary_covered_message_id, String(node2));
  assert.equal(afterOld.summary_covered_at, secondAt);

  // Old hippocampus_threads rows with the same id must not shadow the live
  // relationship thread in the graph.
  db.prepare(
    `INSERT INTO hippocampus_threads
      (id, agent_id, user_id, title, status, owner, current_grip, last_note,
       origin_note, embedding, embedding_dim, created_at, updated_at)
     VALUES (?, ?, 'default_user', '旧心事线', 'open', NULL, 0, '旧备注',
             NULL, NULL, NULL, ?, ?)`,
  ).run(threadRow.id, agentId, firstAt, firstAt);

  const graph = memory.memoryGraph(scope, 20);
  const threadNodes = graph.nodes.filter(
    (node: any) => node.type === "Thread" && node.id === threadRow.id,
  );
  assert.equal(threadNodes.length, 1, "relationship thread must win id dedupe");
  const threadNode = threadNodes[0] as any;
  assert.equal(threadNode.label, "心事线 A");
  assert.equal(threadNode.nodeClass, "thread-open");
  assert.equal(threadNode.properties.title, "心事线 A");
  assert.equal(threadNode.properties.last_note, "B");
  assert.equal(threadNode.properties.status, "active");
  assert.equal(threadNode.properties.current_grip, 0);
  assert.equal(threadNode.properties.summary_covered_message_id, String(node2));
  assert.equal(threadNode.properties.summary_covered_at, secondAt);
  assert.ok(threadNode.properties.summary_updated_at);

  const threadsApi = memory.listMemoryThreads(scope);
  assert.ok(Array.isArray((threadsApi as any).threads));
  const relationshipApi = (threadsApi as any).relationshipThreads.find(
    (item: any) => item.id === threadRow.id,
  );
  assert.ok(relationshipApi);
  assert.equal(relationshipApi.summary, "B");
  assert.equal(relationshipApi.summary_covered_message_id, String(node2));

  closeDb();
});
