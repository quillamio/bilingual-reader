/**
 * Standalone, key-free translation adapters for Bilingual Reader.
 * Adapted from windingwind/zotero-pdf-translate
 *   src/modules/services/google.ts and bing.ts (AGPL-3.0).
 * Upstream: https://github.com/windingwind/zotero-pdf-translate
 *
 * These are unofficial public web endpoints, not official Google/Microsoft
 * paid APIs. They may rate-limit, change, or become unavailable.
 */
import { getRequestTimeoutMs } from "./settings";

export type BuiltInTranslationEngine = "google" | "googleapi" | "bing";

export function isBuiltInEngine(engine: string): engine is BuiltInTranslationEngine {
  return engine === "google" || engine === "googleapi" || engine === "bing";
}

function asJSON(value: unknown): any {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      throw new Error("翻译服务返回了非 JSON 响应。");
    }
  }
  return value;
}

export function parseGoogleTranslation(response: unknown): string {
  const chunks = asJSON(response)?.[0];
  if (!Array.isArray(chunks)) {
    throw new Error("Google 翻译返回格式不符合预期。");
  }
  const translated = chunks
    .filter((chunk: unknown) => Array.isArray(chunk) && typeof (chunk as any[])[0] === "string")
    .map((chunk: any[]) => chunk[0])
    .join("")
    .trim();
  if (!translated) throw new Error("Google 翻译未返回有效译文。");
  return translated;
}

export function parseBingTranslation(response: unknown): string {
  const translated = asJSON(response)?.[0]?.translations?.[0]?.text;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("Bing 翻译返回格式不符合预期。");
  }
  return translated.trim();
}

// The token algorithm is adapted from the Google service in Translate for Zotero.
// It operates on UTF-8 bytes rather than JavaScript UTF-16 code units.
function tokenMix(value: number, pattern: string): number {
  let result = value;
  for (let index = 0; index < pattern.length - 2; index += 3) {
    const shiftChar = pattern.charAt(index + 2);
    const shift =
      shiftChar >= "a" ? shiftChar.charCodeAt(0) - 87 : Number(shiftChar);
    const shifted =
      pattern.charAt(index + 1) === "+" ? result >>> shift : result << shift;
    result =
      pattern.charAt(index) === "+"
        ? (result + shifted) & 4294967295
        : result ^ shifted;
  }
  return result;
}

function googleToken(value: string): string {
  const seed = 406644;
  let token = seed;
  for (const byte of new TextEncoder().encode(value)) {
    token = tokenMix(token + byte, "+-a^+6");
  }
  token = tokenMix(token, "+-3^+b+-f");
  token ^= 3293161072;
  if (token < 0) token = (token & 2147483647) + 2147483648;
  token %= 1e6;
  return `${token}.${token ^ seed}`;
}

async function translateWithGoogle(
  text: string,
  engine: "google" | "googleapi",
): Promise<string> {
  const origin =
    engine === "google" ? "https://translate.google.com" : "https://translate.googleapis.com";
  const query = new URLSearchParams({
    client: "gtx",
    sl: "en",
    tl: "zh-CN",
    hl: "en",
    dt: "t",
    tk: googleToken(text),
    q: text,
  });
  try {
    const xhr = await Zotero.HTTP.request(
      "GET",
      `${origin}/translate_a/single?${query.toString()}`,
      { responseType: "json", timeout: getRequestTimeoutMs() },
    );
    if (xhr?.status !== 200) throw new Error(`HTTP ${xhr?.status || "unknown"}`);
    return parseGoogleTranslation(xhr.response);
  } catch (error) {
    if (/429|rate.limit|too many requests/iu.test(String(error))) {
      throw new Error("Google 翻译请求过于频繁（429）。请降低并发或延长请求间隔。");
    }
    throw error;
  }
}

async function translateWithBing(text: string): Promise<string> {
  const url =
    "https://edge.microsoft.com/translate/translatetext?from=en&to=zh-CN&isEnterpriseClient=false";
  const xhr = await Zotero.HTTP.request("POST", url, {
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
    },
    body: JSON.stringify([text]),
    responseType: "json",
    timeout: getRequestTimeoutMs(),
  });
  if (xhr?.status !== 200) throw new Error(`Bing 翻译请求失败：HTTP ${xhr?.status || "unknown"}`);
  return parseBingTranslation(xhr.response);
}

/** Requires no API key, but does require network access. */
export async function translateWithBuiltIn(
  text: string,
  engine: BuiltInTranslationEngine,
): Promise<string> {
  if (!text.trim()) throw new Error("翻译文本为空。");
  if (engine === "bing") return translateWithBing(text);
  return translateWithGoogle(text, engine);
}
