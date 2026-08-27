import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const SOURCE_URL =
  "https://raw.githubusercontent.com/yinyanfr/ecdict/main/assets/ecdict.csv";
const OUTPUT = path.resolve("src/generated/wordWiseDictionary.ts");

const EXAM_LEVEL = {
  cet6: 1,
  ky: 2,
  toefl: 3,
  ielts: 3,
  gre: 4,
};

const MEDICAL_SUFFIXES = [
  "algia",
  "ase",
  "ectomy",
  "emia",
  "genic",
  "itis",
  "oma",
  "opathy",
  "osis",
  "phagia",
  "phagy",
  "philia",
  "plasia",
  "plegia",
  "trophy",
  "uria",
];

const ACADEMIC_SUFFIXES = [
  "ation",
  "ition",
  "sion",
  "ment",
  "ence",
  "ance",
  "ity",
  "ive",
  "ical",
  "ology",
  "metric",
  "metry",
];

function download(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "bilingual-reader-wordwise-dictionary-builder",
          Accept: "text/csv,text/plain,*/*",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          void download(response.headers.location).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`ECDICT download failed: HTTP ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.setTimeout(120000, () => request.destroy(new Error("ECDICT download timeout")));
    request.on("error", reject);
  });
}

function parsePositiveInt(value) {
  const number = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function getFrequencyRank(bnc, frq) {
  const values = [parsePositiveInt(bnc), parsePositiveInt(frq)].filter(Boolean);
  return values.length ? Math.min(...values) : 0;
}

function getExamLevel(tagText) {
  const tags = String(tagText || "")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  let level = 0;
  for (const tag of tags) {
    const candidate = EXAM_LEVEL[tag];
    if (!candidate) continue;
    if (!level || candidate < level) level = candidate;
  }
  return level;
}

function detectDomain(word, translation) {
  const text = String(translation || "");
  if (/\[(?:医|药|医学|生物|生化|解剖|病理|遗传|免疫|生理|微生物)\]/u.test(text)) {
    return 1;
  }
  if (MEDICAL_SUFFIXES.some((suffix) => word.endsWith(suffix))) return 1;
  if (/\[(?:计|计算机)\]/u.test(text)) return 3;
  if (/\[(?:化|机|机械|电|电子|物|材料|工程|建|建筑)\]/u.test(text)) return 2;
  if (/\[(?:经|经济|法|法律|金融|会计|统计|心理|社会)\]/u.test(text)) return 4;
  return 0;
}

function cleanGloss(raw) {
  const lines = String(raw || "")
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[网络\]/u.test(line));
  if (!lines.length) return "";

  let value = lines[0]
    .replace(/\[[^\]]+\]\s*/gu, "")
    .replace(/^(?:n|v|vt|vi|adj|adv|a|prep|conj|pron|num|int)\.\s*/iu, "")
    .trim();
  value = value.split(/[；;。]/u)[0]?.trim() || value;
  if (value.length > 20 && value.includes("，")) {
    value = value.split("，")[0]?.trim() || value;
  }
  if (value.length > 22) value = `${value.slice(0, 22).trim()}…`;
  return value;
}

function shouldKeep(word, gloss, examLevel, domain, rank) {
  if (!gloss) return false;
  if (examLevel > 0 || domain > 0) return true;
  if (rank > 0 && rank <= 60000) return true;
  if (word.length >= 7 && ACADEMIC_SUFFIXES.some((suffix) => word.endsWith(suffix))) return true;
  return false;
}

function parseCsv(text, onRow) {
  let field = "";
  let row = [];
  let inQuotes = false;

  const emitField = () => {
    row.push(field);
    field = "";
  };
  const emitRow = () => {
    emitField();
    if (row.length) onRow(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      emitField();
    } else if (char === "\n") {
      emitRow();
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) emitRow();
}

function chooseBetter(existing, candidate) {
  if (!existing) return candidate;
  const existingScore =
    (existing[1] ? 3 : 0) + (existing[2] ? 3 : 0) + (existing[3] ? 1 : 0) - existing[0].length / 100;
  const candidateScore =
    (candidate[1] ? 3 : 0) + (candidate[2] ? 3 : 0) + (candidate[3] ? 1 : 0) - candidate[0].length / 100;
  return candidateScore > existingScore ? candidate : existing;
}

console.log("[Word Wise] downloading ECDICT...");
const csv = await download(SOURCE_URL);
console.log(`[Word Wise] downloaded ${(Buffer.byteLength(csv) / 1024 / 1024).toFixed(1)} MiB`);

const dictionary = Object.create(null);
let rows = 0;
let kept = 0;

parseCsv(csv, (row) => {
  rows += 1;
  if (rows === 1) return;
  const rawWord = String(row[0] || "").trim();
  if (!/^[A-Za-z][A-Za-z'-]{2,29}$/u.test(rawWord)) return;
  if (/^[A-Z]{2,}$/u.test(rawWord)) return;

  const word = rawWord.toLowerCase();
  const translation = String(row[3] || "");
  const gloss = cleanGloss(translation);
  const examLevel = getExamLevel(row[7]);
  const rank = getFrequencyRank(row[8], row[9]);
  const domain = detectDomain(word, translation);
  if (!shouldKeep(word, gloss, examLevel, domain, rank)) return;

  const entry = [gloss, examLevel, domain, rank];
  dictionary[word] = chooseBetter(dictionary[word], entry);
  kept += 1;
});

const sorted = Object.fromEntries(Object.entries(dictionary).sort(([a], [b]) => a.localeCompare(b)));
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
const source = `// Auto-generated from ECDICT during npm run build.\n// Source: ${SOURCE_URL}\n// Compact tuple: [Chinese gloss, exam level, domain, frequency rank]\n// exam: 0=untagged, 1=CET6, 2=Kaoyan, 3=TOEFL/IELTS, 4=GRE\n// domain: 0=general, 1=medicine/life science, 2=engineering, 3=computer, 4=social science\nexport type WordWiseDictionaryEntry = readonly [string, number, number, number];\nexport const WORDWISE_DICTIONARY: Readonly<Record<string, WordWiseDictionaryEntry>> = ${JSON.stringify(sorted)};\nexport const WORDWISE_DICTIONARY_SOURCE = "ECDICT";\n`;
fs.writeFileSync(OUTPUT, source, "utf8");

console.log(
  `[Word Wise] parsed ${rows.toLocaleString()} rows, kept ${Object.keys(sorted).length.toLocaleString()} unique entries (${kept.toLocaleString()} accepted rows)` ,
);
console.log(`[Word Wise] generated ${(Buffer.byteLength(source) / 1024 / 1024).toFixed(2)} MiB TS dictionary`);
