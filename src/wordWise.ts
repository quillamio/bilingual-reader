import {
  getEngine,
  getOllamaModel,
  getOllamaURL,
  getPDFTranslateService,
  getRequestGapMs,
  getRequestTimeoutMs,
  getWordWiseColor,
  getWordWisePosition,
} from "./settings";
import { buildBatchPayload, parseBatchResult, type BatchInput } from "./translationPipeline";

const PLUGIN_ID = "bilingual-reader@zotero.local";
const TOOLBAR_BUTTON_CLASS = "bilingual-reader-wordwise-button";
const WORDWISE_CLASS = "bilingual-reader-wordwise";
const STYLE_ID = "bilingual-reader-wordwise-style";
const SLOT_EMOJI = "🎰";
const MAX_HINT_TERMS = 48;
const BATCH_SIZE = 8;

const COMMON_WORDS = new Set(
  `a about above after again against all almost along already also although always am among an and another any anybody anyone anything are around as at away back be became because become becomes been before began begin behind being below between both but by can cannot could did different do does doing done down during each either else enough especially even ever every everybody everyone everything few first for found from further get gets getting give given gives go goes going gone good got great had has have having he her here hers herself him himself his how however i if in into is it its itself just keep kept kind know known knows large last later least less let like likely little long made make makes many may maybe me mean means might more most much must my myself near need needed needs neither never new next no nobody none nor not nothing now of off often on once one only onto or other others our ours ourselves out over own perhaps quite rather really right said same say says second see seem seemed seems several she should since small so some somebody someone something still such take taken takes than that the their theirs them themselves then there therefore these they thing things think this those though through thus to together too toward under until up upon us use used using very want was way we well were what whatever when whenever where whether which while who whoever whom whose why will with within without would yet you your yours yourself yourselves able across actually addition added additional age ago allow allows amount appear appears area areas available based beginning better beyond body bring brought build case cases change changed changes clear clearly close common compared complete completely consider considered considering contain contains continue continued current currently day days decrease decreased define defined depending despite develop developed development due early end establish established event events evidence example examples existing expect expected explain following full generally greater group groups happen happened help high higher human important include included includes including increase increased individual individuals information instead interest involved largely lead leading low lower main major measured model models number numbers order original overall part parts particularly patient patients people percent performed period point possible present previous primary probably provide provided provides rather related remain reported required research result results show showed shown significant significantly similar specific study studies studied suggest suggested support supported system systems three time times total two useful value values various year years according account affect affected association associated baseline clinical condition conditions control controls data difference differences disease diseases effect effects estimated evaluation evidence factors figure figures finding findings function functions gene genes health identify identified intervention method methods outcome outcomes participants population protein proteins risk risks sample samples score scores table tables treatment treatments variable variables`.split(/\s+/u),
);

const TECHNICAL_SUFFIXES = [
  "ation",
  "ition",
  "ology",
  "opathy",
  "emia",
  "osis",
  "genic",
  "ase",
  "itis",
  "ectomy",
  "phagy",
  "philia",
  "phobia",
  "metric",
  "metry",
  "tropic",
  "trophy",
  "tion",
  "sion",
  "ment",
  "ence",
  "ance",
  "ity",
  "ive",
  "ical",
  "ous",
];

interface CandidateInfo {
  word: string;
  count: number;
  score: number;
}

export interface WordWiseToggleResult {
  enabled: boolean;
  annotations: number;
  uniqueTerms: number;
}

const glossCache = new Map<string, string>();

function getInternalReader(reader: any): any {
  return reader?._internalReader || reader;
}

function getActiveSDTView(reader: any): any {
  const internal = getInternalReader(reader);
  if (!internal) return null;
  const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
  return primary ? internal._primarySDTView : internal._secondarySDTView;
}

function getSDTDocument(reader: any): Document | null {
  try {
    const view = getActiveSDTView(reader);
    return view?._iframeDocument || view?._iframe?.contentDocument || null;
  } catch (_) {
    return null;
  }
}

function shouldSkipElement(element: Element | null): boolean {
  if (!element) return true;
  return Boolean(
    element.closest(
      `.${WORDWISE_CLASS}, .bilingual-reader-translation, script, style, textarea, input, select, button, code, pre, math, svg`,
    ),
  );
}

function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/^[-']+|[-']+$/gu, "");
}

