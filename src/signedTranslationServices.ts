/**
 * Signed API adapters adapted from windingwind/zotero-pdf-translate
 * (AGPL-3.0): aliyun, tencent, huoshan, xftrans, youdaozhiyun.
 * Signing logic and parameter order must be kept in sync with providers.
 */
import { getServiceSetting } from "./serviceCatalog";

type Headers = Record<string, string>;
type Fetcher = (
  method: "GET" | "POST", url: string, data?: unknown, headers?: Headers,
  responseType?: "json" | "text",
) => Promise<any>;

const enc = new TextEncoder();
function setting(id: string, name: string): string {
  return getServiceSetting(id, name);
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function toBase64(buffer: ArrayBuffer): string {
  const chars = Array.from(new Uint8Array(buffer)).map((byte) => String.fromCharCode(byte)).join("");
  return Zotero.getMainWindow().btoa(chars);
}
async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(value));
}
async function sign(value: string, secret: string | ArrayBuffer, algorithm: "SHA-1" | "SHA-256"): Promise<ArrayBuffer> {
  const raw = typeof secret === "string" ? enc.encode(secret) : secret;
  const key = await crypto.subtle.importKey(
    "raw", raw, { name: "HMAC", hash: algorithm }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(value));
}
function parts(value: string, count: number, label: string): string[] {
  const arr = value.split("#");
  if (arr.length < count || arr.slice(0, count).some((part) => !part.trim())) {
    throw new Error(label + " 的密钥格式不正确。");
  }
  return arr;
}
function textResult(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(label + " 未返回有效译文。");
  }
  return value.trim();
}
function rfc(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
}
function youdaoTruncate(value: string): string {
  return value.length <= 20
    ? value : value.slice(0, 10) + String(value.length) + value.slice(-10);
}
function isYoudaoError(value: any): boolean {
  return value?.errorCode && String(value.errorCode) !== "0";
}
async function aliyun(text: string, fetch: Fetcher): Promise<string> {
  const id = "aliyun";
  const [accessId, accessSecret] = parts(setting(id, "secret"), 2, "阿里云");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((n) => n.toString(16).padStart(2, "0")).join("");
  const query: Record<string, string> = {
    AccessKeyId: accessId,
    Action: setting(id, "action"),
    Format: "JSON",
    FormatType: "text",
    Scene: setting(id, "scene"),
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: nonce,
    SignatureVersion: "1.0",
    SourceLanguage: "auto",
    SourceText: text,
    TargetLanguage: "zh",
    Timestamp: new Date().toISOString(),
    Version: "2018-10-12",
  };
  const canonical = Object.keys(query).sort()
    .map((name) => rfc(name) + "=" + rfc(query[name])).join("&");
  const signature = toBase64(await sign("POST&%2F&" + rfc(canonical), accessSecret + "&", "SHA-1"));
  const response = await fetch("POST", setting(id, "endpoint"),
    canonical + "&Signature=" + rfc(signature),
    { "Content-Type": "application/x-www-form-urlencoded" });
  if (response?.Code && String(response.Code) !== "200") throw new Error("阿里云返回错误代码：" + response.Code);
  return textResult(response?.Data?.Translated, "阿里云");
}
async function tencent(text: string, fetch: Fetcher): Promise<string> {
  const id = "tencent";
  const [secretId, secretKey] = parts(setting(id, "secret"), 2, "腾讯云");
  const params: Record<string, string> = {
    Action: "TextTranslate", Language: "zh-CN", Nonce: String(Math.floor(Math.random() * 1000000)),
    ProjectId: setting(id, "projectId"), Region: setting(id, "region"),
    SecretId: secretId, Source: "en", SourceText: text, Target: "zh",
    Timestamp: String(Math.floor(Date.now() / 1000)), Version: "2018-03-21",
  };
  const raw = Object.keys(params).sort().map((name) => name + "=" + params[name]).join("&");
  const signature = toBase64(await sign(
    "POSTtmt.tencentcloudapi.com/?" + raw, secretKey, "SHA-1",
  ));
  const form = Object.keys(params).sort()
    .map((name) => name + "=" + encodeURIComponent(params[name]).replace(/%20/g, "+")).join("&");
  const res = await fetch("POST", "https://tmt.tencentcloudapi.com",
    form + "&Signature=" + encodeURIComponent(signature),
    { "Content-Type": "application/x-www-form-urlencoded" });
  if (res?.Response?.Error) throw new Error("腾讯云错误：" + res.Response.Error.Code);
  return textResult(res?.Response?.TargetText, "腾讯云");
}
function canonicalHeaders(headers: Headers): string {
  return Object.keys(headers).sort()
    .map((name) => name.toLowerCase() + ":" + headers[name] + "\n").join("");
}
function signedHeaders(headers: Headers): string {
  return Object.keys(headers).sort().map((name) => name.toLowerCase()).join(";");
}
async function huoshan(text: string, fetch: Fetcher): Promise<string> {
  const [ak, sk] = parts(setting("huoshan", "secret"), 2, "火山引擎");
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const region = "cn-north-1";
  const service = "translate";
  const requestBody = JSON.stringify({ TargetLanguage: "zh", TextList: [text] });
  const hashBody = toHex(await sha256(requestBody));
  const headers: Headers = {
    "Content-Type": "application/json", "X-Date": date, "X-Content-Sha256": hashBody,
  };
  const signed = signedHeaders(headers);
  const canonical = [
    "POST", "/", "Action=TranslateText&Version=2020-06-01",
    canonicalHeaders(headers), signed, hashBody,
  ].join("\n");
  const hashedCanonical = toHex(await sha256(canonical));
  const scope = date + "/" + region + "/" + service + "/request";
  const stringToSign = ["HMAC-SHA256", date, scope, hashedCanonical].join("\n");
  const dateKey = await sign(date, sk, "SHA-256");
  const regionKey = await sign(region, dateKey, "SHA-256");
  const serviceKey = await sign(service, regionKey, "SHA-256");
  const signingKey = await sign("request", serviceKey, "SHA-256");
  const signature = toHex(await sign(stringToSign, signingKey, "SHA-256"));
  headers.Authorization = "HMAC-SHA256 Credential=" + ak + "/" + scope +
    ", SignedHeaders=" + signed + ", Signature=" + signature;
  const res = await fetch("POST",
    "https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01",
    requestBody, headers);
  return textResult(res?.TranslationList?.[0]?.Translation, "火山引擎");
}
async function xftrans(text: string, fetch: Fetcher): Promise<string> {
  const id = "xftrans";
  const [appid, apiSecret, apiKey] = parts(setting(id, "secret"), 3, "讯飞");
  const mode = setting(id, "mode");
  const host = mode === "ots" ? "ntrans.xfyun.cn" : "itrans.xfyun.cn";
  const uri = mode === "ots" ? "/v2/ots" : "/v2/its";
  const body = JSON.stringify({
    common: { app_id: appid },
    business: { from: "en", to: "cn" },
    data: { text: toBase64(enc.encode(text).buffer as ArrayBuffer) },
  });
  const date = new Date().toUTCString();
  const digest = "SHA-256=" + toBase64(await sha256(body));
  const signatureSource = "host: " + host + "\ndate: " + date +
    "\nPOST " + uri + " HTTP/1.1\ndigest: " + digest;
  const signature = toBase64(await sign(signatureSource, apiSecret, "SHA-256"));
  const authorization = 'api_key="' + apiKey +
    '", algorithm="hmac-sha256", headers="host date request-line digest", signature="' +
    signature + '"';
  const res = await fetch("POST", "https://" + host + uri, body, {
    "Content-Type": "application/json", Accept: "application/json,version=1.0",
    Host: host, Date: date, Digest: digest, Authorization: authorization,
  });
  return textResult(res?.data?.result?.trans_result?.dst, "讯飞");
}
async function youdaoSigned(text: string, id: string, fetch: Fetcher): Promise<string> {
  const [appid, key, vocabId] = parts(setting(id, "secret"), 2, "有道智云");
  const salt = String(Date.now());
  const current = String(Math.floor(Date.now() / 1000));
  const signature = toHex(await sha256(appid + youdaoTruncate(text) + salt + current + key));
  const isLLM = id === "youdaozhiyunllm";
  const query = new URLSearchParams({
    [isLLM ? "i" : "q"]: text,
    appKey: appid, salt, from: "en", to: "zh-CHS",
    sign: signature, signType: "v3", curtime: current,
  });
  if (isLLM) {
    query.set("streamType", "full");
    query.set("handleOption", "0");
    query.set("prompt", setting(id, "domain"));
    const res = await fetch("POST", "https://openapi.youdao.com/llm_trans?" + query.toString(),
      "", { "Content-Type": "application/x-www-form-urlencoded" }, "text");
    if (typeof res !== "string") throw new Error("有道大模型接口响应格式变化。");
    const events = res.split(/\n\n+/);
    const payload = events.filter((e) => e.includes("event:message")).flatMap((entry) => {
      const raw = entry.split("\n").find((line) => line.startsWith("data:"));
      if (!raw) return [];
      try { return [JSON.parse(raw.slice(5).trim()).transFull || ""]; } catch (_) { return []; }
    });
    return textResult(payload.join(""), "有道智云大模型");
  }
  if (vocabId) query.set("vocabId", vocabId);
  query.set("domain", setting(id, "domain"));
  const res = await fetch("GET", "https://openapi.youdao.com/api?" + query.toString());
  if (isYoudaoError(res)) throw new Error("有道智云返回错误代码：" + res.errorCode);
  return textResult(res?.translation?.join(""), "有道智云");
}

export async function translateSignedService(
  text: string, id: string, fetch: Fetcher,
): Promise<string> {
  switch (id) {
    case "aliyun": return aliyun(text, fetch);
    case "tencent": return tencent(text, fetch);
    case "huoshan": return huoshan(text, fetch);
    case "xftrans": return xftrans(text, fetch);
    case "youdaozhiyun": case "youdaozhiyunllm": return youdaoSigned(text, id, fetch);
    default: throw new Error("当前翻译服务尚未实现：" + id);
  }
}
