import WebSocket from "ws";
import { wavHeader } from "./ttsService.js";
import { breezeEmotionModeEnabled } from "./ttsTags.js";
import { parseBreezeReply } from "./breezeBlueTags.js";

/**
 * Breeze Blue (BYOK) TTS — Node port of the APP-side integration.
 *
 * Transport is WebSocket-only: `wss://api.breeze.blue/v1/text-to-speech/
 * {voice_id}/stream-input` with `xi-api-key`; no session-mint HTTP call and
 * no HTTP synthesis path. Protocol per the APP-side `NativeTtsBreezeBlue`:
 *
 *   session.ready → session.update? (instructions) → turn.start →
 *   text.append* → turn.end → turn.done / turn.cancelled
 *
 * Binary frames are PCM @24kHz. Heartbeat is an application-level
 * `{"type":"ping"}` / `{"type":"pong"}` pair (15s interval, any inbound frame
 * counts as liveness). The `<emo>` first line of the model reply is the
 * separate `instructions` field and is never spoken.
 */

const BREEZE_BLUE_API_ORIGIN = "https://api.breeze.blue";
const BREEZE_BLUE_GUIDANCE_SCALE = 3;
export const BREEZE_BLUE_SAMPLE_RATE = 24_000;
const BREEZE_BLUE_INACTIVITY_TIMEOUT_SECONDS = 120;
/** `text.append` single-message cap from the APP-side wire implementation. */
const BREEZE_TEXT_APPEND_MAX_BYTES = 2_000;
const BREEZE_HEARTBEAT_INTERVAL_MS = 15_000;
const BREEZE_PONG_TIMEOUT_MS = 5_000;
const BREEZE_CONNECT_TIMEOUT_MS = 15_000;
const BREEZE_CONTROL_TIMEOUT_MS = 30_000;

/**
 * Breeze 服务的 HTTP / WS 共用 origin。设置里可覆盖（自建代理等），默认与
 * APP 端一致的官方地址。
 */
function breezeApiOrigin(settings: Record<string, any>): string {
  const raw = String(settings?.ttsBreezeBlueApiOrigin || "").trim().replace(/\/+$/, "");
  return raw || BREEZE_BLUE_API_ORIGIN;
}

export interface BreezeBlueVoiceInfo {
  voiceId: string;
  name: string;
  languageCode: string;
  accent: string;
}

interface BreezeConfig {
  apiKey: string;
  voiceId: string;
  model: string;
}

function breezeConfigFromSettings(settings: Record<string, any>, voiceOverride?: string | null): BreezeConfig {
  return {
    apiKey: String(settings.ttsBreezeBlueApiKey || "").trim(),
    voiceId: String(voiceOverride || settings.ttsBreezeBlueVoiceId || "").trim(),
    model: String(settings.ttsBreezeBlueModel || "breeze-tts-2").trim() || "breeze-tts-2",
  };
}

function assertBreezeConfig(config: BreezeConfig): void {
  if (!config.apiKey) {
    throw Object.assign(new Error("请先填写 Breeze Blue API Key"), { statusCode: 503 });
  }
  if (!config.voiceId) {
    throw Object.assign(new Error("请先填写 Breeze Blue 音色 ID"), { statusCode: 503 });
  }
}

function buildStreamInputUrl(origin: string, voiceId: string, model: string): string {
  const params = new URLSearchParams({
    model_id: model,
    output_format: "pcm",
    language_code: "zh",
    guidance_scale: String(BREEZE_BLUE_GUIDANCE_SCALE),
    inactivity_timeout_seconds: String(BREEZE_BLUE_INACTIVITY_TIMEOUT_SECONDS),
    enable_logging: "true",
  });
  const wsOrigin = origin.replace(/^https:/, "wss:");
  return `${wsOrigin}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${params.toString()}`;
}

