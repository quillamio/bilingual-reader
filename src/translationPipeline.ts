export interface BatchInput {
  id: string;
  text: string;
}

const MARKER_PREFIX = "BRSEG";
const MARKER_WIDTH = 4;

function markerFor(index: number): string {
  return `[[${MARKER_PREFIX}_${String(index).padStart(MARKER_WIDTH, "0")}]]`;
}

export function hardSplitText(text: string, maxChars: number): string[] {
  const result: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let splitAt = Math.max(
      window.lastIndexOf(" "),
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
    );
    if (splitAt < Math.floor(maxChars * 0.55)) splitAt = maxChars;
    const chunk = rest.slice(0, splitAt).trim();
    if (chunk) result.push(chunk);
    rest = rest.slice(splitAt).trim();
  }
  if (rest) result.push(rest);
  return result;
}

export function splitTextForRequest(text: string, maxChars: number): string[] {
  const source = text.trim();
  if (source.length <= maxChars) return [source];

  const sentences = source.match(/[^.!?。！？；;]+(?:[.!?。！？；;]+|$)/gu) || [source];
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardSplitText(sentence, maxChars));
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      flush();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length ? chunks : hardSplitText(source, maxChars);
}

export function buildBatchPayload(items: BatchInput[]): string {
  return items.map((item, index) => `${markerFor(index)}\n${item.text.trim()}`).join("\n\n");
}

/**
 * Parse a translated batch only when every marker survived unchanged and every
 * segment has a non-empty result. A strict failure lets the caller safely fall
 * back to individual requests instead of displaying misaligned translations.
 */
export function parseBatchResult(result: string, expectedCount: number): string[] | null {
  if (expectedCount < 1) return [];

  const markerPattern = /\[\[\s*BRSEG[_\s-]*(\d{4})\s*\]\]/giu;
  const matches = Array.from(result.matchAll(markerPattern));
  if (matches.length !== expectedCount) return null;
  if (result.slice(0, matches[0].index).trim()) return null;

  const translations: string[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (Number(match[1]) !== index || match.index === undefined) return null;

    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? result.length;
    const translation = result.slice(start, end).trim();
    if (!translation) return null;
    translations.push(translation);
  }
  return translations;
}

/**
 * Pack adjacent items without exceeding either the service character limit or
 * the configured paragraph count. Oversized items remain single-item batches
 * and are split sentence-by-sentence by the caller.
 */
export function packBatchItems<T extends BatchInput>(
  items: T[],
  maxChars: number,
  maxItems: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];

  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
  };

  for (const item of items) {
    const candidate = [...current, item];
    if (
      current.length &&
      (candidate.length > Math.max(1, maxItems) || buildBatchPayload(candidate).length > maxChars)
    ) {
      flush();
    }

    current.push(item);
    if (current.length >= Math.max(1, maxItems) || buildBatchPayload(current).length > maxChars) {
      flush();
    }
  }

  flush();
  return batches;
}
