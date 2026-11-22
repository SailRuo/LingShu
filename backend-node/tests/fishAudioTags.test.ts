import test from "node:test";
import assert from "node:assert/strict";

// ttsTags is a pure module: no DB / settings imports, so a direct import is
// safe without the temp-DB dance other tests need.
const tags = await import("../src/services/ttsTags.js");

test("adaptTextForFishTts maps exact short Chinese cues to the Fish S2 lexicon", () => {
  assert.equal(tags.adaptTextForFishTts("[笑]你还在吗"), "[laughing]你还在吗");
  assert.equal(tags.adaptTextForFishTts("[叹气]算了。"), "[sighing]算了。");
  assert.equal(tags.adaptTextForFishTts("[兴奋]出发！"), "[excited]出发！");
});

test("adaptTextForFishTts keeps free-form descriptions as-is", () => {
  // APP 端同款行为：不在精确词典里的自由描述原样保留（Fish S2 按
  // 「声音参数」语义解析；动作短语才会被朗读，由提示词约束）。
  assert.equal(tags.adaptTextForFishTts("[强撑的开心]我没事"), "[强撑的开心]我没事");
});

test("adaptTextForFishTts converts real markdown links to their label text", () => {
  // 对齐 APP 端顺序：stripMarkdown（链接 → 文案）先于括号剥离，链接目标
  // 不会被当成舞台说明吃掉，也不会被映射规则碰。
  assert.equal(tags.adaptTextForFishTts("看[文案](https://fish.audio/docs)这篇"), "看文案这篇");
});

test("adaptTextForFishTts drops stage-direction parens next to a tag", () => {
  // `[恍然大悟](拍了下脑门)`：标签后跟动作圆括号——形状与 Markdown 链接
  // 一致，但目标不是链接地址，所以标签照常映射、圆括号剥离。
  assert.equal(
    tags.adaptTextForFishTts("[恍然大悟](拍了下脑门)原来如此"),
    "[恍然大悟] 原来如此",
  );
});

test("dropFishParenCues handles nesting and unclosed tails", () => {
  assert.equal(tags.dropFishParenCues("a（外（内）外）b"), "a b");
  // 跨度超限 / 没闭合：保留原文，宁可多念也不吞台词。
  const long = "正（" + "长".repeat(301) + "）尾";
  assert.equal(tags.dropFishParenCues(long), long);
  assert.equal(tags.dropFishParenCues("正文（没闭合"), "正文（没闭合");
});

test("adaptTextForFishTts keeps parens when dropParens is false", () => {
  assert.equal(
    tags.adaptTextForFishTts("[笑]（挥手）来了", { dropParens: false }),
    "[laughing]（挥手）来了",
  );
});

test("adaptTextForFishTts normalizes fullwidth brackets first", () => {
  assert.equal(tags.adaptTextForFishTts("【笑】好呀"), "[laughing]好呀");
});
