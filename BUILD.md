# 打包说明：Windows 安装包 / Android APK

> 本文件记录 2026-11-08 在本机（Ubuntu 22.04 + node 22 + JDK 21）实测通过的流程。
> 所有命令都在仓库根目录执行。

## 一、先分清两件事

| 命令 | 作用 | 产物 |
|---|---|---|
| `npm run build` | **只**编译前端（CRA） | `build/`（web 静态资源，不是安装包） |
| `npm run dist:win` | 打 Windows 安装包 | `dist/Free Koodo Reader-3.0.6-x64.exe` |
| `npm run android:apk` | 打 Android debug APK | `android/app/build/outputs/apk/debug/app-debug.apk` |

`build/` 是 Electron 和 Capacitor **共同**的前置资源，两条链路都会自己先跑一遍 `npm run build`。

## 二、为打包做的两处工程修正

1. **`package.json` 里 `yarn build` 改成 `npm run build`**
   上游脚本用的是 yarn，本机没装 yarn（只有 corepack），导致 `npm run release`、
   `npm run android:build` 第一步就报 `yarn: command not found`。
   同时新增了 `dist:win` / `dist:linux` / `android:apk` 三个快捷脚本。

2. **新增 `android/local.properties`**（已被 gitignore）
   ```
   sdk.dir=/home/todd/Android/Sdk
   ```
   `ANDROID_HOME` 没设时，gradle 靠这个文件找 SDK。

## 三、Windows 安装包

```bash
npm run dist:win          # 等价于 npm run build && electron-builder --win nsis --x64
npm run dist:win:all      # x64 + ia32 + arm64 + zip + portable，慢，一般不需要
```

### 本机实测结论

前端编译、`better-sqlite3` 原生模块重建、asar 打包（87 MB）、exe 改名与 asar 完整性补丁
**全部通过**，卡在最后一步：

```
command=wine .../winCodeSign-2.6.0/rcedit-ia32.exe '.../Free Koodo Reader.exe' --set-icon ...
⨯ wine is required, please see https://electron.build/multi-platform-build#linux
```

electron-builder 用 **32 位** 的 `rcedit-ia32.exe` 改写 exe 的图标和版本信息。本机
`/usr/bin/wine` 是 alternatives 链接，`/usr/lib/wine/wine`（32 位）存在但**静默失败无输出**，
实际只有 `wine64 6.0.3` 能用（`/usr/lib/wine/wine64 --version` 正常）。

### 三条出路

> **2026-11-08 更新：wine32 已装好，A 方案前置条件已满足。**
> 一键脚本：`bash ~/software/free-koodo-reader/build-win.sh`（加 `--fast` 跳过前端编译）。
>
> 注意：AI 助手运行在**沙箱容器**里，容器的 `/usr` 是独立镜像，看不到主机新装的 wine32
> （容器内 `dpkg -l` 为空、`/usr/lib/wine/wine` 仍是坏的）。因此这一步必须在**你自己的终端**跑。
> 另外实测容器内 `makensis` 处理 `File` 指令时会 **SIGBUS（总线错误 rc=135）**，
> 30 MB 的文件都触发，与磁盘空间无关 —— 这也说明安装包只能在主机侧生成。

**A. 装 wine32（已安装，推荐）**
```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install -y wine32
bash ~/software/free-koodo-reader/build-win.sh   # 或 npm run dist:win
```

**B. 用 docker，不动系统**
```bash
docker run --rm -v "$PWD":/project -w /project electronuserland/builder:wine \
  bash -lc "npm ci && npm run build && npx electron-builder --win nsis --x64"
```

**C. 免安装 zip（本机已产出）**
`dist/FreeKoodoReader-3.0.6-win-x64-portable.zip`（138 MB）
解压后双击 `Free Koodo Reader.exe` 即可用。
缺点：exe 的图标/版本信息还是 Electron 默认的（rcedit 没跑），功能不受影响。

首次打包会下载 `electron-v34.5.8-win32-x64.zip`（116 MB）和 `winCodeSign`（5.6 MB），
缓存在 `~/.cache/electron` 和 `~/.cache/electron-builder`，第二次不再下载。

> 若在容器里打包报 `ENOSPC`：那是容器的 `/tmp` 只有 10 MB，electron-builder 会先把
> `node_modules` 复制到 `$TMPDIR` 再打包 asar。加 `TMPDIR=/home/todd/tmp` 即可。

## 四、Android APK

```bash
npm run android:apk       # build → cap sync → gradlew assembleDebug → 复制到仓库根目录
```

产物：`FreeKoodoReader-3.0.6-android-debug.apk`（12 MB，包名 `xyz.freekoodo.reader`，
minSdk 24 / targetSdk 36）

### 前置（本机已满足）
- JDK 21（Capacitor 8 要求）
- Android SDK：`platforms/android-36`、`build-tools/36.1.0`
- gradle 8.14.3 已缓存在 `~/.gradle/wrapper/dists`

### 踩到的坑

**1. gradle 全局代理指向 127.0.0.1:7890**
`~/.gradle/gradle.properties` 里写了：
```
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=7890
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=7890
```
代理客户端没开时，所有依赖下载失败，报
`Connect to 127.0.0.1:7890 failed: 连接被拒绝`。
处理：临时绕过，不改全局配置
```bash
./gradlew assembleDebug -Dhttp.nonProxyHosts='*' -Dhttps.nonProxyHosts='*'
```
（`nonProxyHosts='*'` 让所有域名都不走代理，直连即可）

**2. `Cannot create directory /root/.android`**
只有以 root（或 HOME 不对）执行时才出现，指定用户目录即可：
```bash
ANDROID_USER_HOME=/home/todd/.android ./gradlew assembleDebug -Duser.home=/home/todd
```

**3. release 包需要签名**
`android/app/build.gradle` 读 `android/app/keystore.properties` +
`android/app/keystore/free-koodo-reader.jks`；没有就只能出 debug 签名包。

## 五、重要：APK 里没有的功能

Capacitor 壳里**没有 `window.electronAPI`**，以下功能在手机上是断的：

| 功能 | 依赖 | APK 内状态 |
|---|---|---|
| 本地 AI 助手弹窗 | `ollama-chat` IPC | 不可用 |
| IndexTTS-2 生成语音 | `generate-tts` IPC（main 进程插件） | 不可用 |
| 多角色分析 | `ollama-analyze-roles` IPC | 不可用 |

也就是说 **多角色朗读目前只在桌面端可用**。

好消息是服务端 8972 本来就是 HTTP 接口，手机在同一局域网/p2wlan 里能直接访问。
若要手机也能朗读，改造方向是把 `ttsUtil.ts` 里 `window.electronAPI.invoke("generate-tts")`
换成浏览器 `fetch` 直连 `http://<3090主机>:8972/tts`，并把 `/analyze` 同理直连 ——
不需要 Electron 主进程，也不需要 Capacitor 插件。
