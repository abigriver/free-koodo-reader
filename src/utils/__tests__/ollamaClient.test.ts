/**
 * Local Ollama assistant client — browser/fallback transport.
 *
 * The Electron path is covered by the IPC contract test (channel allowlist +
 * main.js handler). What can regress silently here is the NDJSON stream
 * parsing (Ollama streams one JSON object per line, NOT SSE), so the fallback
 * transport is exercised directly with a fake reader.
 */
import {
  chatWithOllama,
  listOllamaModels,
  DEFAULT_OLLAMA_URL,
} from "../request/ollama";

// jsdom in this jest version does not expose TextDecoder/TextEncoder even
// though every Electron/Capacitor renderer does.
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "util";
if (typeof (global as any).TextDecoder === "undefined") {
  (global as any).TextDecoder = NodeTextDecoder;
}
if (typeof (global as any).TextEncoder === "undefined") {
  (global as any).TextEncoder = NodeTextEncoder;
}

// kookit-extra-browser.min pulls in ESM-only deps (sse.js) that jest cannot
// transform; the client only needs the reader-config surface.
const readerConfig: Record<string, string> = {};
jest.mock("../../assets/lib/kookit-extra-browser.min", () => ({
  ConfigService: {
    getReaderConfig: (key: string) => readerConfig[key],
    setReaderConfig: (key: string, value: string) => {
      readerConfig[key] = value;
    },
  },
}));

const makeBody = (lines: string[]) => {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index >= lines.length) return { done: true, value: undefined };
        const value = new TextEncoder().encode(lines[index++] + "\n");
        return { done: false, value };
      },
    }),
  };
};

const mockFetch = (impl: (url: string, init?: any) => any) => {
  const fn = jest.fn(impl);
  (global as any).fetch = fn;
  return fn;
};

describe("chatWithOllama (browser transport)", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("accumulates streamed deltas and reports each one", async () => {
    mockFetch(async () => ({
      ok: true,
      body: makeBody([
        JSON.stringify({ message: { content: "第一段" }, done: false }),
        JSON.stringify({ message: { content: "，第二段" }, done: false }),
        // 空行与不完整 JSON 必须被跳过而不是让整次回答失败
        "",
        "{not json",
        JSON.stringify({ message: { content: "。" }, done: true }),
      ]),
    }));

    const deltas: string[] = [];
    const result = await chatWithOllama({
      messages: [{ role: "user", content: "你好" }],
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result.content).toBe("第一段，第二段。");
    expect(result.aborted).toBe(false);
    expect(deltas).toEqual(["第一段", "，第二段", "。"]);
  });

  it("surfaces an error chunk instead of silently returning partial text", async () => {
    mockFetch(async () => ({
      ok: true,
      body: makeBody([JSON.stringify({ error: "model not found" })]),
    }));

    await expect(
      chatWithOllama({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow("model not found");
  });

  it("throws on a non-2xx response", async () => {
    mockFetch(async () => ({ ok: false, status: 500, body: null }));
    await expect(
      chatWithOllama({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow("HTTP 500");
  });
});

describe("listOllamaModels (browser transport)", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("hits /api/tags on the bare host and returns model names", async () => {
    const fetchMock = mockFetch(async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: "qwen3.5:9b" }, { model: "gemma4:12b" }, {}],
      }),
    }));

    const models = await listOllamaModels(DEFAULT_OLLAMA_URL);
    expect(models).toEqual(["qwen3.5:9b", "gemma4:12b"]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${DEFAULT_OLLAMA_URL}/api/tags`
    );
  });

  it("strips a full endpoint down to the host before appending /api/tags", async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, json: async () => ({ models: [] }) }));
    await listOllamaModels("http://127.0.0.1:11434/api/generate");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11434/api/tags"
    );
  });
});
