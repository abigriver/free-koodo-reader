# 远程 Ollama 接入方案

> 状态：方案评估，**未改代码**。实测时间 2026-11-07。
> 相关文档：`REMOTE_TTS_SERVER.md`（TTS 服务改造）

## 一、直接回答两个问题

**问 1：多角色朗读的角色分析，远程还需要 Ollama 吗？**

不需要。角色分析已经由 8972 端口代掉了。远程客户端从 TTS 地址自动推导出 `/analyze`，请求发给 `10.20.0.2:8972`，由服务端在本机调用 Ollama。远程机器不装 Ollama、不配模型名，都能工作。

实测（从本机模拟远端请求 `POST http://10.20.0.2:8972/analyze`）：

```json
[{"index":0,"speaker":"narrator"},{"index":1,"speaker":"female"},{"index":2,"speaker":"male"}]
```

**问 2：远程电脑能直接调用本机 Ollama 吗？**

能，但现在调不通，因为 Ollama 只绑了 `127.0.0.1:11434`（已核实 `ss -ltn`）。要跨机器用，必须让它在 p2wlan 网卡上可达，或者经一个带鉴权的代理转发。

注意：**这不只影响多角色**。AI 问书 / AI 助手和 Ollama 划词翻译是另外两条链路，它们现在都不走 8972，远程一律连不上。

## 二、三条链路的真实状态

| 链路 | 代码位置 | 地址来源 | 远程状态 |
|---|---|---|---|
| 角色分析（多角色朗读） | `popupAssist` 无关；`textToSpeech/component.tsx` | 从 `ttsServerUrl` 推导 `/analyze` | ✅ **已通** |
| AI 问书 / AI 助手 | `src/utils/request/ollama.ts` | `aiLocalUrl`，默认 `127.0.0.1:11434` | ❌ 连不上 |
| Ollama 划词翻译 | `plugins/catalog.ts` → `ollama-translate-plugin` | 插件 `config.url`，默认 `127.0.0.1:11434/api/generate` | ❌ 连不上 |

后两条的报错是 `Cannot reach Ollama at http://127.0.0.1:11434, please make sure the Ollama service is running`。远程用户看到这句会以为是自己没装 Ollama。

## 三、三个可选方案

| | A. 直接绑 0.0.0.0 | B. 8972 加 `/ollama` 代理 | C. 独立代理服务 |
|---|---|---|---|
| 端口暴露 | 11434 新增 | 复用 8972 | 新增一个端口 |
| 鉴权 | 无（靠防火墙限源） | Bearer token（复用现有） | 取决于实现 |
| 客户端改动 | **0 行** | ~60 行（服务端）+ ~30 行（主进程 + 配置） | 0～20 行 |
| 流式对话 | 原生 | 需手写 NDJSON 透传 | 视实现 |
| 危险接口 | `/api/pull` `/api/delete` 全开 | 可白名单禁用 | 可白名单禁用 |
| 运维 | 改一个 drop-in | 无新增进程 | 多一个 systemd unit |
| 适用 | p2wlan 内全是你自己的设备 | 网内有他人设备，或想统一入口 | 想与 TTS 解耦 |

### 推荐：先 A 后 B

理由：A 是十分钟能跑通的验证路径，先用它确认“远程确实能用上 3090 跑模型”；确认可用后，如果 p2wlan 里会出现别人的设备，再升级到 B。B 的客户端改动很小，因为 `resolveOllamaEndpoint()` 已经会保留 base 的路径前缀（只截断 `/api/` 之后的部分），填 `http://10.20.0.2:8972/ollama` 就能自动拼成 `/ollama/api/chat`。

## 四、方案 A 的具体操作

```bash
sudo tee /etc/systemd/system/ollama.service.d/lan.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_NUM_PARALLEL=2"
EOF
sudo systemctl daemon-reload && sudo systemctl restart ollama
ss -ltn | grep 11434      # 应变成 0.0.0.0:11434 或 *:11434
```

