const path = require("path");
const fs = require("fs");
const axios = require("axios");

// 语音名称 -> 参考音色（wav-sample 下的文件名）通过 config.ref 传入。
// 远端 GPU 场景下 config.url 由渲染端从 ttsServerUrl 注入，
// 例如 http://10.20.0.2:8972/tts；config.token 对应服务的 INDEXTTS_TOKEN。

const getAudioPath = async (text, speed, dirPath, config) => {
  const audioName =
    new Date().getTime() + "-" + Math.random().toString(36).slice(2, 7);
  const ttsDir = path.join(dirPath, "tts");
  if (!fs.existsSync(ttsDir)) {
    fs.mkdirSync(ttsDir, { recursive: true });
  }
  const { data, ext } = await getTTSAudio(text, config);
  const audioPath = path.join(ttsDir, audioName + ext);
  fs.writeFileSync(audioPath, data);
  return audioPath;
};

const getTTSAudio = async (text, config) => {
  const url = config.url || "http://127.0.0.1:8972/tts";
  const ref = config.ref || "voice_01";
  const headers = { "Content-Type": "application/json" };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  const payload = { text, ref };
  // 可选：mp3 能显著减小跨网传输体积；emo 为 8 维情绪向量
  if (typeof config.format === "string") {
    payload.format = config.format;
  }
  if (Array.isArray(config.emo) && config.emo.length === 8) {
    payload.emo = config.emo;
    if (typeof config.emoWeight === "number") {
      payload.emoWeight = config.emoWeight;
    }
  }
  const response = await axios.post(url, payload, {
    responseType: "arraybuffer",
    timeout: 180000,
    headers,
    // 不要走系统代理：这个请求的目标可能是局域网 / p2wlan 里的机器，
    // 走本地代理会被转发成绝对 URI，甚至直接把私有地址拦掉。
    proxy: false,
  });
  const contentType = String(response.headers["content-type"] || "");
  const ext = contentType.includes("mpeg")
    ? ".mp3"
    : contentType.includes("ogg")
    ? ".ogg"
    : ".wav";
  return { data: Buffer.from(response.data), ext };
};

module.exports = { getAudioPath };