/** APP-side `splitByUTF8Bytes`: never split a multi-byte character. */
function splitByUtf8Bytes(text: string, maxBytes = BREEZE_TEXT_APPEND_MAX_BYTES): string[] {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const scalar of text) {
    const width = Buffer.byteLength(scalar, "utf8");
    if (bytes + width > maxBytes && current) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += scalar;
    bytes += width;
  }
  if (current) out.push(current);
  return out;
}

/** Chinese user-facing mapping for HTTP status / WebSocket close codes. */
export function mapBreezeBlueError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim();
  const wrap = (detail: string, statusCode = 502) =>
    Object.assign(new Error(detail), { statusCode });
  if (/AUTH_REQUIRED|AUTH_SESSION_EXPIRED|\b401\b|unauthorized|invalid api key/i.test(normalized)) {
    return wrap("Breeze API Key 无效，请重新填写", 401);
  }
  if (/API_KEY_CREDIT_LIMIT_EXCEEDED/i.test(normalized)) {
    return wrap("该 Breeze API Key 额度已用尽");
  }
  if (/BILLING_INSUFFICIENT_CREDITS|\b402\b|insufficient credits/i.test(normalized)) {
    return wrap("Breeze 账户余额不足", 402);
  }
  if (/RESOURCE_NOT_FOUND|\b404\b|voice.*not found/i.test(normalized)) {
    return wrap("voice_id 不存在，或不属于该 Key 的账号", 404);
  }
  if (/GENERATION_CONCURRENCY_EXCEEDED|\b429\b|rate.?limit/i.test(normalized)) {
    return wrap("Breeze 并发已满，请稍后重试", 429);
  }
  if (/GENERATION_CAPACITY_EXCEEDED|\b503\b|capacity/i.test(normalized)) {
    return wrap("Breeze 服务容量不足，请稍后重试");
  }
  if (/1012|reconnect/i.test(normalized)) {
    return wrap("Breeze 服务正在重启，请稍后重试");
  }
  return wrap(normalized || "Breeze Blue 语音合成失败");
}

/**
 * Voice lookup only (not synthesis). Used by the settings page to confirm the
 * pasted `voc_...` belongs to the same Breeze account as the API key.
 */
export async function validateBreezeBlueVoice(
  voiceId: string,
  apiKey: string,
  originOverride?: string,
): Promise<BreezeBlueVoiceInfo> {
  const id = (voiceId || "").trim();
  const key = (apiKey || "").trim();
  if (!id) throw Object.assign(new Error("请先填写 Breeze Blue 音色 ID"), { statusCode: 400 });
  if (!key) throw Object.assign(new Error("请先填写 Breeze Blue API Key"), { statusCode: 400 });
  let response: Response;
  try {
    response = await fetch(
      `${originOverride?.trim().replace(/\/+$/, "") || BREEZE_BLUE_API_ORIGIN}/v1/voices/${encodeURIComponent(id)}`,
      { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) },
    );
  } catch (error) {
    throw mapBreezeBlueError(error);
  }
  if (!response.ok) {
    throw mapBreezeBlueError(
      new Error(`HTTP ${response.status} ${await response.text().catch(() => "")}`),
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    voiceId: String(payload.voice_id || id),
    name: String(payload.name || id),
    languageCode: String(payload.language_code || ""),
    accent: payload.accent == null ? "" : String(payload.accent),
  };
}

/**
 * Extract the `<emo>` performance instruction from a raw model reply. Only
 * meaningful while emotion mode is on; otherwise Breeze gets no instructions.
 */
export function resolveBreezeInstruction(
  provider: string,
  settings: Record<string, any>,
  rawText: string,
): string {
  if (provider !== "breeze_blue") return "";
  if (!breezeEmotionModeEnabled(settings)) return "";
  return parseBreezeReply(String(rawText || "")).instruction;
}

interface BreezeTurnInput {
  config: BreezeConfig;
  /** HTTP / WS origin override (settings.ttsBreezeBlueApiOrigin). */
  origin: string;
  /** Spoken body only — the `<emo>` line must already be stripped. */
  text: string;
  instruction?: string;
  signal?: AbortSignal;
  onAudio: (chunk: Buffer) => void;
}

