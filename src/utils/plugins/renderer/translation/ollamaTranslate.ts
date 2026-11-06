import type { TranslatePlugin } from "../../types";

declare var window: any;

export const translate: TranslatePlugin = async (
  text,
  from,
  to,
  axios,
  config
) => {
  if (config.url === "") {
    return "Error happened";
  }
  const transUrl = config.url || "http://127.0.0.1:11434/api/generate";
  const model = config.model || "llama3";
  const prompt = `${text} \ntranslate the above sentence to ${
    to === "en" || to === "Automatic" ? "English" : to
  }, and only return the content translated. no explanation.`;

  // Electron 下通过主进程请求，绕过浏览器 CORS 限制
  if (window.electronAPI && window.electronAPI.invoke) {
    try {
      return await window.electronAPI.invoke("ollama-translate", {
        url: transUrl,
        model,
        prompt,
      });
    } catch (error) {
      console.error("ollama translate via IPC failed", error);
      return "Error happened";
    }
  }

  const transRes = await axios.post(
    transUrl,
    { model, prompt, stream: false },
    { headers: { "Content-Type": "application/json" } }
  );
  if (transRes.status === 200) {
    return transRes.data.response;
  } else {
    return "Error happened";
  }
};
