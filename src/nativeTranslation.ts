/**
 * Independent text translation engines for Bilingual Reader.
 * Implementations follow protocol conventions from
 * windingwind/zotero-pdf-translate (AGPL-3.0).
 */
import { getServiceSetting, assertServiceConfigured, isManagedService } from "./serviceCatalog";
import { getRequestTimeoutMs } from "./settings";
import { isBuiltInEngine, translateWithBuiltIn } from "./builtInTranslationServices";
import { translateSignedService } from "./signedTranslationServices";

type Headers = Record<string, string>;
function setting(id: string, field: string): string {
  return getServiceSetting(id, field);
}
function lang(code: string): string {
  return code.split("-")[0];
}
function requireParts(secret: string, count: number, label: string): string[] {
  const parts = secret.split("#");
  if (parts.length < count || parts.slice(0, count).some((part) => !part.trim())) {
    throw new Error(label + " 密钥格式不正确，请检查各项参数是否用 # 分隔。");
  }
  return parts;
}
function ensureText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " 未返回有效的正文译文，可能是授权失效或响应结构改变。");
  }
  return value.trim();
}
async function fetchTranslation(
  method: "POST" | "GET",
  url: string,
  data?: unknown,
  headers: Headers = {},
  responseType: "json" | "text" = "json",
): Promise<any> {
  try {
    const options: any = {
      headers,
      responseType,
      timeout: getRequestTimeoutMs(),
    };
    if (data !== undefined) options.body = typeof data === "string" ? data : JSON.stringify(data);
    const xhr = await Zotero.HTTP.request(method, url, options);
    if (xhr?.status !== 200) throw new Error("HTTP " + String(xhr?.status || "?"));
    if (typeof xhr.response === "string" && responseType === "json") {
      try { return JSON.parse(xhr.response); } catch (_) {
        throw new Error("响应不是有效 JSON。");
      }
    }
    return xhr.response;
  } catch (error: any) {
    // Never display URL bodies containing credential/query text or supplied PDF content.
    const status = String(error?.status || error?.message || "").match(/\b(401|403|404|408|413|429|500|502|503|504)\b/);
    throw new Error("翻译服务请求失败" + (status ? "（HTTP " + status[1] + "）" : "（网络或服务端错误）") + "。");
  }
}
function post(url: string, body: unknown, headers: Headers = {}): Promise<any> {
  return fetchTranslation("POST", url, body, { "Content-Type": "application/json", ...headers });
}
function promptFor(text: string, id: string): { system: string; user: string } {
  const system = setting(id, "prompt") ||
    "你是一名医学科研论文翻译助手。准确翻译成简体中文，保留基因、药物、剂量、单位、统计结果、引用和段落标记；仅输出译文。";
  return { system, user: text };
}
function deepLLang(code: string): string {
  if (code === "zh-CN") return "ZH-HANS";
  if (code === "zh-TW" || code === "zh-HK") return "ZH-HANT";
  return lang(code).toUpperCase();
}
function nllbLang(code: string): string {
  const map: Record<string, string> = {
    en: "eng_Latn", zh: "zho_Hans", fr: "fra_Latn", de: "deu_Latn",
    es: "spa_Latn", it: "ita_Latn", ja: "jpn_Jpan", ko: "kor_Hang",
    ru: "rus_Cyrl", pt: "por_Latn",
  };
  return map[lang(code)] || code;
}
function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}
async function memoryTranslate(text: string): Promise<string> {
  // Public MyMemory endpoint has an individual request length limit.
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 450) {
    const position = Math.max(200, remaining.lastIndexOf(" ", 440));
    chunks.push(remaining.slice(0, position));
    remaining = remaining.slice(position).trimStart();
  }
  if (remaining) chunks.push(remaining);
  const out: string[] = [];
  const email = setting("mymemory", "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("MyMemory 邮箱格式无效。");
  }
  for (const chunk of chunks) {
    const query = new URLSearchParams({ q: chunk, langpair: "en|zh-CN" });
    if (email) query.set("de", email);
    const response = await fetchTranslation(
      "GET", "https://api.mymemory.translated.net/get?" + query.toString(),
    );
    if (response?.responseStatus && Number(response.responseStatus) >= 400) {
      throw new Error("MyMemory 返回额度或访问错误。");
    }
    out.push(ensureText(response?.responseData?.translatedText, "MyMemory"));
  }
  return out.join(" ");
}

async function gptTranslate(text: string, id: string): Promise<string> {
  const url = setting(id, "endpoint");
  const isAzure = id === "azuregpt";
  const isResponses = /\/responses(?:\?|$)/.test(url);
  const prompt = promptFor(text, id);
  const messages = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const payload: any = isResponses
    ? { model: setting(id, "model"), input: messages, stream: false }
    : { model: setting(id, "model"), messages, stream: false };
  const headers = isAzure
    ? { "api-key": setting(id, "secret") }
    : { Authorization: "Bearer " + setting(id, "secret") };
  const response = await post(url, payload, headers);
  if (isResponses) {
    const parts = response?.output?.flatMap((output: any) => output.content || [])
      ?.filter((piece: any) => piece.type === "output_text")
      ?.map((piece: any) => piece.text);
    return ensureText(parts?.join(""), "Responses API");
  }
  return ensureText(response?.choices?.[0]?.message?.content, "OpenAI 兼容服务");
}

