# 本地 AI 助手改造方案

> 目标：在 free-koodo-reader（fork）基础上，用**本地 Ollama** 恢复原版被移除的 AI 助手功能（章节分析、对话问答）。
>
> 原版仓库：`~/software/koodo-reader-dev`（版本 2.4.7）
> 当前 fork：`~/software/free-koodo-reader`（版本 3.0.6）

---

## 一、目标

把读者页右下角的「AI」图标接上本地 Ollama，实现：

- 对**当前章节**提问（解释、总结、讨论）；
- 分析章节中的**对话/角色**；
- 连续的聊天式问答。

## 二、整体数据流

```
读者页右下角 AI 图标点击
  → handleMenuMode("assistant")           // 打开 assistant 弹窗
  → handleOriginalText(章节文本)           // 取当前章节全文
  → handleOpenMenu(true)
  → PopupBox 渲染 <PopupAssist />          // 弹窗（需恢复 assistant 分支）
  → 用户输入问题，点发送
  → 调 IPC "ollama-chat"                   // 主进程
  → 主进程 fetch Ollama /v1/chat/completions（流式 SSE）
  → 流式回传 → PopupAssist 显示回答
```

## 三、要改/新建的模块

### 1. UI 层（核心工作）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/components/popups/popupAssist/` 整个目录 | **恢复** | 从原版 `~/software/koodo-reader-dev/src/components/popups/popupAssist/` 拷回 4 个文件（component/index/interface/css） |
| `src/components/popups/popupBox/component.tsx` | **改** | 加 `menuMode === "assistant"` 分支渲染 `<PopupAssist />`，并 `import PopupAssist` |

**关键适配点**：原版 PopupAssist 用的是 **zustand（`useAppStore`）**，fork 用的是 **Redux**。需要把：

```tsx
// 原版（zustand）
const currentBook = useAppStore((s) => s.book.currentBook);
const originalText = useAppStore((s) => s.reader.originalText);
const plugins = useAppStore((s) => s.manager.plugins);
const handleOpenMenu = useAppStore((s) => s.handleOpenMenu);
```

改成 Redux 的 `connect`/`mapStateToProps`（参考 fork 里其他 popup 组件，`popupTrans/index.tsx` 就是标准模板）：

```tsx
// fork 风格（Redux）
const mapStateToProps = (state: stateType) => ({
  currentBook: state.book.currentBook,
  originalText: state.reader.originalText,
  plugins: state.manager.plugins,
});
const actionCreator = { handleOpenMenu, handleMenuMode, /* ... */ };
export default connect(mapStateToProps, actionCreator)(withTranslation()(PopupAssist as any) as any);
```

### 2. AI 调用层

| 文件 | 动作 | 说明 |
|---|---|---|
| `main.js` | **新增** `ipcMain.handle("ollama-chat", ...)` | 本地 Ollama 调用 |
| `preload.js` | **改** | `INVOKE_CHANNELS` 白名单加 `"ollama-chat"` |

**两种实现方式（二选一）**：

**A. 非流式（简单，推荐先做）** —— 复用 fork 已有的 `ollama-translate` 模式：

```js
// main.js
ipcMain.handle("ollama-chat", async (event, args) => {
  const { text, question, history, model, url } = args || {};
  const prompt = `你是阅读助手，基于下面章节内容回答问题...\n章节：${text}\n问题：${question}`;
  const res = await fetch(url || "http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "qwen3.5:27b",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
    }),
  });
  const data = await res.json();
  return data.message?.content || "";
});
```

**B. 流式（体验好，稍复杂）** —— 恢复原版的 `chatStream`（在 `src/utils/request/common.ts`），把闭源的 `CommonTool.getDisableThinkingParams` 换成 `think: false`。Ollama 的 `/v1/chat/completions` 原生支持 SSE。

### 3. 状态层（可复用，几乎不用改）

