import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";

// breezeBlueTts only reads the settings object passed in, so a fake settings
// row plus a local mock WebSocket server exercises the whole wire protocol
// without touching the DB or the real Breeze endpoint.
const { synthesizeBreezeBlue, startBreezeAudioStream, mapBreezeBlueError } = await import(
  "../src/services/breezeBlueTts.js"
);

const WAV_HEADER_BYTES = 44;

interface MockServerOptions {
  /** Frames to push after turn.end, one Buffer per binary audio frame. */
  audioFrames?: Buffer[];
  /** Simulate an error frame instead of completing the turn. */
  errorFrame?: { code: string; message: string };
}

function startMockBreeze(options: MockServerOptions = {}): Promise<{
  origin: string;
  close: () => Promise<void>;
  seen: () => Record<string, unknown>[];
}> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen: Record<string, unknown>[] = [];
  wss.on("connection", (socket) => {
    let turnStarted = false;
    socket.send(JSON.stringify({ type: "session.ready" }));
    socket.on("message", (data) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      seen.push(payload);
      if (payload.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (payload.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", instructions: payload.instructions }));
        return;
      }
      if (payload.type === "turn.start") turnStarted = true;
      if (payload.type === "turn.end" && turnStarted) {
        if (options.errorFrame) {
          socket.send(JSON.stringify({ type: "error", ...options.errorFrame }));
          return;
        }
        for (const frame of options.audioFrames ?? []) socket.send(frame);
        socket.send(JSON.stringify({ type: "turn.done" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => wss.close(() => server.close(() => done()))),
        seen: () => seen,
      });
    });
  });
}

function fakeSettings(origin: string): Record<string, any> {
  return {
    ttsBreezeBlueApiKey: "test-key",
    ttsBreezeBlueVoiceId: "voc_test",
    ttsBreezeBlueModel: "breeze-tts-2",
    ttsBreezeBlueApiOrigin: origin,
  };
}

const PCM_CHUNK = Buffer.alloc(960, 0x01);

test("synthesizeBreezeBlue runs the full turn protocol and wraps PCM into WAV", async () => {
  const mock = await startMockBreeze({ audioFrames: [PCM_CHUNK, PCM_CHUNK] });
  try {
    const result = await synthesizeBreezeBlue(fakeSettings(mock.origin), "你好，灵枢。", null, "开心、雀跃");
    assert.equal(result.format, "wav");
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.mimeType, "audio/wav");
    // Two PCM frames of 960 bytes each, plus the 44-byte WAV header.
    assert.equal(result.data.length, WAV_HEADER_BYTES + PCM_CHUNK.length * 2);
    assert.equal(result.data.subarray(0, 4).toString("ascii"), "RIFF");

    const messages = mock.seen();
    assert.deepEqual(messages[0], { type: "session.update", instructions: "开心、雀跃" });
    const appends = messages.filter((m) => m.type === "text.append");
    assert.equal(appends.length, 1);
    assert.equal(appends[0].text, "你好，灵枢。");
    assert.ok(messages.some((m) => m.type === "turn.start"));
    assert.ok(messages.some((m) => m.type === "turn.end"));
  } finally {
    await mock.close();
  }
});

test("synthesizeBreezeBlue skips session.update when no instruction is given", async () => {
  const mock = await startMockBreeze({ audioFrames: [PCM_CHUNK] });
  try {
    await synthesizeBreezeBlue(fakeSettings(mock.origin), "正文", null, "");
    const messages = mock.seen();
    assert.ok(!messages.some((m) => m.type === "session.update"));
    assert.ok(messages.some((m) => m.type === "turn.start"));
  } finally {
    await mock.close();
  }
});

test("startBreezeAudioStream yields PCM frames as they arrive", async () => {
  const mock = await startMockBreeze({ audioFrames: [PCM_CHUNK, PCM_CHUNK, PCM_CHUNK] });
  try {
    const source = await startBreezeAudioStream(fakeSettings(mock.origin), "流式正文");
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(chunk);
    assert.equal(chunks.length, 3);
  } finally {
    await mock.close();
  }
});

test("error frames map to Chinese user-facing messages", async () => {
  const mock = await startMockBreeze({
    errorFrame: { code: "AUTH_REQUIRED", message: "bad key" },
  });
  try {
    await assert.rejects(
      synthesizeBreezeBlue(fakeSettings(mock.origin), "你好"),
      /Breeze API Key 无效/,
    );
  } finally {
    await mock.close();
  }
});

test("mapBreezeBlueError covers the HTTP / close-code table", () => {
  assert.match(mapBreezeBlueError(new Error("Unexpected server response: 401")).message, /API Key 无效/);
  assert.match(mapBreezeBlueError(new Error("HTTP 404 not found")).message, /voice_id 不存在/);
  assert.match(mapBreezeBlueError(new Error("closed 1012")).message, /正在重启/);
  assert.match(mapBreezeBlueError(new Error("")).message, /Breeze Blue 语音合成失败/);
});

test("UTF-8 splitting never breaks a multi-byte character", async () => {
  const mock = await startMockBreeze({ audioFrames: [PCM_CHUNK] });
  try {
    const longText = "你".repeat(1500); // 4500 bytes → 3 appends, no torn character
    await synthesizeBreezeBlue(fakeSettings(mock.origin), longText);
    const appends = mock.seen().filter((m) => m.type === "text.append");
    assert.equal(appends.length, 3);
    const joined = appends.map((m) => m.text).join("");
    assert.equal(joined, longText);
  } finally {
    await mock.close();
  }
});