/**
 * One synthesis turn over a fresh WebSocket. Resolves after `turn.done`,
 * rejects on error frames / close / heartbeat loss / abort.
 */
async function runBreezeTurn(input: BreezeTurnInput): Promise<void> {
  const { config, origin, text, instruction = "", signal, onAudio } = input;
  assertBreezeConfig(config);
  if (!text.trim()) throw Object.assign(new Error("text is empty"), { statusCode: 400 });
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("Breeze 合成已取消"), { name: "AbortError" });
  }

  const socket = new WebSocket(
    buildStreamInputUrl(origin, config.voiceId, config.model),
    {
      headers: {
        "xi-api-key": config.apiKey,
        "user-agent": "lingshu-harness",
      },
    },
  );

  let settled = false;
  let expiring = false;
  let turnActive = false;
  let lastInboundAt = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let pongTimer: NodeJS.Timeout | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  let controlTimer: NodeJS.Timeout | null = null;
  let lastError: Error | null = null;

  const clearTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pongTimer) clearTimeout(pongTimer);
    if (connectTimer) clearTimeout(connectTimer);
    if (controlTimer) clearTimeout(controlTimer);
    heartbeatTimer = pongTimer = connectTimer = controlTimer = null;
  };
  const closeSocket = () => {
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
  const settleSuccess = () => {
    if (settled) return;
    settled = true;
    clearTimers();
    closeSocket();
  };
  const settleFailure = (error: Error) => {
    if (settled) return;
    settled = true;
    lastError = error;
    clearTimers();
    closeSocket();
  };
  const abortError = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("Breeze 合成已取消"), { name: "AbortError" });

  const result = new Promise<void>((resolve, reject) => {
    const flushFailure = () => {
      settleFailure(lastError ?? new Error("Breeze Blue 语音合成失败"));
      reject(lastError!);
    };

    socket.on("open", () => {
      connectTimer = setTimeout(() => {
        settleFailure(new Error("Breeze 连接超时"));
        reject(lastError!);
      }, BREEZE_CONNECT_TIMEOUT_MS);
    });

    socket.on("message", (data, isBinary) => {
      lastInboundAt = Date.now();
      if (isBinary) {
        const chunk = Buffer.from(data as Buffer);
        if (chunk.length) onAudio(chunk);
        return;
      }
      let payload: Record<string, any>;
      try {
        payload = JSON.parse((data as Buffer).toString("utf8"));
      } catch {
        return;
      }
      const type = String(payload.type || "");
      switch (type) {
        case "session.ready":
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          startHeartbeat();
          if (instruction) {
            sendJson({ type: "session.update", instructions: instruction });
            armControlTimer("session.updated");
          } else {
            startTurn();
          }
          break;
        case "session.updated":
          if (controlTimer) {
            clearTimeout(controlTimer);
            controlTimer = null;
          }
          startTurn();
          break;
        case "session.expiring":
          expiring = true;
          break;
        case "turn.started":
          turnActive = true;
          break;
        case "turn.done":
          settleSuccess();
          resolve();
          break;
        case "turn.cancelled":
          settleFailure(new Error("Breeze 已取消本轮合成"));
          reject(lastError!);
          break;
        case "error": {
          const code = String(payload.code || "");
          const message = String(payload.message || "Breeze 语音合成失败");
          settleFailure(mapBreezeBlueError(new Error(code ? `${message} (${code})` : message)));
          reject(lastError!);
          break;
        }
        default:
          break;
      }
    });

    socket.on("close", (code) => {
      if (settled) return;
      settleFailure(mapBreezeBlueError(new Error(`Breeze 连接已关闭 (${code})`)));
      reject(lastError!);
    });
    socket.on("error", (error: Error) => {
      settleFailure(mapBreezeBlueError(error));
      reject(lastError!);
    });

    if (signal) {
      if (signal.aborted) {
        flushFailure();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          try {
            if (turnActive) sendJson({ type: "turn.cancel" });
          } catch {
            // best-effort cancel
          }
          settleFailure(abortError());
          reject(lastError!);
        },
        { once: true },
      );
    }

    function sendJson(payload: Record<string, unknown>) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(payload));
    }

    /** `session.update` rejects an empty `instructions` string — callers skip it. */
    function startTurn() {
      sendJson({ type: "turn.start" });
      for (const chunk of splitByUtf8Bytes(text)) {
        sendJson({ type: "text.append", text: chunk });
      }
      sendJson({ type: "turn.end" });
      armControlTimer("turn.done");
    }

    function armControlTimer(expected: string) {
      if (controlTimer) clearTimeout(controlTimer);
      controlTimer = setTimeout(() => {
        settleFailure(new Error(`Breeze 未返回 ${expected}，合成中止`));
        reject(lastError!);
      }, BREEZE_CONTROL_TIMEOUT_MS);
    }

    function startHeartbeat() {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const pingSentAt = Date.now();
        sendJson({ type: "ping" });
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          if (settled) return;
          if (lastInboundAt < pingSentAt) {
            settleFailure(new Error("Breeze 语音连接心跳超时（5s 未收到 pong）"));
            reject(lastError!);
          }
        }, BREEZE_PONG_TIMEOUT_MS);
      }, BREEZE_HEARTBEAT_INTERVAL_MS);
    }
  });

  try {
    return await result;
  } finally {
    clearTimers();
    if (!settled) {
      settled = true;
      closeSocket();
    }
  }
}

