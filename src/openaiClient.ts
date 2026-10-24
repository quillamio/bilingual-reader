import {
  buildOpenAIRequestBody,
  extractOpenAIContent,
  formatOpenAIHttpError,
  getXhrResponseBody,
  normalizeChatCompletionsEndpoint,
} from "./translationPipeline";

export interface OpenAIClientConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  timeoutMs: number;
}

export async function requestOpenAITranslation(
  config: OpenAIClientConfig,
  text: string,
): Promise<string> {
  const endpoint = normalizeChatCompletionsEndpoint(config.endpoint);
  if (!endpoint) throw new Error("未配置 OpenAI 兼容接口地址。");
  if (!config.apiKey.trim()) throw new Error("未配置 API Key。");
  if (!config.model.trim()) throw new Error("未配置模型名称。");

  const body = buildOpenAIRequestBody({
    model: config.model.trim(),
    systemPrompt: config.systemPrompt,
    text,
    temperature: config.temperature,
  });

  let xhr: any;
  try {
    xhr = await Zotero.HTTP.request("POST", endpoint, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      responseType: "text",
      timeout: config.timeoutMs,
    });
  } catch (error: any) {
    const failed = error?.xmlhttp || error?.xhr;
    const detail = getXhrResponseBody(failed) ?? error?.message;
    throw new Error(
      formatOpenAIHttpError(failed?.status, detail ?? failed?.statusText),
    );
  }

  if (!xhr || xhr.status < 200 || xhr.status >= 300) {
    throw new Error(
      formatOpenAIHttpError(
        xhr?.status,
        getXhrResponseBody(xhr) ?? xhr?.statusText,
      ),
    );
  }

  let response: any = xhr.response;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch (_) {
      throw new Error("OpenAI 兼容服务返回了无法解析的响应。");
    }
  }

  const content = extractOpenAIContent(response);
  if (!content) {
    throw new Error("OpenAI 兼容服务未返回有效译文。请检查模型名称与余额。");
  }
  return content;
}
