# 多角色朗读开发文档

> 版本：最小闭环（已验证可用）
> 目标：用本地 Ollama 做角色分析 + IndexTTS-2 多音色朗读
> 后续完善：UI 音色选择器、分类准确度、分段优化

---

## 一、概述

多角色朗读 = 「**角色分析**（本地 Ollama）」+「**多音色朗读**（IndexTTS-2）」。

当前已跑通最小闭环：把章节文字按句切分 → 发 Ollama 分析每句属于「旁白/男/女/童」→ 按角色分配不同的 IndexTTS-2 音色 → 逐句朗读。

## 二、数据流

```
点击「从此朗读」+ 打开「AI multi-role speech」开关
  → handleGetText()（多角色分支）
    1. 取书本章节文字，splitSentences 切句 → nodeTextList
    2. 按句子累积到 ~500 字为一段 → chunks
    3. 逐段发 IPC "ollama-analyze-roles"（sentences 数组）
    4. Ollama 返回「行号:角色」→ 解析成 speakerByIndex Map
    5. nodeTextList.map → 每句按 speaker 查 roleVoice → 得到 voiceName/voiceEngine
  → 返回 nodeList（每句带独立音色）
  → handleCustomRead() 逐句生成音频（IndexTTS-2）+ 边读边预取下一句
```

## 三、涉及的文件和改动

| 文件 | 改动 |
|---|---|
| `main.js` | 新增 `ipcMain.handle("ollama-analyze-roles", ...)`（角色分析 IPC） |
| `preload.js` | `INVOKE_CHANNELS` 白名单加 `"ollama-analyze-roles"` |
| `src/components/textToSpeech/component.tsx` | ① `handleGetText` 多角色分支：从「全部分配旁白」的桩改成真实角色分析+音色分配；② 去掉 3 处 `isAuthed`(Pro) 门槛；③ 去掉 `(Pro)` 标签；④ 加调试日志 |

## 四、角色分析实现细节

### 1. IPC 处理器（main.js）

```js
ipcMain.handle("ollama-analyze-roles", async (event, args) => {
  const { sentences, model, url } = args || {};   // sentences: string[]
  // 1. 构建编号文本
  const numbered = sentences.map((s, i) => `${i}. ${s}`).join("\n");
  // 2. 提示词（四分类）
  const prompt = `...narrator=旁白 male=男 female=女 child=童...\n严格只输出每行的角色，格式为「行号:角色」...\n文本：\n${numbered}`;
  // 3. 调 Ollama（关键参数）
  body: { model, prompt, stream: false, think: false, options: { temperature: 0 } }
  // 4. 解析返回（兼容两种格式）
  //    - "0:narrator"  → 用行号
  //    - "narrator:narrator" → 用行位置作索引
});
```

### 2. 提示词要点

- 明确四分类：`narrator`（旁白/叙述）、`male`、`female`、`child`。
- 强调「严格只输出角色，不要解释、不要 markdown」。
- 用**「行号:角色」纯文本格式**，不用 JSON（避免引号转义问题）。

### 3. 分段策略

- 按句子累积到约 **500 字**为一段（`MAX_CHUNK = 500`），避免超出模型上下文（qwen3.5:9b 为 32768 token）。
- 每段记录 `startIndex`（全局起始索引），返回结果用 `startIndex + 局部行号` 映射回全局句索引。

### 4. 返回解析

```js
// 兼容两种格式：
// 格式1：0:narrator（有行号）
// 格式2：narrator:narrator（模型误解格式，用行位置兜底）
```

## 五、音色分配实现细节

### 默认映射（ConfigService 未配置时）

| 角色 | 音色（voiceName） | 说明 |
|---|---|---|
| narrator 旁白 | `v10` | 专业解说 |
| male 男角色 | `v1` | 磁性男声 |
| female 女角色 | `v6` | 温柔女声 |
| child 童声 | `v8` | 童声（8岁女孩） |

### 代码

