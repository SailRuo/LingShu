import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingshu-prompt-cache-"));
process.env.DB_PATH = path.join(tempDir, "test.db");

const promptBlocks = await import("../src/services/memoryPromptBlocks.js");

function baseInput(knownFactLines: string[]) {
  return {
    agentName: "灵儿",
    roleIdentity: "测试人设",
    memoryStreamLines: [],
    knownFactLines,
    userPortraitText: "",
    userPortraitDimensions: {},
    preferenceLines: [],
    usBlock: "",
    stageAttention: "",
    hisCurrentState: "",
    lastSeenText: "",
    appointmentText: "",
    appointmentReminderHint: "",
    innerRippleLines: [],
    speakingStyleLines: [],
    scene: {
      voiceCall: false,
      surface: "guiv1_pc",
      interactionMode: "chat",
      inputKind: "text",
      outputMode: "text",
    },
    selfPortraitBlock: "",
  };
}

test("policy patches stay volatile: crisis facts never change the stable prefix", () => {
  const calm = promptBlocks.composeSystemPromptParts(baseInput([]));
  const crisis = promptBlocks.composeSystemPromptParts(
    baseInput(["他曾经想自杀。"]),
  );
  const crisisAgain = promptBlocks.composeSystemPromptParts(
    baseInput(["他曾经想自杀。"]),
  );

  assert.equal(calm.stable, crisis.stable, "stable prompt must be byte-identical");
  assert.equal(crisis.stable, crisisAgain.stable, "stable prompt is deterministic");
  assert.doesNotMatch(calm.stable, /系统安全约束/);
  assert.doesNotMatch(crisis.stable, /系统安全约束/);
  assert.match(crisis.volatile, /系统安全约束/);
  assert.notEqual(calm.volatile, crisis.volatile);
});