function isCommonOrInflection(word: string): boolean {
  if (COMMON_WORDS.has(word)) return true;

  const stems = new Set<string>();
  if (word.endsWith("ies") && word.length > 5) stems.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("es") && word.length > 5) stems.add(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 5) stems.add(word.slice(0, -1));
  if (word.endsWith("ied") && word.length > 6) stems.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed") && word.length > 5) {
    stems.add(word.slice(0, -2));
    stems.add(word.slice(0, -1));
  }
  if (word.endsWith("ing") && word.length > 7) {
    stems.add(word.slice(0, -3));
    stems.add(`${word.slice(0, -3)}e`);
  }
  if (word.endsWith("ly") && word.length > 6) stems.add(word.slice(0, -2));
  if (word.endsWith("er") && word.length > 6) stems.add(word.slice(0, -2));
  if (word.endsWith("est") && word.length > 7) stems.add(word.slice(0, -3));

  return Array.from(stems).some((stem) => COMMON_WORDS.has(stem));
}

function candidateScore(word: string, count: number): number {
  let score = Math.min(12, word.length);
  if (word.length >= 10) score += 3;
  if (TECHNICAL_SUFFIXES.some((suffix) => word.endsWith(suffix))) score += 4;
  if (count > 1) score += Math.min(4, count - 1);
  return score;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const doc = root.ownerDocument;
  if (!doc) return [];

  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(root, 4, {
    acceptNode(node) {
      const text = node as Text;
      if (!text.nodeValue?.trim()) return 2;
      if (shouldSkipElement(text.parentElement)) return 2;
      return 1;
    },
  });

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function collectCandidates(nodes: Text[]): CandidateInfo[] {
  const counts = new Map<string, number>();
  const pattern = /\b[A-Za-z][A-Za-z'-]{5,}\b/gu;

  for (const node of nodes) {
    const text = node.nodeValue || "";
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      if (raw.length > 30 || /^[A-Z]{2,}$/u.test(raw)) continue;
      const word = normalizeWord(raw);
      if (!word || isCommonOrInflection(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count, score: candidateScore(word, count) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, MAX_HINT_TERMS);
}

function engineCachePrefix(): string {
  const engine = getEngine();
  if (engine === "ollama") return `ollama:${getOllamaURL()}:${getOllamaModel()}`;
  return `pdftranslate:${getPDFTranslateService() || "default"}`;
}

function cleanGloss(word: string, value: string): string {
  let result = value
    .replace(/\[\[\s*BRSEG[_\s-]*\d{4}\s*\]\]/giu, "")
    .replace(/^[-–—•\s]+/u, "")
    .trim();
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  result = result.replace(new RegExp(`^${escaped}\\s*[:：-]?\\s*`, "iu"), "").trim();
  result = result.split(/\r?\n/u)[0]?.trim() || "";
  result = result.split(/[；;。]/u)[0]?.trim() || result;
  result = result.replace(/^['"“”‘’]+|['"“”‘’]+$/gu, "").trim();
  if (result.length > 18) result = `${result.slice(0, 18).trim()}…`;
  return result;
}

async function translateWithPDFTranslate(payload: string, itemID: number): Promise<string> {
  const api = (Zotero as any).PDFTranslate?.api;
  if (!api?.translate) {
    throw new Error("未检测到 Translate for Zotero，无法生成生词释义。");
  }

  const options: Record<string, any> = {
    pluginID: PLUGIN_ID,
    itemID,
    langto: "zh-CN",
  };
  const service = getPDFTranslateService();
  if (service) options.service = service;

  const task = await api.translate(payload, options);
  const result = String(task?.result || "").trim();
  if (task?.status && task.status !== "success") {
    throw new Error(result || "Translate for Zotero 生词释义请求失败。");
  }
  if (!result) throw new Error("Translate for Zotero 未返回生词释义。");
  return result;
}

async function translateWithOllama(payload: string): Promise<string> {
  const xhr = await Zotero.HTTP.request("POST", `${getOllamaURL()}/api/chat`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getOllamaModel(),
      stream: false,
      keep_alive: "30m",
      messages: [
        {
          role: "system",
          content:
            "你是英汉词典助手。把每个英文单词翻译成最简短、最常用的简体中文词义，只给词义，不解释。如果输入含 [[BRSEG_0000]] 这类标记，必须逐字原样保留每个标记和顺序。",
        },
        { role: "user", content: payload },
      ],
      options: { temperature: 0 },
    }),
    responseType: "json",
    timeout: getRequestTimeoutMs(),
  });

  if (!xhr || xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Ollama 生词释义请求失败：HTTP ${xhr?.status || "unknown"}`);
  }

  let response: any = xhr.response;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch (_) {
      // Validation below reports malformed replies.
    }
  }
  const result = String(response?.message?.content || "").trim();
  if (!result) throw new Error("Ollama 未返回生词释义。");
  return result;
}

async function translatePayload(payload: string, itemID: number): Promise<string> {
  return getEngine() === "ollama"
    ? translateWithOllama(payload)
    : translateWithPDFTranslate(payload, itemID);
}

async function translateWordBatch(words: string[], itemID: number): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const prefix = engineCachePrefix();
  const missing = words.filter((word) => {
    const cached = glossCache.get(`${prefix}:${word}`);
    if (cached) result.set(word, cached);
    return !cached;
  });
  if (!missing.length) return result;

  const inputs: BatchInput[] = missing.map((word) => ({ id: word, text: word }));
  const payload = buildBatchPayload(inputs);

  try {
    const translated = await translatePayload(payload, itemID);
    const parsed = parseBatchResult(translated, missing.length);
    if (parsed) {
      parsed.forEach((value, index) => {
        const word = missing[index];
        const gloss = cleanGloss(word, value);
        if (!gloss) return;
        glossCache.set(`${prefix}:${word}`, gloss);
        result.set(word, gloss);
      });
      return result;
    }
  } catch (error) {
    Zotero.logError(error as Error);
  }

  for (const word of missing) {
    try {
      const translated = await translatePayload(word, itemID);
      const gloss = cleanGloss(word, translated);
      if (!gloss) continue;
      glossCache.set(`${prefix}:${word}`, gloss);
      result.set(word, gloss);
      const gap = Math.max(0, Math.min(500, getRequestGapMs()));
      if (gap) await Zotero.Promise.delay(gap);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
  return result;
}

async function resolveGlosses(words: string[], itemID: number): Promise<Map<string, string>> {
  const all = new Map<string, string>();
  for (let start = 0; start < words.length; start += BATCH_SIZE) {
    const batch = words.slice(start, start + BATCH_SIZE);
    const batchResult = await translateWordBatch(batch, itemID);
    for (const [word, gloss] of batchResult) all.set(word, gloss);
    if (start + BATCH_SIZE < words.length) {
      const gap = Math.max(100, Math.min(1000, getRequestGapMs()));
      await Zotero.Promise.delay(gap);
    }
  }
  return all;
}

function ensureWordWiseStyle(doc: Document): void {
  const color = getWordWiseColor();
  const position = getWordWisePosition();
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head?.appendChild(style);
  }
  style.textContent = `
    ruby.${WORDWISE_CLASS} {
      ruby-position: ${position};
      ruby-align: center;
      margin: 0 0.04em;
    }
    ruby.${WORDWISE_CLASS} rb {
      color: ${color} !important;
      font-weight: 600 !important;
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: ${color};
      text-underline-offset: 0.12em;
    }
    ruby.${WORDWISE_CLASS} rt {
      color: ${color} !important;
      font-size: 0.60em !important;
      font-weight: 500 !important;
      line-height: 1.05 !important;
      letter-spacing: 0 !important;
      white-space: nowrap;
    }
  `;
}

function annotateTextNode(node: Text, glosses: Map<string, string>): number {
  const doc = node.ownerDocument;
  if (!doc) return 0;

  const text = node.nodeValue || "";
  const pattern = /\b[A-Za-z][A-Za-z'-]{5,}\b/gu;
  let lastIndex = 0;
  let annotations = 0;
  const fragment = doc.createDocumentFragment();

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    const word = normalizeWord(raw);
    const gloss = glosses.get(word);
    if (!gloss) continue;

    if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));

    const ruby = doc.createElement("ruby");
    ruby.className = WORDWISE_CLASS;
    ruby.dataset.original = raw;
    ruby.dataset.word = word;

    const rb = doc.createElement("rb");
    rb.textContent = raw;
    const rt = doc.createElement("rt");
    rt.textContent = gloss;
    ruby.append(rb, rt);
    fragment.append(ruby);

    lastIndex = match.index + raw.length;
    annotations += 1;
  }

  if (!annotations) return 0;
  if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
  node.replaceWith(fragment);
  return annotations;
}

export function removeWordWiseHints(reader: any): number {
  const doc = getSDTDocument(reader);
  if (!doc) return 0;
  const hints = Array.from(doc.querySelectorAll(`ruby.${WORDWISE_CLASS}`)) as HTMLElement[];
  for (const hint of hints) {
    const original = hint.dataset.original || hint.querySelector("rb")?.textContent || "";
    hint.replaceWith(doc.createTextNode(original));
  }
  doc.getElementById(STYLE_ID)?.remove();
  doc.querySelector("#sdt-content")?.normalize();
  return hints.length;
}

export function hasWordWiseHints(reader: any): boolean {
  return Boolean(getSDTDocument(reader)?.querySelector(`ruby.${WORDWISE_CLASS}`));
}

export async function toggleWordWiseHints(reader: any): Promise<WordWiseToggleResult> {
  if (hasWordWiseHints(reader)) {
    const removed = removeWordWiseHints(reader);
    return { enabled: false, annotations: removed, uniqueTerms: 0 };
  }

  const doc = getSDTDocument(reader);
  const root = doc?.querySelector("#sdt-content") as HTMLElement | null;
  if (!doc || !root) {
    throw new Error("请先进入 Zotero 10 阅读模式并等待结构化正文生成，再点击 🎰。");
  }

  const itemID = Number(reader?.itemID || 0);
  if (!itemID) throw new Error("无法取得当前 PDF 的 Zotero 条目编号。");

  const nodes = collectTextNodes(root);
  const candidates = collectCandidates(nodes);
  if (!candidates.length) {
    throw new Error("当前页面没有识别到需要提示的英文生词。");
  }

  const glosses = await resolveGlosses(
    candidates.map((candidate) => candidate.word),
    itemID,
  );
  if (!glosses.size) {
    throw new Error("没有取得可用的生词释义，请检查当前翻译后端或翻译服务。");
  }

  ensureWordWiseStyle(doc);
  let annotations = 0;
  for (const node of nodes) {
    if (!node.isConnected || shouldSkipElement(node.parentElement)) continue;
    annotations += annotateTextNode(node, glosses);
  }

  return { enabled: true, annotations, uniqueTerms: glosses.size };
}

function showMessage(reader: any, message: string): void {
  let win: any = null;
  try {
    win = reader?._iframeWindow || Zotero.getMainWindow();
  } catch (_) {
    win = Zotero.getMainWindow();
  }
  if (win?.alert) win.alert(message);
  else Zotero.logError(new Error(message));
}

function applyEmojiButtonStyle(button: HTMLButtonElement): void {
  button.style.minWidth = "34px";
  button.style.paddingInline = "5px";
  button.style.fontSize = "19px";
  button.style.lineHeight = "1";
  button.style.fontFamily =
    '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
}

function renderWordWiseButton(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;
  if (doc.querySelector(`.${TOOLBAR_BUTTON_CLASS}`)) return;

  const button = doc.createElement("button") as HTMLButtonElement;
  button.className = `toolbar-button ${TOOLBAR_BUTTON_CLASS}`;
  button.type = "button";
  button.tabIndex = -1;
  button.textContent = SLOT_EMOJI;
  button.title = "生词提示：点击显示/隐藏英文难词的简短中文释义";
  button.setAttribute("aria-label", button.title);
  applyEmojiButtonStyle(button);

  button.addEventListener("click", (eventObject: Event) => {
    eventObject.preventDefault();
    eventObject.stopPropagation();
    if (button.disabled) return;

    button.disabled = true;
    button.textContent = "⏳";
    void toggleWordWiseHints(reader)
      .then((result) => {
        button.title = result.enabled
          ? `已显示 ${result.annotations} 处生词提示（${result.uniqueTerms} 个词）；再次点击隐藏`
          : "生词提示：点击显示/隐藏英文难词的简短中文释义";
        button.setAttribute("aria-label", button.title);
      })
      .catch((error: any) => {
        Zotero.logError(error as Error);
        showMessage(reader, `生词提示失败：${error?.message || String(error)}`);
      })
      .finally(() => {
        button.textContent = SLOT_EMOJI;
        button.disabled = false;
      });
  });

  append(button);
}

function cleanupReader(reader: any): void {
  try {
    reader?._iframeWindow?.document?.querySelector(`.${TOOLBAR_BUTTON_CLASS}`)?.remove();
  } catch (_) {
    // Reader may already be destroyed.
  }
  removeWordWiseHints(reader);
}

export function registerWordWise(): void {
  Zotero.Reader.registerEventListener("renderToolbar", renderWordWiseButton, PLUGIN_ID);
}

export function unregisterWordWise(): void {
  Zotero.Reader.unregisterEventListener("renderToolbar", renderWordWiseButton);
  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) cleanupReader(reader);
}
