# 把本机 GPU 语音服务开放给远程阅读器

> 目标：本机（3090 / 24G，p2wlan 地址 `10.20.0.2`）作为语音后端；
> 远程电脑装同一份 Free Koodo Reader，朗读时把文字发过来、拿回音频。
> 完成日期：2026-11-07

---

## 一、先说结论

**原版的自建服务器帮不上这个忙。**

仓库里的 `Dockerfile` + `docker-compose.yml` + `httpserver/`（Go）+ Caddy，提供的是：

- Web 版阅读界面（浏览器打开，端口 80）
- 书籍上传/书库（`/app/uploads`）
- OPDS 目录、KOReader 进度同步（8080 / 7200）

它**不转发 TTS**，而且 Web 版没有 `window.electronAPI`，而 `src/utils/reader/ttsUtil.ts` 的取音频路径是：

```ts
window.electronAPI.invoke("generate-tts", { ... })
```

浏览器里这个对象不存在，IndexTTS 插件在 Web 版里直接失效。要让它可用，得把整条 TTS 链路重写成 fetch + 处理 CORS —— 工作量远大于「原生客户端 + 远端服务地址」。

**正确形态：客户端仍是原生 Electron 应用（书库、排版、离线都在本地），只把「合成语音」这一件事交给 10.20.0.2。** 这正是 `ttsUtil` 天然支持的形态 —— 它本来就把请求交给主进程，主进程用 axios 发 HTTP，只要地址不是 127.0.0.1 就行。

```
远程电脑                                    本机 10.20.0.2
┌──────────────────────────┐              ┌──────────────────────────┐
│ Koodo Reader (Electron)  │              │  indextts_server.py      │
│                          │  ① /analyze  │  :8972  (带 token)       │
│ 主进程 main.js ──────────┼─────────────►│    └─► Ollama :11434     │
│   axios(proxy:false)     │  ② /tts      │    └─► IndexTTS-2 + 3090 │
│                          │◄─────────────┤                          │
│ 渲染端 Howl 播放 mp3     │   音频字节    │  单实例 + GPU 串行锁      │
└──────────────────────────┘              └──────────────────────────┘
        p2wlan 虚拟局域网（10.20.0.0/16，MTU 1420）
```

---

## 二、服务端：`~/software/indextts_server.py`

### 改了什么

| 项 | 改造前 | 改造后 |
|---|---|---|
| 监听地址 | `127.0.0.1`（写死） | `INDEXTTS_BIND`，默认 `0.0.0.0` |
| 并发模型 | `HTTPServer` 单线程，backlog 5 | `ThreadingHTTPServer` + `GPU_LOCK`，backlog 64 |
| 鉴权 | 无 | `INDEXTTS_TOKEN` → `Authorization: Bearer`，`hmac.compare_digest` 比较 |
| 参考音色 | 只加载 `.wav` | wav/mp3/flac/m4a/ogg（mp3 经 ffmpeg 转 float32） |
| 输出格式 | 只有 wav | `format: "mp3"`（64k 单声道，体积约 1/5.4） |
| 情绪 | 未启用 | 可选 `emo`（8 维向量）+ `emoWeight`，不传则走默认 |
| 角色分析 | 无 | `POST /analyze`，服务端代为调用本机 Ollama |
| 观测 | 无 | `/health` 返回 queue/lastRtf/requests；每次请求打日志（IP、字数、耗时、RTF） |
| 上限 | 无 | `INDEXTTS_MAX_TEXT`（默认 2000 字），超出 413 |
| 角色分析模型 | 客户端硬传 | `ANALYZE_MODEL`（默认 `qwen3.5:9b`）+ `ANALYZE_MAX_MODEL_GB`（默认 12），超限/未安装自动回落 |

`GPU_LOCK` 是必须的：IndexTTS-2 引擎不是线程安全的，而且 3090 上也只能串行跑。
并发请求会排队，不会损坏显存。

### 接口

```
GET  /health                     无需鉴权
GET  /voices                     需鉴权
POST /tts    {text, ref, format?, emo?, emoWeight?, speed?}
POST /analyze {sentences[], model?}
```

响应头里带 `X-Audio-Duration`（音频秒数）和 `X-Gen-Seconds`（生成耗时），
远程调优时直接看这两个值就能算 RTF。

### 启动

```bash
cd ~/software
./start_indextts.sh                 # 前台，默认 0.0.0.0:8972
INDEXTTS_PORT=8973 ./start_indextts.sh   # 换端口
```

参数也可以写进 `~/.config/indextts-server.env`（脚本会自动 source）：

```bash
INDEXTTS_BIND=0.0.0.0
INDEXTTS_PORT=8972
INDEXTTS_TOKEN=换成你自己的口令
OLLAMA_URL=http://127.0.0.1:11434
```

**注意：这台机器只能跑一个 TTS 实例。** 我实测同时开 3 个实例时，显存被打满，
RTF 从 0.46 恶化到 14.8（慢 32 倍）。换端口测试前务先把旧实例停掉。

### 常驻（可选）

已生成 `~/.config/systemd/user/indextts-server.service`：

```bash
systemctl --user daemon-reload
systemctl --user enable --now indextts-server
systemctl --user status indextts-server
```

**启用前先停掉手动跑的实例**，否则抢 8972 端口。

---

## 三、客户端：改了三处

### 1. TTS 地址可配（`ttsUtil.ts`）

