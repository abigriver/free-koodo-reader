import { Howl } from "howler";
import PluginModel from "../../models/Plugin";
import { getAllVoices, getFormatFromAudioPath } from "../common";
import { isElectron } from "react-device-detect";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

class TTSUtil {
  static player: any;
  static audioPaths: { index: number; audioPath: string }[] = [];
  static isPaused: boolean = false;
  static pausedMidSentence: boolean = false;
  static processingIndexes: Set<number> = new Set();
  static generation: number = 0;
  static async readAloud(currentIndex: number) {
    // 清理比当前 index 小 10 的已朗读缓存
    this.audioPaths = this.audioPaths.filter(
      (item) => item.index >= currentIndex - 10
    );
    return new Promise<string>(async (resolve) => {
      let audioPath = this.audioPaths.find(
        (item) => item.index === currentIndex
      )?.audioPath;
      if (!audioPath) {
        resolve("loaderror");
        return;
      }
      var sound = new Howl({
        src: [audioPath],
        format: [getFormatFromAudioPath(audioPath)],
        onloaderror: () => {
          resolve("loaderror");
        },
        onload: async () => {
          this.player.play();
          resolve("load");
        },
      });
      this.player = sound;
    });
  }
  static async cacheAudio(
    startIndex: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    targetCacheCount: number,
    isFirst: boolean,
    isOfficialAIVoice: boolean
  ) {
    this.isPaused = false;

    if (isOfficialAIVoice) {
      const cacheCount = Math.min(
        targetCacheCount,
        audioNodeList.length - startIndex
      );
      // 并发执行，并发数量为3，但保证添加顺序
      const CONCURRENT_LIMIT = 10;
      //删除index小于startIndex的缓存
      this.audioPaths = this.audioPaths.filter(
        (item) => item.index >= startIndex - 5
      );

      for (let i = 0; i < cacheCount; i += CONCURRENT_LIMIT) {
        const batch: any[] = [];

        for (let j = 0; j < CONCURRENT_LIMIT && i + j < cacheCount; j++) {
          const index = startIndex + i + j;
          if (index >= audioNodeList.length) break;

          // 如果已经缓存过或正在处理中，跳过
          if (
            this.audioPaths.find((item) => item.index === index) ||
            this.processingIndexes.has(index)
          ) {
            continue;
          }

          // 标记为正在处理
          this.processingIndexes.add(index);

          const audioNode = audioNodeList[index];
          let plugin = plugins.find(
            (item) => item.key === audioNode.voiceEngine
          );
          if (!plugin) {
            return "error";
          }
          let voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          if (!voice) {
            return "error";
          }
          // 创建异步任务
          const task = this.getAudioPath(
            audioNode.text,
            speed,
            audioNode.voiceEngine,
            plugin,
            voice,
            isFirst
          )
            .then(async (res) => {
              // 处理完成后，从处理集合中移除
              this.processingIndexes.delete(index);
              if (res) {
                return { index, audioPath: res };
              } else {
                this.isPaused = true;
                return null;
              }
            })
            .catch((error) => {
              // 出错时也要从处理集合中移除
              this.processingIndexes.delete(index);
              console.error(`Error caching audio for index ${index}:`, error);
              return null;
            });
          batch.push(task);
        }

        // 等待当前批次完成
        const batchResults = await Promise.all(batch);

        // 将结果存储到 Map 中
        for (const result of batchResults) {
          if (result) {
            if (this.audioPaths.find((item) => item.index === result.index)) {
              this.audioPaths = this.audioPaths.map((item) => {
                if (item.index === result.index) {
                  return result;
                } else {
                  return item;
                }
              });
            } else {
              this.audioPaths.push(result);
            }
          } else {
            this.isPaused = true;
            return "error";
          }
        }
      }
    } else {
      let maxCacheIndex = Math.min(
        startIndex + targetCacheCount,
        audioNodeList.length
      );
      for (let index = startIndex; index < maxCacheIndex; index++) {
        if (this.isPaused) {
          break;
        }
        // 如果已经缓存过或正在处理中，跳过
        if (
          this.audioPaths.find((item) => item.index === index) ||
          this.processingIndexes.has(index)
        ) {
          continue;
        }
        // 标记为正在处理
        this.processingIndexes.add(index);
        const audioNode = audioNodeList[index];
        let plugin = plugins.find((item) => item.key === audioNode.voiceEngine);
        if (!plugin) {
          console.error(
            "[TTS诊断] 找不到插件: engine=",
            audioNode.voiceEngine,
            " 可用插件=",
            plugins.map((p) => p.key + ":" + p.type)
          );
          return "error";
        }
        let voice = (plugin.voiceList as any[]).find(
          (voice) => voice.name === audioNode.voiceName
        );
        if (!voice) {
          console.error(
            "[TTS诊断] 找不到音色: name=",
            audioNode.voiceName,
            " 插件=",
            plugin.key,
            " 可用音色=",
            (plugin.voiceList as any[]).map((v) => v.name)
          );
          return "error";
        }
        const gen = this.generation;
        let audioPath = await this.getAudioPath(
          audioNode.text,
          speed,
          audioNode.voiceEngine,
          plugin,
          voice,
          isFirst
        );
        // 处理完成后，从处理集合中移除
        this.processingIndexes.delete(index);
        if (gen !== this.generation) {
          // 语音已切换，丢弃过期结果
          break;
        }
        if (audioPath) {
          this.audioPaths.push({ index: index, audioPath: audioPath });
        } else {
          this.isPaused = true;
          break;
        }
      }
    }
  }
  static async pauseAudio() {
    if (this.player) {
      this.player.pause();
      this.isPaused = true;
      this.pausedMidSentence = true;
    }
  }
  static resumeAudio(): boolean {
    if (this.player && this.pausedMidSentence) {
      this.player.play();
      this.isPaused = false;
      this.pausedMidSentence = false;
      return true;
    }
    return false;
  }
  static async stopAudio() {
    if (this.player && this.player.stop) {
      this.player.stop();
      this.isPaused = true;
      this.pausedMidSentence = false;
      setTimeout(() => {
        this.clearAudioPaths();
        this.audioPaths = [];
        this.processingIndexes.clear();
      }, 1000);
    }
  }
  static async clearAudioPaths() {
    if (!isElectron) return;
    window.electronAPI.invoke("clear-tts").catch(() => {
      /* best-effort cleanup; failure is not user-actionable */
    });
  }
  static getAudioPaths() {
    return this.audioPaths;
  }
  static async getAudioPath(
    text: string,
    speed: number,
    voiceEngine: string,
    plugin,
    voice,
    isFirst: boolean
  ) {
    // 三层覆盖，后者优先：
    //   1) 插件自身配置（设置 → 插件 → Edit，可改 url / token / format）
    //   2) 音色配置（catalog 里每个 voice 的 ref）
    //   3) 全局覆盖（配置项 ttsServerUrl / ttsServerToken，适合不想动插件的人）
    // 远端 GPU 场景下 url 指向另一台机器的 IndexTTS-2 服务，
    // 例如 p2wlan 里的 http://10.20.0.2:8972/tts。全空则退回插件默认的 127.0.0.1。
    const remoteUrl = ConfigService.getReaderConfig("ttsServerUrl");
    const token = ConfigService.getReaderConfig("ttsServerToken");
    const pluginConfig =
      plugin && plugin.config && typeof plugin.config === "object"
        ? plugin.config
        : {};
    const config = {
      ...pluginConfig,
      ...(voice && voice.config ? voice.config : {}),
      ...(remoteUrl ? { url: remoteUrl } : {}),
      ...(token ? { token } : {}),
    };
    let audioPath = await window
      .electronAPI
      .invoke("generate-tts", {
        text: text,
        speed,
        pluginKey: plugin.key,
        config: config,
      });
    return audioPath;
  }
  static setAudioPaths() {
    this.audioPaths = [];
    this.processingIndexes.clear();
    this.pausedMidSentence = false;
    this.generation = (this.generation || 0) + 1;
  }
  static getPlayer() {
    return this.player;
  }
  static getVoiceList(plugins: PluginModel[]) {
    let voices = getAllVoices(plugins);

    return voices;
  }
}
export default TTSUtil;
