/**
 * Breeze Blue TTS reply protocol — Node port of the APP-side
 * `src/tts/breezeBlueTags.ts`.
 *
 * Two independent channels:
 * - `<emo>…` first line → natural-language performance instructions
 *   (sent as the separate `instructions` field; never spoken).
 * - Inline `[事件]` in the body → one of Breeze's 34 fixed audio events,
 *   kept exactly where the model wrote it.
 *
 * Anything else in `[]`, and every `（）` / `(...)` stage direction, is dropped.
 * Unmatched tag content must never be folded into `instructions`.
 */

/** Breeze docs: 34 shared audio events, Chinese exact spellings. */
export const BREEZE_AUDIO_EVENTS: ReadonlySet<string> = new Set([
  "笑", "轻笑", "咯咯笑",
  "哭声", "抽泣", "呜咽", "呻吟", "哀号",
  "叹气", "惊呼", "吸气", "呼气", "喘息",
  "耳语", "喊叫", "惨叫", "唱歌", "哼歌", "结巴", "停顿",
  "清嗓", "咳嗽", "吸鼻子",
  "咂嘴", "啧嘴",
  "打哈欠", "打喷嚏", "打嗝", "打饱嗝", "吞咽", "干呕",
  "闷哼", "冷笑", "哼鼻子",
]);

export const BREEZE_INSTRUCTION_MAX_CHARS = 1000;

export type BreezeParsedReply = {
  /** Empty when the model did not emit a leading `<emo>` line. */
  instruction: string;
  /** Body only: `<emo>` lines removed, invalid tags/parens dropped. */
  text: string;
};

const EMO_PREFIX = "<emo>";

function normalizeBrackets(text: string): string {
  return text
    .replace(/［/g, "[")
    .replace(/］/g, "]")
    .replace(/【/g, "[")
    .replace(/】/g, "]");
}

export function clampBreezeInstruction(raw: string): string {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const chars = Array.from(text);
  return chars.length <= BREEZE_INSTRUCTION_MAX_CHARS
    ? text
    : chars.slice(0, BREEZE_INSTRUCTION_MAX_CHARS).join("");
}

/** True when the tag (without brackets) is one of the 34 supported events. */
export function isBreezeAudioEvent(tag: string): boolean {
  return BREEZE_AUDIO_EVENTS.has((tag || "").trim());
}

/** Strip a leading `<emo>` line, plus any stray `<emo>` lines later in the text. */
export function stripBreezeEmotionLine(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*<emo>/i.test(line))
    .join("\n")
    .replace(/<emo>[\s\S]*?(?:<\/emo>|$)/gi, "");
}

/**
 * Remove stage directions. Depth-aware so nested `（…（…）…）` does not leave
 * a dangling half. Unclosed trailing parens are dropped too.
 */
function dropParenCues(text: string): string {
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
    while (cursor < text.length && depth > 0) {
      const current = text[cursor]!;
      if (current === "（" || current === "(") depth += 1;
      else if (current === "）" || current === ")") depth -= 1;
      cursor += 1;
    }
    out += " ";
    index = cursor;
  }
  return out;
}

/**
 * Keep only exact 34 audio events; drop unknown tags and their content.
 * Breeze would otherwise read `[委屈]` aloud as literal text.
 */
function filterInlineTags(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    if (open < 0) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, open);
    const close = text.indexOf("]", open + 1);
    if (close < 0) {
      // Unclosed tag: drop the rest rather than leaking `[半截`.
      break;
    }
    const inner = text.slice(open + 1, close).trim();
    if (BREEZE_AUDIO_EVENTS.has(inner)) {
      out += `[${inner}]`;
    }
    index = close + 1;
  }
  return out;
}

/** Full-segment cleanup: events kept in place, everything else removed. */
export function sanitizeBreezeText(text: string): string {
  if (!text) return "";
  let out = stripBreezeEmotionLine(normalizeBrackets(text));
  out = dropParenCues(out);
  out = filterInlineTags(out);
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/ *\n */g, "\n");
  out = out.replace(/\s+([，。！？；：,.!?;:])/g, "$1");
  return out.trim();
}

/**
 * Parse a complete model reply. `<emo>` must be the very first character of
 * the first line; a later `<emo>` line is treated as protocol noise and
 * removed from the body.
 */
export function parseBreezeReply(raw: string): BreezeParsedReply {
  const source = (raw || "").replace(/^\uFEFF/, "");
  if (!source) return { instruction: "", text: "" };
  if (!source.toLowerCase().startsWith(EMO_PREFIX)) {
    return { instruction: "", text: sanitizeBreezeText(source) };
  }
  const newline = source.indexOf("\n");
  const firstLine = newline >= 0 ? source.slice(0, newline) : source;
  const rest = newline >= 0 ? source.slice(newline + 1) : "";
  const inner = firstLine
    .slice(EMO_PREFIX.length)
    .replace(/<\/emo>\s*$/i, "")
    .trim();
  return {
    instruction: clampBreezeInstruction(inner),
    text: sanitizeBreezeText(rest),
  };
}

/**
 * Streaming gate for the `<emo>` instruction line. Buffers the reply head
 * until the first line can be resolved, then emits the body unchanged:
 * - chat display side: body goes to the UI / DB (the `<emo>` line never shows);
 * - voice-call TTS side: body goes into the sentence splitter (the line would
 *   otherwise be cut open by the weak-delimiter early-schedule and partially
 *   read aloud), and the captured instruction rides along per segment.
 */
export class BreezeEmoLineFilter {
  private head = "";
  private resolved = false;
  private instruction = "";

  /** Body text with the resolved `<emo>` line removed. */
  feed(delta: string): string {
    if (!delta) return "";
    if (this.resolved) return delta;
    this.head += delta;
    const newline = this.head.indexOf("\n");
    if (newline < 0) {
      // `<emo>` is contractually one short line; if the model rambles past
      // this, stop waiting and treat the whole thing as body.
      if (this.head.length > 160) {
        this.resolved = true;
        const out = this.head;
        this.head = "";
        return out;
      }
      return "";
    }
    this.resolved = true;
    const firstLine = this.head.slice(0, newline);
    const rest = this.head.slice(newline + 1);
    this.head = "";
    // Missing `<emo>` must not eat the first line of a normal reply.
    const hasEmo = firstLine.replace(/^\uFEFF/, "").trimStart().toLowerCase().startsWith(EMO_PREFIX);
    if (hasEmo) this.resolveHead(firstLine);
    return hasEmo ? rest : `${firstLine}\n${rest}`;
  }

  /** Flush the remaining head at stream end; safe to call once. */
  flush(): string {
    if (this.resolved) return "";
    this.resolved = true;
    const out = this.head;
    this.head = "";
    // An unclosed `<emo>` head is protocol noise, never display text.
    const hasEmo = out.replace(/^\uFEFF/, "").trimStart().toLowerCase().startsWith(EMO_PREFIX);
    if (hasEmo) this.resolveHead(out);
    return hasEmo ? "" : out;
  }

  /** The `<emo>` performance instruction, empty when the reply had none. */
  getInstruction(): string {
    return this.instruction;
  }

  isResolved(): boolean {
    return this.resolved;
  }

  private resolveHead(firstLine: string): void {
    const trimmed = firstLine.replace(/^\uFEFF/, "").trimStart();
    const inner = trimmed
      .slice(EMO_PREFIX.length)
      .replace(/<\/emo>\s*$/i, "")
      .trim();
    this.instruction = clampBreezeInstruction(inner);
  }
}
