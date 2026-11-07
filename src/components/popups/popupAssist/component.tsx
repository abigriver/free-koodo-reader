import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { marked } from "marked";
import Parser from "html-react-parser";
import toast from "react-hot-toast";
import { saveAs } from "file-saver";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import { handleContextMenu } from "../../../utils/common";
import { sampleQuestion } from "../../../constants/settingList";
import {
  abortOllamaChat,
  chatWithOllama,
  getAssistantSettings,
  listOllamaModels,
  saveAssistantSettings,
  AssistantSettings,
  DEFAULT_ASSISTANT_PROMPT,
  DEFAULT_OLLAMA_MODEL_LIST,
  OllamaChatMessage,
} from "../../../utils/request/ollama";
import { AiChatMessage, AssistantMode, PopupAssistProps } from "./interface";
import "./popupAssist.css";

const HISTORY_KEY_BY_MODE: Record<AssistantMode, string> = {
  ask: "aiAskHistory",
  chat: "aiChatHistory",
};
const MAX_HISTORY_LENGTH = 100;
// 送进模型的章节正文上限：太长会拖慢本地推理，也会挤掉对话历史
const MAX_CONTEXT_CHARS = 12000;
// 送进模型的历史消息条数上限
const HISTORY_FOR_PROMPT = 12;