- `reader.originalText`（选中/章节文本）—— 已存在，AI 图标点击时已经设好。
- `manager.plugins`（插件列表）—— 已存在。
- 聊天历史 `askHistory` / `chatHistory` —— PopupAssist 的**组件内部 state**（`useState`），不用进 Redux。

## 四、分步实施计划

### 里程碑 1：最小闭环（非流式）

1. 拷贝原版 `popupAssist` 4 个文件到 fork；
2. 把 `useAppStore` 全部替换成 Redux `connect`（或 `useSelector`）；
3. 删掉官方 AI 路径（`getAnswerStream` 相关），只留本地调用；
4. `main.js` 加 `ollama-chat` IPC + preload 白名单；
5. `popupBox` 加 assistant 分支（`POPUP_MODES` 数组也要加 `"assistant"`）；
6. 测试：点 AI 图标 → 弹窗 → 提问 → 得到回答。

### 里程碑 2：流式输出（可选）

1. 恢复 `chatStream`（简化版，去掉闭源依赖）；
2. `ollama-chat` 改成 SSE 流式回传。

### 里程碑 3：配置 UI（可选）

1. 在 PopupAssist 里加模型选择（9b/27b）、系统提示词配置。

## 五、关键参考文件

| 内容 | 位置 |
|---|---|
| 原版 AI 助手 UI（33KB 完整实现） | `~/software/koodo-reader-dev/src/components/popups/popupAssist/component.tsx` |
| 原版流式调用 | `~/software/koodo-reader-dev/src/utils/request/common.ts` 的 `chatStream` |
| **fork 已有的 IPC 模板** | `main.js` 的 `ollama-translate` / `ollama-analyze-roles`（照抄结构即可） |
| **fork 的 Redux popup 模板** | `src/components/popups/popupTrans/index.tsx`（恢复翻译时写的标准 connect 模式） |
| 原版 AI 图标触发点 | `~/software/koodo-reader-dev/src/pages/reader/component.tsx` 里 `handleMenuMode("assistant")` |

## 六、风险与注意点

1. **`chatStream` 依赖闭源的 `CommonTool.getDisableThinkingParams`** —— 必须换成 `think: false`（已验证 qwen3.5 必须关思考，否则超时）。
2. **`llmReport`、`handleContextMenu`、`REPORT_REASONS`、`vexSelectAsync`** 等原版依赖，fork 可能已删除，恢复时要逐一处理（删掉或替换）。
3. **popupBox 的 `POPUP_MODES` 数组** 要加 `"assistant"`（恢复翻译时加过 `"trans"`，同样操作）。
4. **AI 图标已经在 fork 里**（`src/pages/reader/component.tsx` 的 `isDisableAI` 判断），只差 popupBox 的渲染分支和 PopupAssist 组件本身。

---

## 七、资料查询途径（问题 → 去哪查）

### 1. 代码/实现参考

| 问题 | 去哪查 |
|---|---|
| 原版 AI 助手完整实现长什么样 | `~/software/koodo-reader-dev/src/components/popups/popupAssist/component.tsx` |
| 原版怎么调 AI（流式/官方） | `~/software/koodo-reader-dev/src/utils/request/common.ts`（`chatStream`）、`reader.ts`（`getAnswerStream`） |
| fork 怎么加主进程 IPC | `free-koodo-reader/main.js` 里 `ollama-translate`、`ollama-analyze-roles` |
| fork 怎么加 IPC 白名单 | `free-koodo-reader/preload.js` 的 `INVOKE_CHANNELS` |
| fork 的 Redux popup 标准写法 | `free-koodo-reader/src/components/popups/popupTrans/index.tsx` |
| 原版/fork 的差异对比 | 用 `git log` / `git diff` 对比两个仓库；原版 2.4.7 vs fork 3.0.6 的主要差异是 zustand→Redux |

### 2. 官方文档