**这一步对现有本地客户端没有影响。** `0.0.0.0` 表示「所有 IPv4 地址」，**包含
`127.0.0.1`**，所以继续连回环的程序全部照常：

| 使用方 | 地址 | 改后 |
|---|---|---|
| `~/.local/bin/rime-speech-ollama.sh`（语音输入润色） | `127.0.0.1:11434/api/generate` | 正常 |
| `~/.local/bin/ollama-batch` | `localhost:11434` | 正常 |
| `indextts_server.py` 的 `OLLAMA_URL`（`/analyze` 代理） | `127.0.0.1:11434` | 正常 |
| Free Koodo Reader AI 助手 / 划词翻译 | `127.0.0.1:11434` | 正常 |
| `ollama` CLI | 默认 `127.0.0.1:11434` | 正常 |

唯一的代价是 `restart` 那一刻：进行中的请求失败、已加载模型被卸载，
`qwen3.5:9b`（6.7 GB）下次首请求要多等 3–8 秒。

**先回答一个常见担心：这些规则会不会挡住本机访问？不会。**

1. ufw 的 `/etc/ufw/before.rules` 首条是 `-A ufw-before-input -i lo -j ACCEPT`，
   链顺序为 `INPUT → ufw-before-input → ufw-user-input`，回环流量在进入用户规则前就放行了。
   `before6.rules` 有同一条，`::1` 同样安全。
2. 已实测 `ip route get 10.20.0.2` → `local 10.20.0.2 dev lo table local`，
   本机访问自己的 p2wlan 地址也走 `lo`。
   `/analyze` 代理用的 `http://127.0.0.1:11434` 因此完全不受影响。
3. ufw 的 `deny` 是 DROP 语义，客户端表现为超时而不是「连接被拒绝」；想快速失败用 `ufw reject`。

但真正要先想清楚的不是这个，而是：**`OLLAMA_HOST=0.0.0.0` 不是「只对 p2wlan 开放」，
而是所有 IPv4 网卡都监听**，包括校园网口 `eno1 172.21.225.12/19`。`/19` 覆盖
172.21.224.0–172.21.255.255 约 8000 个地址。家庭网络背后有 NAT，外面进不来；
校园网是平坦大二层，同网段直接可达。**这个场景反而比家庭网络更需要按网卡挡住。**

### 路径 1：单条 iptables，不动现有防火墙（推荐）

```bash
sudo iptables -I INPUT -i eno1 -p tcp --dport 11434 -j DROP
```

只对校园网口丢包，其余一律不变：`lo` 正常（`/analyze`、语音输入润色照常）、
`p2wlan0` 正常、默认策略不动、22/80/3306/6333/8972 全部保持原状。

代价是重启失效。Ubuntu 22.04 默认没装 `iptables-persistent`，用 oneshot 保活：

```bash
sudo tee /etc/systemd/system/ollama-lan-guard.service >/dev/null <<'EOF'
[Unit]
Description=Block Ollama port on campus NIC
After=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iptables -I INPUT -i eno1 -p tcp --dport 11434 -j DROP
ExecStop=/usr/sbin/iptables -D INPUT -i eno1 -p tcp --dport 11434 -j DROP
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now ollama-lan-guard
```

### 路径 2：开 ufw（会连带影响一批现有服务）

本机 ufw 当前 `ENABLED=no`。一旦 `ufw enable`，DROP 默认策略会**立刻**挡掉现在
所有 `0.0.0.0` 监听的端口：

| 端口 | 服务 | enable 后 |
|---|---|---|
| 22 | SSH | 若没 allow 会断连 |
| 80 | HTTP | 不可达 |
| 3306 | MySQL | 不可达 |
| 6333 / 6334 | Qdrant | 不可达 |
| 8972 | **TTS 服务** | **远程朗读立刻失效** |
| 5173 / 5174 | Vite dev | 不可达 |
| 6099 / 9002 / 15176 | 待确认 | 不可达 |