// EPUB 里常见的控制字符
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const prepareChapterText = (raw: string) => {
  let text = (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const head = Math.floor(MAX_CONTEXT_CHARS * 0.7);
  const tail = MAX_CONTEXT_CHARS - head;
  return `${text.slice(0, head)}\n\n……（本章中间内容过长，已省略）……\n\n${text.slice(
    -tail
  )}`;
};

const newRequestId = () =>
  `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Electron 会在 IPC 异常前加 "Error invoking remote method 'x': Error: "，
// 展示给用户前先剥掉这层包装
const describeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
};

const PopupAssist = (props: PopupAssistProps) => {
  const { t } = useTranslation();
  const {
    currentBook,
    originalText,
    quoteText,
    htmlBook,
    isDockedRight = false,
    handleQuoteText,
  } = props;
  const bookKey = currentBook?.key || "";

  const [mode, setMode] = useState<AssistantMode>("ask");
  const [askHistory, setAskHistory] = useState<AiChatMessage[]>([]);
  const [chatHistory, setChatHistory] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isWaiting, setIsWaiting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AssistantSettings>(() =>
    getAssistantSettings()
  );
  const [models, setModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");

  const messagesBoxRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isAtBottomRef = useRef(true);
  const isWaitingRef = useRef(false);
  const activeRequestRef = useRef("");
  const streamBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const askRef = useRef<AiChatMessage[]>([]);
  const chatRef = useRef<AiChatMessage[]>([]);
  const isHydratingRef = useRef(false);

  useEffect(() => {
    askRef.current = askHistory;
  }, [askHistory]);
  useEffect(() => {
    chatRef.current = chatHistory;
  }, [chatHistory]);

  const messages = mode === "ask" ? askHistory : chatHistory;

  const scrollToBottom = (force = false) => {
    const box = messagesBoxRef.current;
    if (!box) return;
    if (!force && !isAtBottomRef.current) return;
    box.scrollTop = box.scrollHeight;
    isAtBottomRef.current = true;
  };

  const handleMessagesScroll = () => {
    const box = messagesBoxRef.current;
    if (!box) return;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    isAtBottomRef.current = distance < 40;
  };

  // 切换书籍时重新载入该书的问答历史
  useEffect(() => {
    if (!bookKey) {
      setAskHistory([]);
      setChatHistory([]);
      return;
    }
    isHydratingRef.current = true;
    try {
      const ask = ConfigService.getObjectConfig(bookKey, "aiAskHistory", []);
      const chat = ConfigService.getObjectConfig(bookKey, "aiChatHistory", []);
      setAskHistory(Array.isArray(ask) ? ask : []);
      setChatHistory(Array.isArray(chat) ? chat : []);
    } catch (error) {
      console.error("failed to load assistant history", error);
      setAskHistory([]);
      setChatHistory([]);
    }
    const timer = setTimeout(() => {
      isHydratingRef.current = false;
      isAtBottomRef.current = true;
      scrollToBottom(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [bookKey]);

  // 引用文本（划词后打开助手）直接填进输入框
  useEffect(() => {
    if (!quoteText) return;
    setInput((prev) => (prev ? prev : quoteText + "\n"));
    handleQuoteText("");
    const timer = setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [quoteText, handleQuoteText]);

  const updateSettings = (patch: Partial<AssistantSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    saveAssistantSettings(patch);
  };

  const refreshModels = async (url = settings.url) => {
    setIsLoadingModels(true);
    setModelError("");
    try {
      const list = await listOllamaModels(url);
      setModels(list);
      if (list.length === 0) {
        setModelError(
          t("No model found. Please make sure Ollama is running.")
        );
      } else if (!list.includes(settings.model)) {
        updateSettings({ model: list[0] });
      }
    } catch (error) {
      setModelError(describeError(error));
    } finally {
      setIsLoadingModels(false);
    }
  };

  // 首次打开时探测一次本机模型，失败不阻塞使用
  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setHistory = (target: AssistantMode, next: AiChatMessage[]) => {
    const trimmed =
      next.length > MAX_HISTORY_LENGTH
        ? next.slice(next.length - MAX_HISTORY_LENGTH)
        : next;
    if (target === "ask") setAskHistory(trimmed);
    else setChatHistory(trimmed);
    if (!bookKey || isHydratingRef.current) return;
    try {
      ConfigService.setObjectConfig(
        bookKey,
        trimmed,
        HISTORY_KEY_BY_MODE[target]
      );
    } catch (error) {
      console.error("failed to persist assistant history", error);
    }
  };

  const startFlush = () => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    flushTimerRef.current = setInterval(() => {
      if (streamBufferRef.current) setStreaming(streamBufferRef.current);
    }, 120);
  };

  const stopFlush = () => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopFlush();
      if (activeRequestRef.current) {
        abortOllamaChat(activeRequestRef.current);
        activeRequestRef.current = "";
      }
    };
  }, []);

  const resolveChapterText = async (): Promise<string> => {
    let raw = (originalText || "").trim();
    if (!raw && htmlBook?.rendition?.chapterText) {
      try {
        raw = (await htmlBook.rendition.chapterText()) || "";
      } catch (error) {
        console.error("failed to read chapter text", error);
        raw = "";
      }
    }
    return prepareChapterText(raw);
  };

  const buildMessages = (
    target: AssistantMode,
    history: AiChatMessage[],
    chapterText: string
  ): OllamaChatMessage[] => {
    const basePrompt = (settings.prompt || "").trim() || DEFAULT_ASSISTANT_PROMPT;
    const system =
      target === "ask" && chapterText
        ? `${basePrompt}\n\n【当前章节内容】\n${chapterText}`
        : basePrompt;
    const recent = history.slice(-HISTORY_FOR_PROMPT);
    return [
      { role: "system", content: system },
      ...recent.map((item) => ({
        role: item.role as "user" | "assistant",
        content: item.content,
      })),
    ];
  };

  const finishAppending = (
    target: AssistantMode,
    base: AiChatMessage[],
    content: string,
    errorText?: string
  ) => {
    const text = (content || "").trim();
    if (text) {
      setHistory(target, [...base, { role: "assistant", content: text }]);
    } else if (errorText) {
      setHistory(target, [
        ...base,
        { role: "assistant", content: `${t("Error happened")}: ${errorText}` },
      ]);
    }
    scrollToBottom(true);
  };

  const handleSend = async (preset?: string) => {
    if (isWaitingRef.current) return;
    const question = (preset ?? input).trim();
    if (!question) return;
    const target = mode;
    const history = target === "ask" ? askRef.current : chatRef.current;
    const base = [...history, { role: "user" as const, content: question }];

    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "40px";
      textareaRef.current.style.overflowY = "hidden";
    }
    setHistory(target, base);
    scrollToBottom(true);

    isWaitingRef.current = true;
    setIsWaiting(true);
    streamBufferRef.current = "";
    setStreaming("");
    const requestId = newRequestId();
    activeRequestRef.current = requestId;
    startFlush();

    try {
      const chapterText = target === "ask" ? await resolveChapterText() : "";
      const result = await chatWithOllama({
        messages: buildMessages(target, base, chapterText),
        requestId,
        onDelta: (delta) => {
          streamBufferRef.current += delta;
        },
      });
      stopFlush();
      finishAppending(target, base, result.content || streamBufferRef.current);
    } catch (error) {
      stopFlush();
      const message = describeError(error);
      console.error(error);
      toast.error(t("Error happened") + ": " + message);
      finishAppending(target, base, streamBufferRef.current, message);
    } finally {
      stopFlush();
      streamBufferRef.current = "";
      activeRequestRef.current = "";
      isWaitingRef.current = false;
      setIsWaiting(false);
      setStreaming("");
    }
  };

  const handleStop = () => {
    if (!activeRequestRef.current) return;
    abortOllamaChat(activeRequestRef.current);
  };

  const handleCopy = (content: string) => {
    navigator.clipboard.writeText(content || "").then(() => {
      toast.success(t("Copied"));
    });
  };

  const handleClearHistory = () => {
    setHistory(mode, []);
    toast.success(t("Deletion successful"));
  };

  const handleExportHistory = () => {
    const current = mode === "ask" ? askRef.current : chatRef.current;
    if (current.length === 0) {
      toast(t("Nothing to export"));
      return;
    }
    const now = new Date();
    const pad = (value: number) => (value <= 9 ? `0${value}` : `${value}`);
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )}`;
    const bookName = currentBook?.name || "Unknown";
    const exportData = {
      bookName,
      mode,
      exportedAt: now.toISOString(),
      messages: current,
    };
    saveAs(
      new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json;charset=UTF-8",
      }),
      `KoodoReader-${mode === "ask" ? "Reading" : "Chat"}-Assistant-${bookName}-${dateStr}.json`
    );
    toast.success(t("Export successful"));
  };

  const autoResizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const maxHeight = lineHeight * 5 + paddingTop + paddingBottom;
    el.style.height = "0px";
    const contentHeight = el.scrollHeight;
    if (contentHeight >= maxHeight) {
      el.style.height = `${maxHeight}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${contentHeight}px`;
      el.style.overflowY = "hidden";
    }
  };

  const renderMarkdown = (content: string) => {
    const html = DOMPurify.sanitize(marked.parse(content || "") as string);
    return <>{Parser(html || " ")}</>;
  };

  const modelOptions = useMemo(() => {
    const list = new Set<string>(models);
    if (settings.model) list.add(settings.model);
    if (list.size === 0) DEFAULT_OLLAMA_MODEL_LIST.forEach((item) => list.add(item));
    return [...list];
  }, [models, settings.model]);

  return (
    <div className={`popup-assist-container${isDockedRight ? " is-docked" : ""}`}>
      <div className="popup-assist-header">
        <div className="popup-assist-tabs">
          <div
            className={`popup-assist-tab${mode === "ask" ? " is-active" : ""}`}
            onClick={() => setMode("ask")}
          >
            <span className="icon-bookmark popup-assist-tab-icon"></span>
            {t("Reading Assistant")}
          </div>
          <div
            className={`popup-assist-tab${mode === "chat" ? " is-active" : ""}`}
            onClick={() => setMode("chat")}
          >
            <span className="icon-idea popup-assist-tab-icon"></span>
            {t("Chat Assistant")}
          </div>
        </div>
        <div className="popup-assist-tools">
          <select
            className="popup-assist-model"
            value={settings.model}
            title={t("Model")}
            onChange={(event) => updateSettings({ model: event.target.value })}
          >
            {modelOptions.map((item) => (
              <option
                key={item}
                value={item}
                className="add-dialog-shelf-list-option"
              >
                {item}
              </option>
            ))}
          </select>
          <span
            className="popup-assist-tool"
            data-tooltip-id="my-tooltip"
            data-tooltip-content={t("Clear chat history")}
            onClick={handleClearHistory}
          >
            <span className="icon-trash-line"></span>
          </span>
          <span
            className="popup-assist-tool"
            data-tooltip-id="my-tooltip"
            data-tooltip-content={t("Export chat history")}
            onClick={handleExportHistory}
          >
            <span className="icon-share"></span>
          </span>
          <span
            className={`popup-assist-tool${showSettings ? " is-active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              setShowSettings((prev) => !prev);
            }}
          >
            <span className="icon-setting"></span>
          </span>
        </div>
      </div>

      {showSettings && (
        <div
          className="popup-assist-settings"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="popup-assist-field-label">{t("Server address")}</div>
          <input
            className="popup-assist-input"
            value={settings.url}
            placeholder="http://127.0.0.1:11434"
            onChange={(event) => updateSettings({ url: event.target.value })}
            onBlur={(event) => refreshModels(event.target.value)}
          />
          <div className="popup-assist-field-inline">
            <div className="popup-assist-field-label">{t("Model")}</div>
            <span
              className={`popup-assist-refresh${
                isLoadingModels ? " is-loading" : ""
              }`}
              onClick={() => refreshModels()}
              data-tooltip-id="my-tooltip"
              data-tooltip-content={t("Refresh")}
            >
              <span
                className="icon-sync"
                style={{ display: "inline-block" }}
              ></span>
            </span>
          </div>
          <select
            className="popup-assist-input"
            value={settings.model}
            onChange={(event) => updateSettings({ model: event.target.value })}
          >
            {modelOptions.map((item) => (
              <option
                key={item}
                value={item}
                className="add-dialog-shelf-list-option"
              >
                {item}
              </option>
            ))}
          </select>
          {modelError && (
            <div className="popup-assist-hint">{modelError}</div>
          )}
          <div className="popup-assist-field-label">{t("System prompt")}</div>
          <textarea
            className="popup-assist-prompt"
            value={settings.prompt}
            rows={4}
            onChange={(event) => updateSettings({ prompt: event.target.value })}
          />
          <div className="popup-assist-settings-actions">
            <span
              className="popup-assist-text-button"
              onClick={() =>
                updateSettings({ prompt: DEFAULT_ASSISTANT_PROMPT })
              }
            >
              {t("Restore default")}
            </span>
            <span
              className="popup-assist-text-button"
              onClick={() => setShowSettings(false)}
            >
              {t("Save")}
            </span>
          </div>
        </div>
      )}

      <div
        className="popup-assist-messages"
        ref={messagesBoxRef}
        onScroll={handleMessagesScroll}
      >
        {messages.length === 0 && !streaming && !isWaiting && (
          <div className="popup-assist-bubble is-assistant">
            {mode === "ask"
              ? t("Hi there! What questions do you have about this chapter?")
              : t(
                  "Hi there! I'm happy to help with any questions about reading or learning"
                )}
          </div>
        )}
        {messages.map((item, index) => (
          <div
            key={index}
            className={`popup-assist-bubble ${
              item.role === "assistant" ? "is-assistant" : "is-user"
            }`}
          >
            {renderMarkdown(item.content)}
            {item.role === "assistant" && (
              <span
                className="popup-assist-copy"
                onClick={() => handleCopy(item.content)}
                data-tooltip-id="my-tooltip"
                data-tooltip-content={t("Copy")}
              >
                <span className="icon-copy-line"></span>
              </span>
            )}
          </div>
        ))}
        {streaming && (
          <div className="popup-assist-bubble is-assistant">
            {renderMarkdown(streaming)}
          </div>
        )}
        {isWaiting && !streaming && (
          <div className="popup-assist-bubble is-assistant popup-assist-thinking">
            <span className="icon-loading popup-assistant-loading"></span>
            <span>{t("Thinking, please wait...")}</span>
          </div>
        )}
      </div>

      <div className="popup-assist-footer">
        {messages.length === 0 && !streaming && (
          <div className="popup-assist-shortcuts">
            {sampleQuestion
              .filter((item) => item.mode === mode)
              .map((item) => (
                <div
                  key={item.question}
                  className="popup-assist-shortcut"
                  onClick={() => handleSend(t(item.question))}
                >
                  {item.emoji + " " + t(item.question)}
                </div>
              ))}
          </div>
        )}
        <div className="popup-assist-input-row">
          <textarea
            ref={textareaRef}
            id="popup-assist-input"
            className="popup-assist-textarea"
            placeholder={t(
              mode === "ask"
                ? "Ask anything about this chapter"
                : "Ask anything about reading or learning"
            )}
            value={input}
            style={{ height: "40px", overflowY: "hidden" }}
            onChange={(event) => {
              setInput(event.target.value);
              autoResizeTextarea();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !(event.nativeEvent as any).isComposing
              ) {
                event.preventDefault();
                handleSend();
              }
            }}
            onContextMenu={() => handleContextMenu("popup-assist-input")}
          />
          <div
            className={`popup-assist-send${
              isWaiting ? " is-stop" : input.trim() ? "" : " is-disabled"
            }`}
            onClick={isWaiting ? handleStop : () => handleSend()}
          >
            {isWaiting ? t("Stop") : t("Send")}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PopupAssist;