async function translateSingle(text: string, id: string): Promise<string> {
  const secret = setting(id, "secret");
  const q = encodeURIComponent(text);
  const fr = "en";
  const to = "zh-CN";
  switch (id) {
    case "youdao": {
      const body = new URLSearchParams({ from: fr, to: "zh-CHS", q: text }).toString();
      const res = await fetchTranslation("POST", "https://aidemo.youdao.com/trans", body,
        { "Content-Type": "application/x-www-form-urlencoded" });
      if (res.errorCode && String(res.errorCode) !== "0") throw new Error("有道接口返回错误代码。");
      return ensureText(res?.translation?.join("\n"), "有道翻译");
    }
    case "huoshanweb": {
      const res = await post("https://translate.volcengine.com/crx/translate/v1/", {
        source_language: fr, target_language: "zh", text,
      });
      return ensureText(res?.translation, "火山翻译");
    }
    case "tencenttransmart": {
      const res = await post("https://transmart.qq.com/api/imt", {
        header: {
          fn: "auto_translation",
          client_key: "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487",
        },
        type: "plain", model_category: "normal",
        source: { lang: fr, text_list: [text] }, target: { lang: "zh" },
      }, { referer: "https://transmart.qq.com/zh-CN/index" });
      return ensureText(res?.auto_translation?.join("\n"), "腾讯 Transmart");
    }
    case "mymemory": return memoryTranslate(text);
    case "deeplx": {
      const requestID = 1000 * (Math.floor(Math.random() * 99999) + 8300000) + 1;
      const res = await post(
        setting(id, "endpoint") + "?client=chrome-extension,1.28.0&method=LMT_handle_jobs",
        {
          jsonrpc: "2.0", method: "LMT_handle_texts", id: requestID,
          params: {
            texts: [{ text, requestAlternatives: 3 }],
            splitting: "newlines",
            lang: { source_lang_user_selected: "EN", target_lang: "ZH-HANS" },
            timestamp: Date.now(),
            commonJobParams: { wasSpoken: false, transcribe_as: "" },
          },
        },
      );
      return ensureText(res?.result?.texts?.[0]?.text, "DeepL 网页翻译");
    }
    case "baidu":
    case "baidufield": {
      const [appid, key, param] = requireParts(secret, id === "baidufield" ? 3 : 2, "百度");
      const salt = String(Date.now());
      const sign = Zotero.Utilities.Internal.md5(
        appid + text + salt + (id === "baidufield" ? param : "") + key, false,
      );
      const query = new URLSearchParams({
        q: text, appid, from: fr, to: "zh", salt, sign,
      });
      if (id === "baidufield") query.set("domain", param);
      else {
        query.set("action", param || "0");
        query.set("needIntervene", "1");
      }
      const action = id === "baidufield" ? "fieldtranslate" : "translate";
      const res = await fetchTranslation("GET",
        "https://api.fanyi.baidu.com/api/trans/vip/" + action + "?" + query.toString());
      if (res?.error_code) throw new Error("百度翻译服务错误代码：" + String(res.error_code));
      return ensureText(res?.trans_result?.map((r: any) => r.dst)?.join(""), "百度翻译");
    }
    case "caiyun": {
      const res = await post("https://api.interpreter.caiyunai.com/v1/translator", {
        source: [text], trans_type: "en2zh", request_id: Date.now(), detect: true,
      }, { "x-authorization": "token " + secret });
      return ensureText(res?.target?.[0], "彩云翻译");
    }
    case "deeplfree":
    case "deeplpro": {
      const url = id === "deeplfree"
        ? "https://api-free.deepl.com/v2/translate"
        : "https://api.deepl.com/v2/translate";
      const res = await post(url, {
        text: [text], source_lang: deepLLang("en"), target_lang: deepLLang("zh-CN"),
      }, { Authorization: "DeepL-Auth-Key " + secret.split("#")[0] });
      return ensureText(res?.translations?.[0]?.text, "DeepL");
    }
    case "microsoft": {
      const headers: Headers = { "Ocp-Apim-Subscription-Key": secret };
      const region = setting(id, "region");
      if (region && region !== "global") headers["Ocp-Apim-Subscription-Region"] = region;
      const res = await post(
        "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-CN",
        [{ Text: text }], headers);
      return ensureText(res?.[0]?.translations?.[0]?.text, "Microsoft Translator");
    }
    case "openai": case "customgpt1": case "customgpt2": case "customgpt3":
    case "azuregpt": return gptTranslate(text, id);
    case "gemini": {
      const url = setting(id, "endpoint").replace(/:(streamGenerateContent|generateContent).*$/, ":generateContent");
      const addQuery = url.includes("?") ? "&" : "?";
      const prompt = promptFor(text, id);
      const res = await post(url + addQuery + "key=" + encodeURIComponent(secret), {
        system_instruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      });
      const parts = res?.candidates?.[0]?.content?.parts || [];
      return ensureText(parts.filter((p: any) => !p.thought).map((p: any) => p.text).join(""), "Gemini");
    }
    case "claude": {
      const prompt = promptFor(text, id);
      const modelName = setting(id, "model");
      const res = await post(setting(id, "endpoint"), {
        model: modelName, system: prompt.system, messages: [{ role: "user", content: prompt.user }],
        max_tokens: 4096, stream: false,
      }, { "x-api-key": secret, "anthropic-version": "2023-06-01" });
      return ensureText(res?.content?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text).join(""), "Claude");
    }
    case "qwenmt": {
      const res = await post(setting(id, "endpoint"), {
        model: setting(id, "model"),
        messages: [{ role: "user", content: text }],
        translation_options: {
          source_lang: "auto", target_lang: "Chinese",
          domains: setting(id, "domains") || "",
        },
      }, { Authorization: "Bearer " + secret });
      return ensureText(res?.choices?.[0]?.message?.content, "Qwen-MT");
    }
    case "niutranspro": {
      const endpoint = setting(id, "endpoint");
      const isNeu = endpoint.includes("neu.edu.cn");
      const url = isNeu
        ? endpoint.replace(/\/+$/, "") + "/niutrans/textTranslation?apikey=" + encodeURIComponent(secret)
        : endpoint.replace(/\/+$/, "") + "/textTranslation?pluginType=zotero&apikey=" + encodeURIComponent(secret);
      const res = await post(url, {
        from: fr, to: "zh", src_text: text,
        ...(isNeu ? {} : {
          termDictionaryLibraryId: setting(id, "dictionary"),
          translationMemoryLibraryId: setting(id, "memory"),
          realmCode: 99, source: "zotero",
        }),
      });
      if (res?.code && Number(res.code) !== 200) throw new Error("小牛翻译返回非成功代码：" + res.code);
      return ensureText(isNeu
        ? res?.data?.[0]?.sentences?.map((s: any) => s.data).join("")
        : res?.data?.tgt_text, "小牛翻译");
    }
    case "openl": {
      const [services, apikey] = requireParts(secret, 2, "OpenL");
      const res = await post("https://api.openl.club/group/translate", {
        apikey, services: services.split(","), text, source_lang: fr, target_lang: "zh",
      });
      if (!res?.status) throw new Error("OpenL 翻译失败。");
      const results = Object.entries(res)
        .filter(([name, value]: [string, any]) => name !== "status" && value?.status)
        .map(([, value]: [string, any]) => value.result);
      return ensureText(results.join("\n"), "OpenL");
    }
    case "libretranslate": {
      const body: any = { q: text, source: fr, target: "zh", format: "text" };
      if (secret) body.api_key = secret;
      const res = await post(joinURL(setting(id, "endpoint"), "/translate"), body);
      return ensureText(res?.translatedText, "LibreTranslate");
    }
    case "mtranserver": {
      const res = await post(setting(id, "endpoint"), {
        text, from: fr, to: "zh",
      }, secret ? { authorization: secret } : {});
      return ensureText(res?.result, "MTranServer");
    }
    case "deeplcustom": {
      const res = await post(setting(id, "endpoint"), {
        text, source_lang: "EN", target_lang: "ZH",
      });
      return ensureText(res?.data || res?.translatedText, "DeepLX");
    }
    case "nllbserve": {
      const res = await post(joinURL(setting(id, "endpoint"), "/translate"), {
        source: text, src_lang: nllbLang("en"), tgt_lang: nllbLang("zh-CN"),
      });
      return ensureText(res?.translation?.[0], "NLLB Serve");
    }
    case "nllbapi": {
      const query = new URLSearchParams({
        text, source: nllbLang("en"), target: nllbLang("zh-CN"),
      });
      const res = await fetchTranslation("GET",
        joinURL(setting(id, "endpoint"), "/api/v4/translator") + "?" + query.toString());
      return ensureText(res?.result, "NLLB API");
    }
    default: return translateSignedService(text, id, fetchTranslation);
  }
}

/** This path never calls Zotero.PDFTranslate or accesses another add-on. */
export async function translateNativeParagraph(text: string, id: string): Promise<string> {
  if (!isManagedService(id)) throw new Error("未知的翻译引擎：" + id);
  if (!text.trim()) throw new Error("待翻译文本为空。");
  assertServiceConfigured(id);
  if (isBuiltInEngine(id)) return translateWithBuiltIn(text, id);
  return ensureText(await translateSingle(text, id), id);
}
