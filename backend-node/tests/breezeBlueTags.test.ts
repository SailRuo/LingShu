import test from "node:test";
import assert from "node:assert/strict";

// breezeBlueTags is a pure module: no DB / settings imports, so a direct
// import is safe without the temp-DB dance other tests need.
const breeze = await import("../src/services/breezeBlueTags.js");

test("sanitizeBreezeText keeps the 34 audio events and drops unknown tags", () => {
  const out = breeze.sanitizeBreezeText("[笑]你还在吗[委屈]我等了好久");
  assert.equal(out, "[笑]你还在吗我等了好久");
});

test("sanitizeBreezeText strips the <emo> line and stage directions", () => {
  const out = breeze.sanitizeBreezeText(
    "<emo>疲惫、失望，声音压低，语速偏慢\n我还以为你忘了。（低下头）[叹气]算了，你走吧。",
  );
  assert.equal(out, "我还以为你忘了。 [叹气]算了，你走吧。");
});

test("sanitizeBreezeText normalizes fullwidth brackets before filtering", () => {
  const out = breeze.sanitizeBreezeText("【笑】好呀，【鼓掌】那就出发");
  assert.equal(out, "[笑]好呀，那就出发");
});

test("sanitizeBreezeText drops unclosed tags instead of leaking them", () => {
  assert.equal(breeze.sanitizeBreezeText("正文开头[半截"), "正文开头");
});

test("parseBreezeReply only accepts <emo> as the very first characters", () => {
  const parsed = breeze.parseBreezeReply("<emo>开心、雀跃</emo>\n[笑]来啦！");
  assert.equal(parsed.instruction, "开心、雀跃");
  assert.equal(parsed.text, "[笑]来啦！");

  const later = breeze.parseBreezeReply("第一行正文\n<emo>迟到指令");
  assert.equal(later.instruction, "");
  assert.equal(later.text, "第一行正文");
});

test("parseBreezeReply clamps long instructions", () => {
  const long = "很".repeat(breeze.BREEZE_INSTRUCTION_MAX_CHARS + 10);
  const parsed = breeze.parseBreezeReply(`<emo>${long}\n正文`);
  assert.equal(Array.from(parsed.instruction).length, breeze.BREEZE_INSTRUCTION_MAX_CHARS);
});

test("BreezeEmoLineFilter strips a leading <emo> line from the display stream", () => {
  const filter = new breeze.BreezeEmoLineFilter();
  let out = "";
  // Chunk boundaries split across the tag and the newline.
  out += filter.feed("<e");
  out += filter.feed("mo>开心\n");
  out += filter.feed("[笑]来啦！");
  out += filter.flush();
  assert.equal(out, "[笑]来啦！");
});

test("BreezeEmoLineFilter keeps a normal first line untouched", () => {
  const filter = new breeze.BreezeEmoLineFilter();
  let out = filter.feed("今天");
  out += filter.feed("天气不错");
  out += filter.flush();
  assert.equal(out, "今天天气不错");
});

test("BreezeEmoLineFilter stops waiting after 160 chars without a newline", () => {
  const filter = new breeze.BreezeEmoLineFilter();
  const longLine = "长".repeat(161);
  assert.equal(filter.feed(longLine), longLine);
});

test("BreezeEmoLineFilter drops an unclosed <emo> head on flush", () => {
  const filter = new breeze.BreezeEmoLineFilter();
  assert.equal(filter.feed("<emo>还没有正文"), "");
  assert.equal(filter.flush(), "");
});

test("BreezeEmoLineFilter captures the instruction across split chunks", () => {
  // 语音通话场景：弱停顿切句发生在 emo 行解析之前（协调器 gate），
  // 指令必须跨增量完整捕获，正文从换行后开始放行。
  const gate = new breeze.BreezeEmoLineFilter();
  assert.equal(gate.feed("<emo>疲惫、失望，"), "");
  assert.equal(gate.feed("声音压低\n"), "");
  assert.equal(gate.feed("[叹气]算了，你走吧。"), "[叹气]算了，你走吧。");
  assert.equal(gate.getInstruction(), "疲惫、失望，声音压低");
});
