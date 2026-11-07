import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

/**
 * 本地 Ollama 阅读助手客户端。
 *
 * Electron 下走主进程 IPC（`ollama-chat` / `ollama-chat-abort` / `ollama-models`），
 * 既避免渲染进程的 CORS 限制，也统一了取消逻辑；
 * 浏览器 / Capacitor 下退化为渲染进程直接 fetch（Ollama 支持跨域）。
 */

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatParams {
  messages: OllamaChatMessage[];
  url?: string;
  model?: string;
  temperature?: number;
  numCtx?: number;
  requestId?: string;
  onDelta?: (delta: string) => void;
}

export interface OllamaChatResult {
  content: string;
  aborted: boolean;
  requestId: string;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3.5:9b";
export const DEFAULT_OLLAMA_MODEL_LIST = [
  "qwen3.5:9b",
  "qwen3.5:27b",
  "qwen3.5:4b",
];
export const DEFAULT_ASSISTANT_PROMPT =
  "你是一个运行在本机的阅读助手。请使用与用户提问相同的语言回答，先给结论再给依据；如果章节内容里没有相关信息，请直接说明，不要编造。";

const CONFIG_KEY_URL = "aiLocalUrl";
const CONFIG_KEY_MODEL = "aiLocalModel";
const CONFIG_KEY_PROMPT = "aiLocalPrompt";

export interface AssistantSettings {
  url: string;
  model: string;
  prompt: string;
}

const readConfig = (key: string, fallback: string): string => {
  try {
    const value = ConfigService.getReaderConfig(key);
    return typeof value === "string" && value.trim() ? value : fallback;
  } catch (error) {
    return fallback;
  }
};

const writeConfig = (key: string, value: string) => {
  try {
    ConfigService.setReaderConfig(key, value);
  } catch (error) {
    console.error("failed to persist assistant config", key, error);
  }
};

export const getAssistantSettings = (): AssistantSettings => ({
  url: readConfig(CONFIG_KEY_URL, DEFAULT_OLLAMA_URL),
  model: readConfig(CONFIG_KEY_MODEL, DEFAULT_OLLAMA_MODEL),
  prompt: readConfig(CONFIG_KEY_PROMPT, DEFAULT_ASSISTANT_PROMPT),
});

export const saveAssistantSettings = (patch: Partial<AssistantSettings>) => {
  if (patch.url !== undefined) writeConfig(CONFIG_KEY_URL, patch.url.trim());
  if (patch.model !== undefined) writeConfig(CONFIG_KEY_MODEL, patch.model);
  if (patch.prompt !== undefined) writeConfig(CONFIG_KEY_PROMPT, patch.prompt);
};

const hasElectronApi = () =>
  typeof window !== "undefined" &&
  !!(window.electronAPI && window.electronAPI.invoke);

const createRequestId = () =>
  `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 拉取本机已安装的模型列表；失败时抛出可读错误。 */
export const listOllamaModels = async (url?: string): Promise<string[]> => {
  const endpointUrl = url || getAssistantSettings().url;
  if (hasElectronApi()) {
    const models = await window.electronAPI.invoke<string[]>("ollama-models", {
      url: endpointUrl,
    });
    return Array.isArray(models) ? models : [];
  }
  const base = (endpointUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const apiIndex = base.indexOf("/api/");
  const root = apiIndex >= 0 ? base.slice(0, apiIndex) : base;
  const res = await fetch(`${root}/api/tags`);
  if (!res.ok) throw new Error(`Ollama model list failed: HTTP ${res.status}`);
  const data = await res.json();
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .map((item: any) => item?.name || item?.model || "")
    .filter(Boolean);
};

/** 中断一次进行中的对话（仅 Electron 有效，浏览器模式自行 abort）。 */
export const abortOllamaChat = (requestId: string) => {
  if (!requestId || !hasElectronApi()) return;
  window.electronAPI
    .invoke("ollama-chat-abort", requestId)
    .catch((error) => console.error("failed to abort ollama chat", error));
};

export const chatWithOllama = async (
  params: OllamaChatParams
): Promise<OllamaChatResult> => {
  const settings = getAssistantSettings();
  const url = params.url || settings.url;
  const model = params.model || settings.model;
  const requestId = params.requestId || createRequestId();
  const temperature = params.temperature ?? 0.7;
  const numCtx = params.numCtx ?? 8192;

  if (hasElectronApi()) {
    let unsubscribe: (() => void) | undefined;
    if (params.onDelta) {
      const onDelta = params.onDelta;
      unsubscribe = window.electronAPI.on("ollama-chat-stream", (payload: any) => {
        if (payload && payload.requestId === requestId && payload.delta) {
          onDelta(payload.delta as string);
        }
      });
    }
    try {
      const result = await window.electronAPI.invoke<OllamaChatResult>(
        "ollama-chat",
        {
          url,
          model,
          messages: params.messages,
          requestId,
          temperature,
          numCtx,
        }
      );
      return {
        content: result?.content || "",
        aborted: !!result?.aborted,
        requestId,
      };
    } finally {
      unsubscribe?.();
    }
  }

  // 浏览器 / Capacitor：直接请求（Ollama 默认放开 CORS）
  const base = (url || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const apiIndex = base.indexOf("/api/");
  const root = apiIndex >= 0 ? base.slice(0, apiIndex) : base;
  const res = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: params.messages,
      stream: true,
      think: false,
      options: { temperature, num_ctx: numCtx },
    }),
  });
  if (!res.ok) throw new Error(`Ollama chat failed: HTTP ${res.status}`);
  if (!res.body) {
    const data = await res.json();
    return {
      content: data?.message?.content || data?.response || "",
      aborted: false,
      requestId,
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let chunk: any;
    try {
      chunk = JSON.parse(trimmed);
    } catch (error) {
      return;
    }
    if (chunk?.error) throw new Error(String(chunk.error));
    const delta = chunk?.message?.content;
    if (delta) {
      content += delta;
      params.onDelta?.(delta);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) consume(buffer);
  return { content, aborted: false, requestId };
};
