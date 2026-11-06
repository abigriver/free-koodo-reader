const path = require("path");
const fs = require("fs");
const axios = require("axios");

const getAudioPath = async (text, speed, dirPath, config) => {
  console.log(
    "[IndexTTS2] getAudioPath config=",
    JSON.stringify(config),
    "text=",
    (text || "").slice(0, 20)
  );
  let audioName = new Date().getTime() + ".wav";
  const ttsDir = path.join(dirPath, "tts");
  if (!fs.existsSync(ttsDir)) {
    fs.mkdirSync(ttsDir, { recursive: true });
  }
  const audio = await getTTSAudio(text, config);
  fs.writeFileSync(path.join(ttsDir, audioName), audio);
  return path.join(ttsDir, audioName);
};

const getTTSAudio = async (text, config) => {
  const url = config.url || "http://127.0.0.1:8972/tts";
  const ref = config.ref || "voice_01";
  return new Promise((resolve, reject) => {
    axios
      .post(
        url,
        { text, ref },
        { responseType: "arraybuffer", timeout: 180000 }
      )
      .then((response) => resolve(response.data))
      .catch((error) => reject(error));
  });
};

module.exports = { getAudioPath };