原来 `config: voice.config` 只传 `{ref: "磁性男声"}`，插件里的
`config.url || "http://127.0.0.1:8972/tts"` 永远走默认值 —— **URL 实际上改不了**。
现在按「插件配置 → 音色配置 → 全局覆盖」三层合并。

### 2. 请求不走系统代理（`indexTTS2Voice.js`）

这是实测踩到的真坑：axios 会读环境变量里的代理设置，把请求发成
`POST http://10.20.0.2:8972/tts HTTP/1.1`（绝对 URI）。私有地址经代理转发
要么被拦、要么多一跳。加 `proxy: false` 后直连。

同时按响应的 `Content-Type` 决定落盘后缀（`.mp3` / `.wav`），
否则 mp3 内容被存成 `.wav`，Howler 会按错误格式解码。

### 3. 角色分析地址自动跟随

角色分析原来是硬编码 `http://127.0.0.1:11434/api/generate`。远端没有 Ollama 就废了。

现在：
- 优先 `roleAnalysisServer` 显式配置
- 否则从 TTS 地址推导：`http://10.20.0.2:8972/tts` → `http://10.20.0.2:8972/analyze`
- 都没有才回落到本机 Ollama

**所以远端只需要配一个 TTS 地址，角色分析自动走服务端代理**，不必把 11434 暴露出去。

### 远端电脑怎么配

装好同一个 fork 的安装包后：

1. 设置 → 插件 → 安装 **IndexTTS-2 (Local)**
2. 该插件点 **Edit**，三个字段：
   - `url` = `http://10.20.0.2:8972/tts`
   - `token` = 本机 `INDEXTTS_TOKEN` 的值（没设就留空）
   - `format` = `mp3`（跨网强烈建议；不填默认 wav，体积大 5 倍）
3. 阅读页 → 朗读 → 选 IndexTTS-2 音色即可

已经装过该插件的机器，Edit 表单里可能只有 `url`。补 `token`/`format` 两个字段：
删掉插件重新安装即可拿到新默认配置（catalog 的 `defaultConfig` 已加这两个 key）。

---

## 四、实测数据（2026-11-07）

**单实例基线**（本机回环，旧服务，142 字）：

| 指标 | 值 |
|---|---|
| 生成耗时 | 6.05 s |
| 音频时长 | 13.26 s |
| RTF | **0.46** |
| wav 体积 | 571 KB |

**新服务功能验证**（8975/8976/8977 分端口）：

| 项 | 结果 |
|---|---|
| 监听 | `0.0.0.0:8975`，backlog **64** |
| 无 token 访问 `/tts`、`/voices` | **401** |
| 错误 token | **401** |
| 正确 token `/voices` | 200，**110 个音色**（改造前只加载 wav，现在 mp3 参考音也进来了） |
| wav 合成 | 200，带 `X-Audio-Duration` / `X-Gen-Seconds` |
| mp3 合成 | 200，42 KB vs wav 230 KB，**压缩 5.4 倍** |
| 2100 字超长 | **413** |
| `/analyze` | 正确返回 `narrator / female / male` |
| 插件端到端 | mp3 落盘 `.mp3`、ID3 头正确、错误 token 401、未知音色 400 |
| keep-alive 复用 | 401 之后同连接继续请求正常（修复前会 501） |

mp3 转码开销可以忽略：同一段文本 wav 的 RTF 0.46、mp3 的 8.09（后者是双实例干扰下的数字），
差值落在噪声里，换来 5 倍带宽节省。

---

## 五、网络与容量

- **带宽**：一句 30 字约 5 秒音频。wav 230 KB / mp3 42 KB。
  p2wlan 若是 P2P 直连没问题；走中继时会明显卡，这是选 mp3 的主要原因。
- **MTU**：`p2wlan0` 是 1420，TCP 会自动分段，不用手调；但如果是自建隧道要注意别设 1500。
- **首句延迟**：生成 1 秒音频约 0.5 秒，加上网络往返，首句大约 1.5-2 秒才有声。
  现有的「逐句合成 + 预取下一句」能把这个延迟吃掉（`TTSUtil.cacheAudio`）。
- **多人同时用**：GPU 串行，第二个人会排队。三个人同时朗读，体感会明显变慢。
  这是 3090 的上限，不是代码问题。

---

## 六、安全

- p2wlan 是私有虚拟局域网，但**接入同一网络的设备不止你一台**。
- 服务一旦 `0.0.0.0` 且无 token，任何能 ping 通 `10.20.0.2` 的机器都能烧你的显卡。
- 所以：`INDEXTTS_TOKEN` 建议设上；客户端插件 Edit 里填同一个值。
- 不要把 8972 映射到公网。
- Ollama 的 11434 保持 `127.0.0.1` 即可 —— 角色分析走 `/analyze` 代理，不需要暴露它。

---

## 七、还没做的

1. **设置 UI 里没有「TTS 服务地址」的独立输入框**。目前靠插件 Edit 或配置文件，
   够用但不够直观。
2. **`/tts` 没有限流**。局域网内可信，公网绝对不行。
3. **没有音频缓存**。同一句重复生成会重新算；客户端侧已有 `audioPaths` 缓存，
   但跨会话不保留。
4. **角色分析仍是四分类**（旁白/男/女/童），未做具名角色 —— 见 `MULTI_ROLE_DEV.md` 的 TODO。