顺序必须是先 allow 再 enable：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 8972/tcp          # 想只给 p2wlan 就把这条换成 allow from 10.20.0.0/16
sudo ufw allow from 10.20.0.0/16 to any port 11434 proto tcp comment 'ollama for p2wlan'
sudo ufw enable
sudo ufw status numbered
```

**Docker 会让 ufw 失效**：本机有 `docker0`、`br-5b4b776835ec`、`br-32935224fcd8`
三个网桥。Docker 直接写 iptables，绕开 ufw 的 INPUT 链，所以 `docker run -p` 发布的
端口 ufw 根本管不住，得单独在 `DOCKER-USER` 链处理。这也是路径 1 更干净的原因。

**两个容易踩的点**：

- `OLLAMA_HOST=0.0.0.0:11434` 是 **IPv4 only**。客户端填 `localhost` 而系统优先解析
  `::1` 时会连不上（`::1` 上没有监听，与防火墙无关）。客户端一律填
  `127.0.0.1` 或 `10.20.0.2`。需要双栈则用 `OLLAMA_HOST=[::]:11434`。
- 改完要 `systemctl restart ollama`，会中断进行中的请求并卸载已加载模型
  （`qwen3.5:9b` 6.7 GB，下一个请求多等 3–8 秒）。挑空闲时做。

验证顺序（1→4，任何一步断了都别往下走）：

```bash
# 1. 本机回环仍通
curl -s http://127.0.0.1:11434/api/tags | head -c 80
# 2. 本机走 p2wlan 地址（经 lo，也应通）
curl -s --max-time 3 http://10.20.0.2:11434/api/tags | head -c 80
# 3. 唯一能证明「回环没被误伤」的端到端测试：角色分析
curl -s --max-time 30 -X POST http://127.0.0.1:8972/analyze \
  -H "Content-Type: application/json" \
  -d '{"sentences":["他推开门。","“你回来了。”她说。"]}'
# 4. 从远程机器
curl --max-time 5 http://10.20.0.2:11434/api/tags
```

客户端要填两处：

- AI 助手：弹窗右上角设置 → `Server address` = `http://10.20.0.2:11434`
- Ollama 翻译插件：设置 → 插件 → Edit → `url` = `http://10.20.0.2:11434/api/generate`

模型下拉会自动列出本机已装的模型（走 `/api/tags`），不用手填名字。

**A 方案的残留风险**：Ollama 没有应用层鉴权，防火墙是唯一屏障。`/api/pull` 任何人可调，能往你磁盘里拉几十 GB 模型；`/api/delete` 能删掉你的模型。所以网里只要有一台不可信设备，就该直接上 B。

## 五、方案 B 的改动清单（供评估，未实施）

### 服务端 `indextts_server.py`

1. `do_GET` / `do_POST` 路由增加 `/ollama/` 前缀分支，转发到 `{OLLAMA_URL}` + 去掉前缀的 path。
2. 白名单放行：`/api/chat`、`/api/generate`、`/api/tags`、`/api/show`、`/api/ps`、`/api/embeddings`。
   显式拒绝：`/api/pull`、`/api/push`、`/api/delete`、`/api/create`、`/api/copy`。
3. 流式透传：Ollama 流式响应无 `Content-Length`，要用 `Transfer-Encoding: chunked` 边读边写并 flush；或直接关掉 keep-alive 用 `Connection: close` 简化。
4. 复用现有 `_auth_ok()` 做 token 校验。**注意 `/ollama` 分支不要进 `GPU_LOCK`** —— Ollama 是独立进程，和 TTS 不共享锁，串起来只会让长对话把朗读卡死。

### 客户端