```js
const roleVoice = {
  narrator: {
    voiceName: ConfigService.getReaderConfig("multiRoleNarratorVoice") || "v10",
    voiceEngine: ConfigService.getReaderConfig("multiRoleNarratorEngine") || "indextts2-voice-plugin",
  },
  male:   { voiceName: ConfigService.getReaderConfig("multiRoleMaleVoice") || "v1",   ... },
  female: { voiceName: ConfigService.getReaderConfig("multiRoleFemaleVoice") || "v6", ... },
  child:  { voiceName: ConfigService.getReaderConfig("multiRoleChildVoice") || "v8",  ... },
};
```

> ⚠️ **重要坑**：不能读 `this.state.multiRoleMaleVoice`，因为状态初始化时它的默认值是**当前音色**（`voiceName`，即 v10），永远不是空，导致 `|| "v1"` 不生效。必须直接读 `ConfigService.getReaderConfig(...)`。

## 六、已验证的关键经验（务必遵守）

1. **`think: false` 是必须的**：qwen3.5 默认有思考模式，开启时角色分析会超时；加 `think:false` 后 **1.6 秒**返回。
2. **不要用 `format: "json"`**：会和思考模式冲突，导致 response 为空。
3. **JSON 输出不稳定**：模型会把中文引号 `""` 转成 ASCII 引号 `"`，破坏 JSON。所以改用「行号:角色」纯文本格式。
4. **分类准确度**：9b 会把「主角的内心独白/旁白」（如「陈暮心下免不了评价一番」）误判成 male，因为看到男性主角名字就归 male。需要更准的模型（27b）或提示词优化。
5. **改 main.js/preload.js 必须完全重启**（Ctrl+C 再 `npm run dev`）。

## 七、当前限制与已知问题

1. **UI 音色选择器未接**：四个角色（旁白/男/女/童）的音色是硬编码默认值，用户无法在界面自定义。
2. **「语音类型」选择器不适用**：多角色 UI 里还有 `system / official-ai / custom` 的选择，和 IndexTTS-2 无关，需要改或隐藏。
3. **分类准确度**：9b 模型对「旁白 vs 内心独白 vs 对话」的区分不理想。
4. **分段大小**：500 字是经验值，未做针对性调优。
5. **失败重试**：某段分析失败会整体中止，没有单段重试。
6. **章节边界**：`rendition.audioText()` 取的是当前可见文本，长章节会被分成多块，块与块之间角色上下文会断开。

## 八、后期完善计划（TODO）

| 优先级 | 任务 | 说明 |
|---|---|---|
| P0 | **UI 音色选择器** | 把旁白/男/女/童四个角色接到 IndexTTS-2 音色下拉，可自定义 |
| P0 | 换 27b 或优化提示词 | 提升「旁白 vs 对话」分类准确度 |
| P1 | 失败重试 | 某段分析失败时重试一次（或降级为全旁白） |
| P1 | 分段大小可调/自适应 | 按模型上下文自动调整分段 |
| P2 | 角色上下文跨块 | 让模型知道前后文的角色设定（传人物列表） |
| P2 | 多线程音频生成 | IndexTTS-2 服务当前单线程，可做并发队列 |

## 九、调试方法

| 问题 | 方法 |
|---|---|
| 角色分析没返回/报错 | 看 `npm run dev` 终端的 `[角色分析] 原始返回无效/无法解析` 日志 |
| 看每个分段内容 | `[多角色] 分析片段(...字): [...]` |
| 看分析结果 | `[多角色] 分析结果: [...]` |
| 看角色分布 | `[多角色] 角色分布: {...}` |
| 看每句用什么音色 | `[IndexTTS2] getAudioPath config= {"ref":"..."}` |
| 单独测 Ollama 角色分析 | 写 Python 脚本 POST 到 `http://127.0.0.1:11434/api/generate`，用同样的提示词 |
| 确认音色服务在跑 | `curl -s http://127.0.0.1:8972/health` 应返回 `{"ok":true}` |
| 确认模型 | `ollama list`、`ollama ps` |

---

**相关文档**：本地 AI 助手方案见 `LOCAL_AI_PLAN.md`；IndexTTS-2 语音集成见项目记忆 `free-koodo-indextts-tts`。
