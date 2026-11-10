/**
 * Native translation service registry. Adapted from windingwind/zotero-pdf-translate
 * (AGPL-3.0). Does not require the other Zotero plugin to be installed.
 */
export interface ServiceField {
  key: string;
  label: string;
  type?: "password" | "url" | "text" | "select";
  defaultValue?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}
export interface ServiceDefinition {
  id: string;
  label: string;
  group: "free" | "api" | "local";
  fields: ServiceField[];
  help?: string;
}
const key = (label = "API Key / 密钥"): ServiceField => ({
  key: "secret", label, type: "password", required: true,
});
const endpoint = (defaultValue: string, required = false): ServiceField => ({
  key: "endpoint", label: "服务地址", type: "url", defaultValue, required,
});
const model = (defaultValue: string): ServiceField => ({
  key: "model", label: "模型名称", defaultValue,
});
const prompt: ServiceField = { key: "prompt", label: "自定义系统提示词（可选）" };
const gptFields = () => [key(), endpoint("https://api.openai.com/v1/chat/completions"), model("gpt-4.1-mini"), prompt];
export const SERVICE_CATALOG: readonly ServiceDefinition[] = [
  { id: "google", label: "Google 翻译（默认）", group: "free", fields: [] },
  { id: "googleapi", label: "Google 翻译（备用）", group: "free", fields: [] },
  { id: "bing", label: "Bing 翻译（网页）", group: "free", fields: [] },
  { id: "youdao", label: "有道翻译（网页）", group: "free", fields: [] },
  { id: "huoshanweb", label: "火山翻译（网页）", group: "free", fields: [] },
  { id: "tencenttransmart", label: "腾讯 Transmart（网页）", group: "free", fields: [] },
  { id: "mymemory", label: "MyMemory", group: "free", fields: [{ key: "email", label: "邮箱（可选，提高额度）" }] },
  { id: "deeplx", label: "DeepL 网页（非官方）", group: "free", fields: [endpoint("https://www2.deepl.com/jsonrpc")] },
  { id: "cnki", label: "知网 CNKI 学术翻译（非官方）", group: "free", fields: [] },
  { id: "iciba", label: "金山词霸网页翻译（非官方）", group: "free", fields: [] },
  { id: "baidu", label: "百度翻译", group: "api", fields: [key("AppID#密钥#Action（Action 可省略）")] },
  { id: "baidufield", label: "百度领域翻译", group: "api", fields: [key("AppID#密钥#领域代码")] },
  { id: "caiyun", label: "彩云小译", group: "api", fields: [key("彩云 Token")] },
  { id: "deeplfree", label: "DeepL API Free", group: "api", fields: [key("DeepL Auth Key")] },
  { id: "deeplpro", label: "DeepL API Pro", group: "api", fields: [key("DeepL Auth Key")] },
  { id: "microsoft", label: "Microsoft Translator（Azure）", group: "api", fields: [
    key("Azure 翻译密钥"), { key: "region", label: "Azure Region（可选）" },
  ] },
  { id: "openai", label: "OpenAI Chat Completions", group: "api", fields: gptFields() },
  { id: "customgpt1", label: "自定义 GPT 接口 1", group: "api", fields: gptFields() },
  { id: "customgpt2", label: "自定义 GPT 接口 2", group: "api", fields: gptFields() },
  { id: "customgpt3", label: "自定义 GPT 接口 3", group: "api", fields: gptFields() },
  { id: "azuregpt", label: "Azure OpenAI", group: "api", fields: [
    key("Azure API Key"),
    endpoint("https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-10-21", true),
    model("deployment"), prompt,
  ] },
  { id: "gemini", label: "Google Gemini API", group: "api", fields: [
    key(), endpoint("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"), prompt,
  ] },
  { id: "claude", label: "Anthropic Claude API", group: "api", fields: [
    key(), endpoint("https://api.anthropic.com/v1/messages"), model("claude-sonnet-4-5"), prompt,
  ] },
  { id: "qwenmt", label: "阿里云 Qwen-MT", group: "api", fields: [
    key(), endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"),
    model("qwen-mt-plus"), { key: "domains", label: "领域提示（可选）" },
  ] },
  { id: "niutranspro", label: "小牛翻译 NiuTrans", group: "api", fields: [
    key("NiuTrans API Key"), endpoint("https://niutrans.com/niuInterface"),
    { key: "dictionary", label: "术语库 ID（可选）" },
    { key: "memory", label: "翻译记忆库 ID（可选）" },
  ] },
  { id: "openl", label: "OpenL 翻译", group: "api", fields: [key("service1,service2#APIKey")] },
  { id: "aliyun", label: "阿里云机器翻译", group: "api", fields: [
    key("AccessKeyID#AccessKeySecret"), endpoint("https://mt.aliyuncs.com/"),
    { key: "action", label: "API Action", defaultValue: "TranslateGeneral" },
    { key: "scene", label: "Scene", defaultValue: "general" },
  ] },
  { id: "tencent", label: "腾讯云机器翻译", group: "api", fields: [
    key("SecretId#SecretKey"), { key: "region", label: "Region", defaultValue: "ap-shanghai" },
    { key: "projectId", label: "Project ID", defaultValue: "0" },
  ] },
  { id: "huoshan", label: "火山引擎机器翻译", group: "api", fields: [key("AccessKeyID#AccessKeySecret")] },
  { id: "xftrans", label: "讯飞机器翻译", group: "api", fields: [
    key("AppID#ApiSecret#ApiKey"),
    { key: "mode", label: "接口", type: "select", defaultValue: "its", options: [
      { value: "its", label: "讯飞 ITS" }, { value: "ots", label: "小牛 NiuTrans" },
    ] },
  ] },
  { id: "youdaozhiyun", label: "有道智云", group: "api", fields: [
    key("AppID#AppSecret#VocabID（可省略）"),
    { key: "domain", label: "领域", type: "select", defaultValue: "medicine", options: [
      { value: "general", label: "普通" }, { value: "medicine", label: "医学" },
      { value: "computers", label: "计算机" }, { value: "finance", label: "金融" },
    ] },
  ] },
  { id: "youdaozhiyunllm", label: "有道智云大模型翻译", group: "api", fields: [
    key("AppID#AppSecret"), model("0"), prompt,
  ] },
  { id: "libretranslate", label: "LibreTranslate 自托管", group: "local", fields: [
    endpoint("http://127.0.0.1:5000", true), { key: "secret", label: "API Key（可选）", type: "password" },
  ] },
  { id: "mtranserver", label: "MTranServer 自托管", group: "local", fields: [
    endpoint("http://127.0.0.1:8989/translate", true),
    { key: "secret", label: "授权 Token（可选）", type: "password" },
  ] },
  { id: "deeplcustom", label: "DeepLX 自托管", group: "local", fields: [
    endpoint("http://127.0.0.1:1188/translate", true),
  ] },
  { id: "nllbserve", label: "NLLB Serve 自托管", group: "local", fields: [
    endpoint("http://127.0.0.1:6060", true),
  ] },
  { id: "nllbapi", label: "NLLB API 自托管", group: "local", fields: [
    endpoint("http://127.0.0.1:7860", true),
  ] },
];
export const DICTIONARY_ONLY_SERVICES: readonly string[] = [
  "Bing Dict", "Cambridge Dictionary", "Collins Dictionary", "FreeDictionaryAPI",
  "Gramota Dictionary", "海词词典", "金山词霸", "Weblio", "有道词典",
];
export const NON_PARAGRAPH_SERVICES: readonly string[] = [
  "Pot（仅外部弹窗；不返回段落译文）",
];
const SERVICE_MAP = new Map(SERVICE_CATALOG.map((service) => [service.id, service]));
export function getServiceDefinition(id: string): ServiceDefinition | undefined {
  return SERVICE_MAP.get(id);
}
export function isManagedService(id: string): boolean {
  return SERVICE_MAP.has(id);
}
const BASE = "extensions.zotero.bilingualreader.services";
function settingKey(id: string, field: string): string {
  if (!isManagedService(id) || !/^[a-zA-Z0-9]+$/.test(field)) {
    throw new Error("无效的翻译服务配置键。");
  }
  return BASE + "." + id + "." + field;
}
export function getServiceSetting(id: string, field: string): string {
  const pref = (Zotero.Prefs as any).get(settingKey(id, field), true);
  if (typeof pref === "string") return pref;
  const definition = getServiceDefinition(id);
  return definition?.fields.find((item) => item.key === field)?.defaultValue || "";
}
export function updateServiceSettings(id: string, values: Record<string, string>): void {
  const definition = getServiceDefinition(id);
  if (!definition) throw new Error("找不到翻译服务。");
  // Validate the entire submission before writing any prefs (no partial saves).
  for (const field of definition.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const incoming = values[field.key].trim();
    if (field.type === "url" && incoming && !/^https?:\/\/\S+$/i.test(incoming)) {
      throw new Error(field.label + " 必须是 http:// 或 https:// 地址。");
    }
    if (field.required && !incoming) throw new Error(field.label + " 不能为空。");
    if (field.type === "select" && field.options && !field.options.some((opt) => opt.value === incoming)) {
      throw new Error(field.label + " 选项无效。");
    }
  }
  let changed = false;
  for (const field of definition.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const incoming = values[field.key].trim();
    if (incoming !== getServiceSetting(id, field.key)) {
      (Zotero.Prefs as any).set(settingKey(id, field.key), incoming, true);
      changed = true;
    }
  }
  if (changed) {
    const previous = (Zotero.Prefs as any).get(settingKey(id, "revision"), true);
    (Zotero.Prefs as any).set(settingKey(id, "revision"), Number(previous || 0) + 1, true);
  }
}
export function getServiceRevision(id: string): number {
  const value = (Zotero.Prefs as any).get(settingKey(id, "revision"), true);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function assertServiceConfigured(id: string): void {
  const definition = getServiceDefinition(id);
  if (!definition) throw new Error("无效的翻译服务。");
  for (const field of definition.fields) {
    if (field.required && !getServiceSetting(id, field.key).trim()) {
      throw new Error(definition.label + " 尚未配置 " + field.label + "。");
    }
  }
}
