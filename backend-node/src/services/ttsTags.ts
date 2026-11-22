/**
 * Inline `[]` emotion / paralinguistic tags — TTS-only visibility.
 *
 * Node port of Python `backend/core/tts/fish_tags.py`.
 *
 * The model writes inline cues such as `[兴奋]` / `[小声]` / `[whispering]`.
 * Those cues are *never* shown in the UI and *never* persisted; only Fish
 * Audio and Xiaomi MiMo receive them on the TTS wire, and only while their
 * emotion mode is on. Every other provider must receive the text without the
 * tags, otherwise the tags would be read out loud.
 */

/** Descriptive tags (tone + ambience) often exceed short labels like [兴奋]. */
export const FISH_TAG_INNER_MAX = 120;
/** '[' + inner (+ waiting for ']') */
export const FISH_TAG_PENDING_MAX = FISH_TAG_INNER_MAX + 2;

/** `[label]` — the negative lookahead keeps markdown links (`[text](url)`) intact. */
export const FISH_TAG_RE = /\[[^\[\]\n]{1,120}\](?!\()/;

/** Same as {@link FISH_TAG_RE} but also eats one trailing space/tab. */
const FISH_TAG_STRIP_RE = /\[[^\[\]\n]{1,120}\](?!\()[ \t]?/g;

const COMPLETE_TAG_RE = /^\[[^\[\]\n]{1,120}\]$/;

export interface DisplayAndTts {
  /** Text for the UI / DB / LLM history — always tag-free. */
  display: string;
  /** Text for the TTS wire — only set when it differs from `display`. */
  tts: string | null;
}

export interface TagStreamPieces {
  display: string;
  tts: string;
}

/** Fullwidth / CJK brackets are normalized to the halfwidth `[]` form. */
export function normalizeEmotionSquareBrackets(text: string): string {
  if (!text) return text;
  return text
    .replace(/［/g, "[")
    .replace(/］/g, "]")
    .replace(/【/g, "[")
    .replace(/】/g, "]");
}

/** Strip `[]` TTS cues for UI / DB / LLM history. Leaves markdown links alone. */
export function stripFishTags(text: string): string {
  if (!text) return text;
  const normalized = normalizeEmotionSquareBrackets(text);
  let cleaned = normalized.replace(FISH_TAG_STRIP_RE, "");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/ *\n */g, "\n");
  cleaned = cleaned.replace(/\n{2,}/g, "\n");
  return cleaned.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

/** Split one blob of model output into its display and TTS variants. */
export function splitDisplayAndTts(text: string, keepTagsForTts: boolean): DisplayAndTts {
  const display = stripFishTags(text);
  if (!keepTagsForTts) return { display, tts: null };
  const tts = normalizeEmotionSquareBrackets(text).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return { display, tts: tts !== display ? tts : null };
}

/**
 * Python `fish_tags.py::_active_tts_provider`.
 * Accepts the Python nested shape (`settings.tts.active_provider`) and the
 * flat Node settings shape (`settings.ttsActiveProvider`).
 */
export function activeTtsProvider(settings: Record<string, any> | null | undefined): string {
  const tts = settings?.tts;
  if (tts && typeof tts === "object") {
    const name = String(tts.active_provider ?? tts.activeProvider ?? "").trim().toLowerCase();
    if (name === "xiaomi_mimo") return "xiaomo_mimo";
    return name;
  }
  const flat = String(settings?.ttsActiveProvider ?? "").trim().toLowerCase();
  if (flat === "xiaomi_mimo") return "xiaomo_mimo";
  return flat;
}

/**
 * Read a provider-level `emotion_mode` flag. An unset / missing flag defaults
 * to on, so installs that predate the switch keep the behaviour they had.
 *
 * The flat key is what the Node settings store persists; the nested
 * `settings.tts.providers.*` shape is the Python-compatible one.
 */
function readProviderEmotionMode(
  settings: Record<string, any> | null | undefined,
  providerKeys: string[],
  flatKey: string,
): boolean {
  if (!settings) return true;
  const flat = settings[flatKey];
  if (flat !== undefined && flat !== null) return Boolean(flat);
  const tts = settings.tts;
  if (tts && typeof tts === "object") {
    const providers = tts.providers;
    const provider = providers
      ? providerKeys
          .map((key) => providers[key])
          .find((item) => item !== undefined && item !== null)
      : undefined;
    if (provider === undefined || provider === null) return true;
    const raw = provider.emotion_mode ?? provider.emotionMode;
    if (raw === undefined || raw === null) return true;
    return Boolean(raw);
  }
  return true;
}

/** Fish Audio emotion mode flag. Missing flag defaults to on. */
export function fishEmotionModeEnabled(settings: Record<string, any> | null | undefined): boolean {
  return readProviderEmotionMode(settings, ["fish_audio"], "ttsFishAudioEmotionMode");
}

/** Fish Audio consumes `[]` tags on the TTS wire while emotion mode is on. */
export function fishTagsEnabledForActiveProvider(settings: Record<string, any> | null | undefined): boolean {
  return activeTtsProvider(settings) === "fish_audio" && fishEmotionModeEnabled(settings);
}

/**
 * Xiaomi MiMo emotion mode. An unset / missing flag defaults to on
 * (app-local compatible), like the Python implementation.
 */
export function xiaomiEmotionModeEnabled(settings: Record<string, any> | null | undefined): boolean {
  if (activeTtsProvider(settings) !== "xiaomo_mimo") return false;
  return readProviderEmotionMode(
    settings,
    ["xiaomo_mimo", "xiaomi_mimo"],
    "ttsXiaomoMimoEmotionMode",
  );
}

/**
 * Breeze Blue emotion mode: the model emits a `<emo>` performance-instruction
 * first line, driven by the provider LLM hint. An unset flag defaults to on,
 * matching the APP-side `TTS_DEFAULTS.breezeBlueEmotionMode`.
 */
export function breezeEmotionModeEnabled(settings: Record<string, any> | null | undefined): boolean {
  return readProviderEmotionMode(settings, ["breeze_blue"], "ttsBreezeBlueEmotionMode");
}

/**
 * Breeze Blue keeps its `[]` audio-event tags on the TTS wire whenever it is
 * the active provider (not gated by emotion mode — the events are part of the
 * Breeze protocol itself, mirroring the APP-side sanitizer).
 */
export function breezeTagsEnabledForActiveProvider(settings: Record<string, any> | null | undefined): boolean {
  return activeTtsProvider(settings) === "breeze_blue";
}

/** Fish, Xiaomi MiMo and Breeze Blue keep `[]` tags on the TTS wire. */
export function keepEmotionTagsForTts(settings: Record<string, any> | null | undefined): boolean {
  return (
    fishTagsEnabledForActiveProvider(settings) ||
    xiaomiEmotionModeEnabled(settings) ||
    breezeTagsEnabledForActiveProvider(settings)
  );
}

/**
 * Provider-level counterpart of {@link keepEmotionTagsForTts}, used by the TTS
 * service where only the resolved provider name is known.
 */
export function providerKeepsEmotionTags(
  provider: string | null | undefined,
  settings?: Record<string, any> | null,
): boolean {
  const name = String(provider || "").trim().toLowerCase();
  if (name === "fish_audio") return fishEmotionModeEnabled(settings);
  if (name === "xiaomo_mimo" || name === "xiaomi_mimo") {
    return readProviderEmotionMode(
      settings ?? null,
      ["xiaomo_mimo", "xiaomi_mimo"],
      "ttsXiaomoMimoEmotionMode",
    );
  }
  // Breeze 协议自带 [] 音频事件与 <emo> 行的处理，始终按协议清洗。
  if (name === "breeze_blue") return true;
  return false;
}

/**
 * Hold an incomplete `[...]` across chunks; emit display vs TTS pieces.
 * Port of Python `fish_tags.py::FishTagStreamFilter`.
 */
export class FishTagStreamFilter {
  private pending = "";

  /** Feed one raw chunk; returns the display piece and the TTS piece. */
  feed(chunk: string): TagStreamPieces {
    if (!chunk && !this.pending) return { display: "", tts: "" };
    const buf = normalizeEmotionSquareBrackets(this.pending + (chunk || ""));
    this.pending = "";
    const displayParts: string[] = [];
    const ttsParts: string[] = [];
    let i = 0;
    while (i < buf.length) {
      const openIdx = buf.indexOf("[", i);
      if (openIdx < 0) {
        const rest = buf.slice(i);
        displayParts.push(rest);
        ttsParts.push(rest);
        break;
      }
      const prefix = buf.slice(i, openIdx);
      displayParts.push(prefix);
      ttsParts.push(prefix);
      const close = buf.indexOf("]", openIdx + 1);
      if (close === -1) {
        const rest = buf.slice(openIdx);
        if (rest.includes("\n") || rest.length > FISH_TAG_PENDING_MAX) {
          displayParts.push(rest);
          ttsParts.push(rest);
        } else {
          this.pending = rest;
        }
        break;
      }
      // Wait one extra char so `[label]` + `(url)` is not treated as a TTS tag.
      if (close === buf.length - 1) {
        this.pending = buf.slice(openIdx);
        break;
      }
      const candidate = buf.slice(openIdx, close + 1);
      const inner = candidate.slice(1, -1);
      const nextCh = buf[close + 1];
      const isTtsTag =
        inner.length >= 1 &&
        inner.length <= FISH_TAG_INNER_MAX &&
        !inner.includes("[") &&
        !inner.includes("\n") &&
        nextCh !== "(";
      if (isTtsTag) {
        // TTS-only: the tag never reaches the display stream.
        ttsParts.push(candidate);
      } else {
        displayParts.push(candidate);
        ttsParts.push(candidate);
      }
      i = close + 1;
    }
    return { display: displayParts.join(""), tts: ttsParts.join("") };
  }

  /** Flush the leftover buffer at the end of the stream. */
  flush(): TagStreamPieces {
    if (!this.pending) return { display: "", tts: "" };
    const leftover = normalizeEmotionSquareBrackets(this.pending);
    this.pending = "";
    if (COMPLETE_TAG_RE.test(leftover)) return { display: "", tts: leftover };
    return { display: leftover, tts: leftover };
  }
}

/* ------------------------------------------------------------------ *
 * Fish S2 线上预处理（Node port of APP-side fishAudioTags.ts）。
 *
 * Fish S2 的情绪词典以英文为准；模型按提示词写的中文短标签（[笑] [叹气]）
 * 原样上送会被 Fish 当正文朗读。APP 端在合成前做三件事，这里逐一移植：
 *   1. 深度感知剥掉 `（…）` / `(…)` 舞台说明（嵌套、可跨行、≤300 字）；
 *   2. 精确中文短标签 → Fish 英文词典；自由描述原样保留；
 *   3. `[文案](url)` 只有目标像链接地址才算链接——模型把动作写在半角括号里
 *      跟在标签后（`[恍然大悟](拍了下脑门)`）时，形状与 Markdown 链接一致，
 *      一律当链接会把标签文字当正文朗读。
 */

/** Exact short Chinese cues → Fish S2 English lexicon (free-form descriptions stay as-is). */
const FISH_ZH_TAG_TO_EN: Record<string, string> = {
  悲伤: "sad", 伤心: "sad", 难过: "sad", 低落: "sad",
  哭泣: "sobbing", 抽泣: "sobbing", 哭: "sobbing", 哭腔: "sobbing",
  开心: "happy", 高兴: "happy", 快乐: "happy",
  愤怒: "angry", 生气: "angry", 恼火: "angry",
  紧张: "nervous", 焦虑: "anxious", 害怕: "scared",
  兴奋: "excited", 惊讶: "surprised",
  温柔: "soft tone", 轻声: "whispering", 耳语: "whispering",
  大喊: "shouting", 急促: "in a hurry tone",
  叹气: "sighing", 笑: "laughing", 喘气: "panting",
};

/** `[标签](目标)` 只有目标像真实链接地址时才算 Markdown 链接。 */
export const MARKDOWN_LINK_TARGET_PATTERN =
  "(?:[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/|mailto:|tel:|www\\.|\\/|#|\\.{1,2}\\/)\\S*";

const MARKDOWN_LINK_TARGET_RE = new RegExp(`^(?:${MARKDOWN_LINK_TARGET_PATTERN})$`);

/** 标签规则里的链接守卫：紧跟其后的圆括号装着链接目标时，这个 `[]` 是链接文案。 */
export const MARKDOWN_LINK_TAG_GUARD = `(?!\\((?:${MARKDOWN_LINK_TARGET_PATTERN})\\))`;

/**
 * 圆括号舞台说明的最大跨度（含换行、可嵌套）。超过就当模型忘了收尾：保留原文，
 * 宁可多念一句，也不把后面的台词整段吞掉。
 */
export const FISH_PAREN_CUE_MAX = 300;

/**
 * 去掉 `（…）` / `(…)` 舞台说明，从语音里剥掉（UI 仍显示）。
 * 深度感知扫描：支持换行与嵌套，跨度超过 {@link FISH_PAREN_CUE_MAX} 或压根
 * 没闭合时保留原文。
 */
export function dropFishParenCues(text: string, maxInner = FISH_PAREN_CUE_MAX): string {
  if (!text) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch !== "（" && ch !== "(") {
      out += ch;
      index += 1;
      continue;
    }
    let depth = 1;
    let cursor = index + 1;
    let inner = 0;
    while (cursor < text.length && depth > 0 && inner <= maxInner) {
      const current = text[cursor]!;
      if (current === "（" || current === "(") {
        depth += 1;
      } else if (current === "）" || current === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      inner += 1;
      cursor += 1;
    }
    if (depth === 0) {
      out += " ";
      index = cursor + 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function mapFishTagInner(inner: string): string {
  const key = (inner || "").trim();
  return FISH_ZH_TAG_TO_EN[key] || key;
}

/**
 * Fish TTS wire prep：真实 Markdown 链接先转成可见文案（对齐 APP 端
 * stripMarkdown 先于 adapt 的顺序），再剥括号舞台说明 + 中文短标签映射
 * 英文词典。`[]` 标签一律保留（Fish 侧消费），只做精确映射。
 */
export function adaptTextForFishTts(
  text: string,
  options?: { dropParens?: boolean },
): string {
  if (!text) return text;
  const square = new RegExp(
    `\\[([^\\[\\]\\n]{1,${FISH_TAG_INNER_MAX}})\\]${MARKDOWN_LINK_TAG_GUARD}`,
    "g",
  );
  // `[文案](url)` 只有目标像链接地址才算链接；先转换，避免 dropFishParenCues
  // 把链接目标当舞台说明吃掉（APP 端 stripMarkdown → adapt 的顺序）。
  const mdLink = new RegExp(
    `\\[([^\\[\\]\\n]{1,${FISH_TAG_INNER_MAX}})\\]\\(${MARKDOWN_LINK_TARGET_PATTERN}\\)`,
    "g",
  );
  const normalized = normalizeEmotionSquareBrackets(text).replace(mdLink, "$1");
  const spoken = options?.dropParens === false ? normalized : dropFishParenCues(normalized);
  return spoken.replace(square, (_full, inner: string) => `[${mapFishTagInner(inner)}]`);
}
