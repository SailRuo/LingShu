# AGENTS.md — 开发铁律

## 铁律：LLM 调用优先缓存命中，历史上下文冻结不可改

任何 LLM 请求（chat / 语音 / 问候 / 记忆 / 主动消息 / Agent 子调用等）在构造 messages 数组时，必须以保证 **provider prompt cache 命中**为第一优先级。违反此条的实现一律打回，无论功能多紧急。

具体要求：

1. **历史对话上下文冻结，不可改。**
   - 请求前缀（system + 历史消息 + 工具往返）必须**逐字节可复现**（byte-identical）。
   - 禁止对历史消息做任何改写、重排、摘要、重新格式化、标点/标签清洗后再入上下文。
   - 历史回放必须使用 `chat_messages.llm_content` 原文（当次实际发给 LLM 的文本），**不允许**使用展示层 `content`（它会被 Fish/Breeze 标签清洗，属于展示语义）。
   - 工具调用往返（assistant tool_calls + tool results）逐字保留，原样重放。
   - 截断只允许发生在**尾部**（按 context budget 从旧往新丢），不允许从中间挖掉一条。

2. **system prompt 前缀稳定。**
   - system prompt 不含易变内容：时间戳、随机值、每轮变化的计数器/状态等一律不放。
   - 每轮会变化的内容（记忆检索结果、实时状态）只能追加在请求**尾部**（历史之后），不得插进前缀中间。

3. **新增 LLM 调用点时必须自检前缀稳定性**：构造 messages 的代码要能回答「同一会话连续两次请求，前缀是否逐字节一致？」。答案是否定的，先改设计再合入。

现有锚点（改这块时先读懂）：
- `backend-node/src/services/chatStreamService.ts` — 主聊天流；tool 往返 verbatim 重放。
- `chat_messages.llm_content` 列 — schema 注释即契约：可 differs from content，必须 verbatim replay。
- `backend-node/src/services/chatContextService.ts`（如存在）/ context budget 截断逻辑 — 只准尾部截断。

改动涉及以上任何文件时，PR 描述里必须说明对请求前缀稳定性的影响。

## 打包与发布

从源码构建安装包的完整流程（前置环境、命令、产物位置、验证步骤、常见故障）见 **[docs/BUILDING.md](docs/BUILDING.md)**。唯一推荐的打包入口是在 `lingshu-gui/` 内执行 `npm run desktop:build`；涉及 `lingshu-gui/src-tauri`、`backend-node/scripts/stage-runtime.mjs` 的改动，先读该文档再动手。