| 问题 | 去哪查 |
|---|---|
| Ollama 本地 API / OpenAI 兼容端点 | <https://github.com/ollama/ollama/blob/main/docs/api.md>（重点看 `/api/chat` 和 `/v1/chat/completions`） |
| Koodo Reader 插件/架构文档 | <https://github.com/koodo-reader/koodo-reader> 的 README、AGENTS.md；插件文档 <https://github.com/koodo-reader/plugins> |
| Electron IPC（ipcMain/ipcRenderer） | <https://www.electronjs.org/docs/latest/api/ipc-main> |
| react-redux（connect / useSelector） | <https://react-redux.js.org/api/connect> |
| React 函数组件 + Hooks | <https://react.dev/reference/react/hooks> |

### 3. 具体技术问题（搜索引擎关键词）

| 问题 | 搜索关键词 |
|---|---|
| zustand 迁移到 Redux | `zustand to redux migration`、`useAppStore to connect react-redux` |
| Electron 主进程 fetch / 发 HTTP | `electron main process fetch http`、`ipcMain.handle fetch` |
| Ollama 流式 SSE | `ollama chat completions stream sse`、`ollama openai compatible api` |
| 前端 SSE 客户端 | `sse.js npm`、`EventSource chat completions` |
| 流式输出打字机效果 | `react streaming text typewriter`、`accumulate stream chunks` |
| 主进程/渲染进程通信 | `electron ipcRenderer invoke example` |

### 4. 本地验证/调试

| 问题 | 怎么做 |
|---|---|
| 测试 Ollama 是否返回正确 | 直接用 `curl` 或 Python 脚本发请求到 `http://127.0.0.1:11434/api/chat`，看返回 |
| 看主进程报错 | 运行 `npm run dev` 的终端（主进程 `console.error` 打在这里） |
| 看渲染进程报错 | 同样在 `npm run dev` 终端（带 `[Renderer]` 前缀） |
| 确认模型已加载 | `ollama list`、`ollama ps` |
| 确认 IPC 是否在白名单 | 报错 `IPC channel is not allowed: xxx` 就说明 preload 白名单没加 |

### 5. 调试技巧

- **先 curl 验证再写代码**：任何 AI 调用先在终端用 `curl` 或 Python 脚本测通，再写进 IPC。
- **qwen3.5 必须 `think: false`**：否则进入思考模式会超时（实测 1.6s vs 超时）。
- **JSON 输出不稳定**：优先让模型输出「行号:角色」这种纯文本格式，避免 JSON 转义问题（参考 `ollama-analyze-roles` 的实现）。
- **改 main.js / preload.js 必须完全重启**：Ctrl+C 停掉再 `npm run dev`，只刷新页面无效。

---

**一句话总结**：核心就是「恢复 PopupAssist 组件 + 把 zustand 改成 Redux + 用一个 `ollama-chat` IPC 调本地 Ollama」。原版 UI 是现成的，fork 里已有两个可照抄的模板（翻译 IPC、翻译弹窗的 Redux 写法）。

---

## 八、实施记录（2026-11-06，已完成里程碑 1+2）

