import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the backend at a throwaway DB before importing any service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-turn-context-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const { getDb } = await import("../src/db/sqlite.js");
const chatMessages = await import("../src/services/chatMessageService.js");

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
       VALUES (?, ?, '测试人设', '测试风格', 0, 1, 0, 1, 0, ?, ?)`,
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

function getThread(agentId: number, userId = "default_user") {
  return db
    .prepare("SELECT * FROM chat_threads WHERE agent_id = ? AND user_id = ?")
    .get(agentId, userId) as any;
}

function addRawMessage(input: {
  threadId: number;
  agentId: number;
  role: "user" | "assistant" | "system";
  messageKind: string;
  content: string;
  createdAt: string;
  turnPairId?: number | null;
  llmContent?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages
        (thread_id, user_id, agent_id, role, message_kind, content, llm_content,
         turn_pair_id, status, created_at, completed_at)
       VALUES (?, 'default_user', ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(
      input.threadId,
      input.agentId,
      input.role,
      input.messageKind,
      input.content,
      input.llmContent ?? null,
      input.turnPairId ?? null,
      input.createdAt,
      input.createdAt,
    );
  return Number(info.lastInsertRowid);
}

test("appendTurn stores the turn context as its own row bound to the user turn", () => {
  const agentId = createAgent("ctx写入");
  const threadId = createThread(agentId);
  const thread = getThread(agentId);
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const context = "［系统上下文］以下是系统为你准备的当前状态，不是他说的话，不要复述这些标题：\n情绪：平静";

  const result = chatMessages.appendTurn(thread, {
    userContent: "今天有点累",
    assistantContent: "那就早点休息",
    userLlmContent: "今天有点累",
    turnContextContent: context,
    startedAt,
  });

  assert.ok(result.userMessageId);
  const rows = db
    .prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId) as any[];
  assert.equal(rows.length, 3);

  const ctx = rows[0];
  const user = rows[1];
  const assistant = rows[2];
  assert.equal(ctx.role, "system");
  assert.equal(ctx.message_kind, "turn_context");
  assert.equal(ctx.content, context);
  assert.equal(ctx.turn_pair_id, result.userMessageId);
  assert.equal(ctx.created_at, startedAt);
  assert.equal(ctx.completed_at, startedAt);
  assert.equal(ctx.llm_content, null);
  assert.equal(ctx.tool_messages_json, null);
  assert.equal(ctx.user_images_json, null);
  assert.equal(ctx.assistant_images_json, null);
  assert.ok(ctx.id < result.userMessageId);

  assert.equal(user.role, "user");
  assert.equal(user.message_kind, "user_text");
  assert.equal(user.content, "今天有点累");
  assert.equal(user.llm_content, "今天有点累");
  assert.equal(user.created_at, startedAt);
  assert.equal(user.turn_pair_id, result.userMessageId);

  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.turn_pair_id, result.userMessageId);
});

test("loadThreadHistory replays the context row in place, byte for byte", async () => {
  const agentId = createAgent("ctx回放");
  const threadId = createThread(agentId);
  const thread = getThread(agentId);
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const context = "［系统上下文］以下是系统为你准备的当前状态，不是他说的话，不要复述这些标题：\n记忆：他喜欢雨天";

  const toolMessages = [
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function" as const,
          function: { name: "lookup_weather", arguments: '{"city":"杭州"}' },
        },
      ],
    },
    {
      role: "tool" as const,
      content: '{"weather":"rain"}',
      tool_call_id: "call_1",
    },
  ];

  chatMessages.appendTurn(thread, {
    userContent: "今天下雨吗",
    assistantContent: "杭州在下雨。",
    userLlmContent: "今天下雨吗",
    turnContextContent: context,
    toolMessages,
    startedAt,
  });

  // Second turn: its context row must follow the first turn's assistant reply
  // and sit right before its own user message.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondContext = "［系统上下文］新一轮状态：用户刚问过天气";
  chatMessages.appendTurn(thread, {
    userContent: "那要带伞吗",
    assistantContent: "带一把吧。",
    userLlmContent: "那要带伞吗",
    turnContextContent: secondContext,
    startedAt: new Date().toISOString(),
  });

  // A row written before this change: the per-turn context still lives inside
  // `llm_content` and must be replayed exactly as stored.
  const legacyAt = new Date(Date.now() + 5000).toISOString();
  const legacyUser = addRawMessage({
    threadId,
    agentId,
    role: "user",
    messageKind: "user_text",
    content: "旧式提问",
    llmContent: "旧式提问\n\n［系统上下文］旧版上下文",
    createdAt: legacyAt,
  });
  addRawMessage({
    threadId,
    agentId,
    role: "assistant",
    messageKind: "reply",
    content: "旧式回复",
    createdAt: new Date(Date.now() + 6000).toISOString(),
  });
  db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id = ?").run(
    legacyUser,
    legacyUser,
  );

  const contextHistory = chatMessages.loadThreadHistory(threadId, {
    budgetTokens: 128 * 1024,
  });
  assert.deepEqual(contextHistory.messages, [
    { role: "system", content: context },
    { role: "user", content: "今天下雨吗" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup_weather", arguments: '{"city":"杭州"}' },
        },
      ],
    },
    { role: "tool", content: '{"weather":"rain"}', tool_call_id: "call_1" },
    { role: "assistant", content: "杭州在下雨。" },
    { role: "system", content: secondContext },
    { role: "user", content: "那要带伞吗" },
    { role: "assistant", content: "带一把吧。" },
    { role: "user", content: "旧式提问\n\n［系统上下文］旧版上下文" },
    { role: "assistant", content: "旧式回复" },
  ]);
});

test("listTurns and listThreadMessages keep turn_context rows out of the GUI", () => {
  const agentId = createAgent("ctx隐藏");
  const threadId = createThread(agentId);
  const thread = getThread(agentId);
  chatMessages.appendTurn(thread, {
    userContent: "普通提问",
    assistantContent: "普通回复",
    turnContextContent: "［系统上下文］本轮状态",
    startedAt: new Date(Date.now() - 5000).toISOString(),
  });
  chatMessages.appendSystemMessage(thread, "语音通话已结束", "voice_call_end");

  const turns = chatMessages.listTurns(threadId, 20)!;
  assert.equal(turns.filter((item) => item.messageKind === "turn_context").length, 0);
  assert.equal(turns.filter((item) => item.messageKind === "voice_call_end").length, 1);
  assert.equal(turns.filter((item) => item.userMessage === "普通提问").length, 1);

  const messages = chatMessages.listThreadMessages(agentId, "default_user");
  assert.equal(messages.filter((row) => row.message_kind === "turn_context").length, 0);
  assert.equal(messages.filter((row) => row.message_kind === "voice_call_end").length, 1);
});

test("deleting a turn removes its turn_context row together with the pair", () => {
  const agentId = createAgent("ctx删除");
  const threadId = createThread(agentId);
  const thread = getThread(agentId);
  const result = chatMessages.appendTurn(thread, {
    userContent: "要被删除的提问",
    assistantContent: "要被删除的回复",
    turnContextContent: "［系统上下文］删除测试",
    startedAt: new Date(Date.now() - 5000).toISOString(),
  });

  const scope = chatMessages.resolveDeleteScope(threadId, [result.userMessageId!]);
  assert.deepEqual(
    scope.messages.map((row) => row.message_kind).sort(),
    ["reply", "turn_context", "user_text"],
  );
  const impact = chatMessages.messageDeleteImpact(threadId, [result.userMessageId!]);
  assert.equal(impact.messageCount, 3);
  assert.equal(impact.turnCount, 1);

  const deleted = chatMessages.deleteMessages(threadId, [result.userMessageId!], {
    agentId,
    userId: "default_user",
    includeMemory: false,
  });
  assert.equal(deleted.deletedMessages, 3);
  const remaining = db
    .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?")
    .get(threadId) as { c: number };
  assert.equal(remaining.c, 0);
});

test("an anchor that covers a turn hides its context row with the rest of that turn", () => {
  const agentId = createAgent("ctx锚点");
  const threadId = createThread(agentId);
  const base = Date.now() - 20_000;
  const at = (offset: number) => new Date(base + offset).toISOString();

  const turn1Ctx = addRawMessage({
    threadId,
    agentId,
    role: "system",
    messageKind: "turn_context",
    content: "［系统上下文］旧轮上下文",
    createdAt: at(0),
  });
  const turn1User = addRawMessage({
    threadId,
    agentId,
    role: "user",
    messageKind: "user_text",
    content: "旧提问",
    createdAt: at(0),
  });
  const turn1Assistant = addRawMessage({
    threadId,
    agentId,
    role: "assistant",
    messageKind: "reply",
    content: "旧回复",
    createdAt: at(1),
  });
  db.prepare("UPDATE chat_messages SET turn_pair_id = ? WHERE id IN (?, ?, ?)").run(
    turn1User,
    turn1User,
    turn1Ctx,
    turn1Assistant,
  );

  addRawMessage({
    threadId,
    agentId,
    role: "system",
    messageKind: "turn_context",
    content: "［系统上下文］新轮上下文",
    createdAt: at(2),
  });
  addRawMessage({
    threadId,
    agentId,
    role: "user",
    messageKind: "user_text",
    content: "新提问",
    createdAt: at(2),
  });
  addRawMessage({
    threadId,
    agentId,
    role: "assistant",
    messageKind: "reply",
    content: "新回复",
    createdAt: at(3),
  });

  db.prepare(
    `INSERT INTO conversation_anchors
      (agent_id, user_id, summary, covered_at, covered_message_id, updated_at,
       self_narrative, self_dimensions_json, self_retired_json, self_updated_at)
     VALUES (?, 'default_user', ?, ?, ?, ?, '', '{}', '[]', '')`,
  ).run(agentId, "旧轮摘要", at(1), turn1Assistant, new Date().toISOString());

  const history = chatMessages.loadThreadHistory(threadId, {
    budgetTokens: 128 * 1024,
  });
  assert.deepEqual(
    history.messages.map((message) => message.content),
    ["［系统上下文］新轮上下文", "新提问", "新回复"],
  );
});