1. `main.js` 的 `ollama-models`、`ollama-chat`、`ollama-translate` 三处 `fetch` 加 `Authorization: Bearer <token>`（token 从 IPC args 传入，主进程读不到渲染端配置）。
2. `src/utils/request/ollama.ts` 增加 `aiLocalToken` 配置项，`chatWithOllama` / `listOllamaModels` 透传。
3. 地址填 `http://10.20.0.2:8972/ollama`，无需改 `resolveOllamaEndpoint`。

## 六、六个坑（会直接影响体验）

1. **`roleAnalysisModel` 硬传模型名**。客户端默认传 `qwen3.5:9b`，如果服务端没这个模型，ollama 返回 404，客户端表现为整段朗读没有角色区分。走 `/analyze` 时应该让服务端决定模型 —— 请求里 `model` 留空即可（实测留空可用）。
   > **2026-11-07 已在服务端封堵**：`indextts_server.py` 的 `resolve_analyze_model()` 会校验请求的模型是否已安装、是否超过 `ANALYZE_MAX_MODEL_GB`（默认 12GB），不满足就回落到 `ANALYZE_MODEL`（默认 `qwen3.5:9b`）；`main.js` 直连 Ollama 时遇到 404 也会用 9b 重试一次。客户端那侧另加了 `ROLE_ANALYSIS_MODEL` 常量作为默认值。
2. **`keep_alive` 默认 5 分钟**。多角色朗读时每章分析一次，间隔容易超过 5 分钟，模型会被卸载，下一次分析先等 2～4 秒磁盘加载。已在 A 方案里设成 `30m`。
3. **显存上限是 ~12B**。实测 `qwen3.5:9b` 常驻 6.7 GB / 32k context。IndexTTS2 在同卡上还要吃一块，24 GB 能共存；但 `qwen3.5:27b` 或 `gemma4:26b`（各 17 GB）会和 TTS 抢，必然 OOM。**别在远程把模型切到 27b。**
4. **`/api/tags` 的 5 秒超时**。代码里写死了 5 秒。p2wlan 如果走中转（UDP 打洞失败），RTT 可能上百毫秒，一般够；但如果远程在弱网上，会误报“连不上”。届时把这个超时放宽到 10 秒。
5. **模型列表会暴露**。远程下拉框能直接看到你本机全部模型名（含 `qwen3-coder-30b` 这种）。不是安全问题，但会诱导远程用户选到跑不动的模型。B 方案可以在代理层过滤 `/api/tags` 的返回。
6. **token 现在没开**。日志里 `auth=off`，8972 在 `0.0.0.0` 上完全开放，任何能连到 10.20.0.2 的人都免费占用 GPU 合成语音。**建议现在就设 `INDEXTTS_TOKEN`**，不用等改造：
   ```bash
   INDEXTTS_TOKEN=$(openssl rand -hex 16) ./start_indextts.sh
   ```
   然后远程在插件 Edit 里填同一个 token。角色分析会自动带上，不用额外配。

## 七、建议节奏

1. **今天**：给 8972 设 token（一行环境变量，立刻堵上敞口）。
2. **今天**：按 A 方案绑 0.0.0.0 + ufw 限源，远程填 `aiLocalUrl` 验证 AI 助手能出字。
3. **确认可用后**：如果网内只有自己设备，就停在 A；如果需要给他人用，再做 B。
4. **顺带**：把 `roleAnalysisModel` 在远端场景下改成不传，服务端回落默认模型 —— 这是三个坑里最容易踩到的。

## 八、为什么不做“原版自建服务器”那条路

已在 `REMOTE_TTS_SERVER.md` 里说明：原版 Docker + Go httpserver 提供的是 Web 界面、书库上传、OPDS/KOReader 同步，不转发 TTS，也不转发 Ollama。Web 版还缺 `window.electronAPI`，取音频的 `generate-tts` 直接失效。**原生客户端 + 远端服务地址**才是这个项目可行的形态。