### 改了哪些文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `main.js` | 新增 3 个 IPC | `ollama-chat`（NDJSON 流式 + 可中断）、`ollama-chat-abort`、`ollama-models`（`/api/tags`，5s 超时）；含 `resolveOllamaEndpoint`（裸主机 / base url / `/api/generate` 三种写法都能用）与 `describeOllamaConnectionError`（把 `fetch failed` 翻成人话） |
| `preload.js` | 改白名单 | `INVOKE_CHANNELS` += `ollama-chat` / `ollama-chat-abort` / `ollama-models`；`EVENT_CHANNELS` += `ollama-chat-stream`（流式增量回推） |
| `src/utils/request/ollama.ts` | **新建** | 渲染端客户端：Electron 走 IPC，浏览器/Capacitor 退化为直接 fetch（同一套 NDJSON 解析）；配置读写（`aiLocalUrl` / `aiLocalModel` / `aiLocalPrompt`）；`listOllamaModels` / `abortOllamaChat` |
| `src/components/popups/popupAssist/` | **新建 4 文件** | 重写的函数组件（不再用原版 zustand 版）：`component.tsx` / `index.tsx`（Redux connect）/ `interface.tsx` / `popupAssist.css`（自带 `popup-assist-*` 命名，不依赖其他弹窗 CSS） |
| `src/components/popups/popupBox/component.tsx` | 改 | `POPUP_MODES` 加 `assistant`，渲染分支加 `<PopupAssist />` |
| `src/assets/locales/{en,zh-CN}.json` | 改 | 新增 `Model` / `System prompt` / `Restore default` / `No model found...`；顺手补了上一版遗漏的 `Translation failed`（i18n 测试原本是红的） |
| `src/utils/__tests__/ollamaClient.test.ts` | **新建** | 5 个用例：NDJSON 增量累积、坏行跳过、error 块上抛、非 2xx、`/api/tags` 端点拼接 |

### 与原版方案的差异（有意为之）

1. **不走插件体系**：原版靠 `plugins` 里 `type === "assistant"` 的插件提供 endpoint/model。fork 已删掉账号/Pro/AI 云，这里改为**弹窗内自带的本地配置**（地址 / 模型 / 系统提示词），存 reader config，不碰插件市场与设置页。
2. **流式而非非流式**：`/api/chat` + `stream: true`，主进程按行解析 NDJSON（Ollama 不是 SSE），逐条 `webContents.send` 回渲染端；渲染端 120ms 刷一次，避免每 token 重渲染。
3. **保留可中断**：`ollama-chat-abort` 用 `AbortController` 按 requestId 取消，已生成的半截回答会保留；发送按钮在等待时变成「Stop」。
4. **上下文长度**：章节正文上限 12000 字符（超长取首 70% + 尾 30%，中间标注省略），历史带最近 12 条，`num_ctx: 8192`，`think: false`（qwen3.5 必须关）。
5. **历史与导出**：沿用原版 key（`aiAskHistory` / `aiChatHistory`，按 `bookKey` 存），导出格式与原版一致，旧数据可直接续上。

### 验证情况

- `tsc --noEmit` 通过；`eslint src --max-warnings 0` 零告警；`react-scripts test` **12 套件 / 62 用例全绿**（原 57 + 新增 5）。
- `react-scripts build` 成功（bundle +4.5 kB / CSS +777 B）。
- 用真实本机 Ollama 直接打 `/api/chat`（`qwen3.5:9b`，请求体与 main.js 完全一致）：HTTP 200，192 个增量块，首字到完毕约 5.2s，`think:false` 正常。
- **未完成**：无头沙箱下 Electron 的 `index.html` 头部 parser-inserted 外链脚本（`fabric.min.js` / `vex.combined.min.js`）没有执行，整页白屏——用最小 Electron 窗口加载 `build/index.html` 同样复现，与本改动无关（报错发生在 inline `vex.defaultOptions` 那一行，先于 React bundle）。所以**弹出层没能在 CI 式环境里截图验证**，需在桌面环境跑 `npm run dev` 手动确认一次。

### 手动验收清单

1. `npm run dev`，打开任意书 → 阅读页点右下角 `AI`；
2. 弹窗应出现「AI 问书 / AI 助手」两个页签 + 右上角模型下拉（应自动列出 `ollama list` 的模型）；
3. 问一句章节相关的问题 → 先出「Thinking」，再逐字输出；点「Stop」能中断且保留半截回答；
4. 关掉弹窗再重开 → 历史还在；换一本书 → 历史跟着换；
5. 关掉 Ollama 再提问 → 提示 `Cannot reach Ollama at http://127.0.0.1:11434, please make sure the Ollama service is running`（而不是一堆 `fetch failed`）。

