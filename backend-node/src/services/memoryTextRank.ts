/**
 * Shared text ranking primitives for memory recall.
 *
 * Kept in its own module so `memoryService` can rank facts without importing
 * `memorySearchService` (which imports `memoryPromptBlocks`, which imports
 * `memoryService` — importing it directly would create a runtime cycle).
 *
 * Tokenizer: CJK bigram + lowercase ASCII word, APP-identical.
 */

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cjkRun: number[] = [];
  let asciiRun = "";
  const flushAscii = () => {
    if (asciiRun) {
      out.push(asciiRun);
      asciiRun = "";
    }
  };
  const flushCjk = () => {
    if (cjkRun.length === 1) {
      out.push(String.fromCodePoint(cjkRun[0]));
    } else if (cjkRun.length > 1) {
      for (let index = 0; index + 1 < cjkRun.length; index += 1) {
        out.push(String.fromCodePoint(cjkRun[index], cjkRun[index + 1]));
      }
    }
    cjkRun = [];
  };
  for (const char of String(text || "")) {
    const cp = char.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      flushAscii();
      cjkRun.push(cp);
    } else if (cp < 0x2e80 && /\p{L}|\p{N}/u.test(char)) {
      flushCjk();
      asciiRun += char.toLowerCase();
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return out;
}

/** BM25 over pre-tokenized docs — exported for the recall test suite. */
export function bm25Scores(docs: string[], queryTokens: string[], k1: number, b: number): number[] {
  const n = docs.length;
  const scores = new Array<number>(n).fill(0);
  if (!n || !queryTokens.length) return scores;
  const docTokens: string[][] = [];
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const doc of docs) {
    const tokens = tokenize(doc);
    docTokens.push(tokens);
    totalLength += tokens.length;
    const seen = new Set(tokens);
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
  }
  const avgLength = totalLength / n;
  if (avgLength <= 0) return scores;
  for (let index = 0; index < n; index += 1) {
    const tf = new Map<string, number>();
    for (const token of docTokens[index]) tf.set(token, (tf.get(token) || 0) + 1);
    let score = 0;
    const length = docTokens[index].length;
    for (const token of queryTokens) {
      const freq = tf.get(token);
      if (!freq) continue;
      const tokenDf = df.get(token) || 0;
      const idf = Math.log(1 + (n - tokenDf + 0.5) / (tokenDf + 0.5));
      const norm = k1 * (1 - b + b * (length / avgLength));
      score += (idf * freq * (k1 + 1)) / (freq + norm);
    }
    scores[index] = score;
  }
  return scores;
}