function createAudioQueue() {
  const items: Buffer[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  let failure: Error | null = null;
  return {
    push(chunk: Buffer) {
      items.push(chunk);
      const wake = notify;
      notify = null;
      wake?.();
    },
    close() {
      closed = true;
      const wake = notify;
      notify = null;
      wake?.();
    },
    fail(error: Error) {
      failure = error;
      closed = true;
      const wake = notify;
      notify = null;
      wake?.();
    },
    async *drain(): AsyncGenerator<Buffer, void, unknown> {
      while (true) {
        while (items.length) yield items.shift()!;
        if (closed) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((wake) => {
          notify = wake;
        });
      }
    },
  };
}

/** Streamed synthesis: PCM audio frames as they arrive from Breeze. */
export async function startBreezeAudioStream(
  settings: Record<string, any>,
  text: string,
  signal: AbortSignal,
  voiceOverride?: string | null,
  instruction = "",
): Promise<AsyncGenerator<Buffer, void, unknown>> {
  const config = breezeConfigFromSettings(settings, voiceOverride);
  assertBreezeConfig(config);
  const queue = createAudioQueue();
  runBreezeTurn({ config, origin: breezeApiOrigin(settings), text, instruction, signal, onAudio: (chunk) => queue.push(chunk) })
    .then(() => queue.close())
    .catch((error) => queue.fail(error instanceof Error ? error : new Error(String(error))));
  return queue.drain();
}

export interface BreezeSynthesisResult {
  data: Buffer;
  format: string;
  sampleRate: number;
  mimeType: string;
}

/** One-shot synthesis: collect the whole turn, wrap the PCM into a WAV. */
export async function synthesizeBreezeBlue(
  settings: Record<string, any>,
  text: string,
  voiceOverride?: string | null,
  instruction = "",
): Promise<BreezeSynthesisResult> {
  const config = breezeConfigFromSettings(settings, voiceOverride);
  assertBreezeConfig(config);
  const chunks: Buffer[] = [];
  await runBreezeTurn({ config, origin: breezeApiOrigin(settings), text, instruction, onAudio: (chunk) => chunks.push(chunk) });
  if (!chunks.length) {
    throw Object.assign(new Error("Breeze Blue 未返回音频"), { statusCode: 502 });
  }
  const pcm = Buffer.concat(chunks);
  return {
    data: Buffer.concat([wavHeader(pcm.length, BREEZE_BLUE_SAMPLE_RATE), pcm]),
    format: "wav",
    sampleRate: BREEZE_BLUE_SAMPLE_RATE,
    mimeType: "audio/wav",
  };
}
