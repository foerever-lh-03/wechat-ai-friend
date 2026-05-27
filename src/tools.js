/**
 * Agent 工具集：web 搜索
 * 采用多引擎 fallback 策略，适配国内网络环境
 */

import { buildImageFacts } from "./persona.js";

/**
 * 从 HTML 中提取文本（去标签）
 */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 搜索：依次尝试多个引擎
 */
async function webSearch(query) {
  const engines = [
    () => searchBing(query),
    () => searchSogou(query),
  ];

  for (const engine of engines) {
    try {
      const result = await engine();
      if (result && result.length > 20) return result;
    } catch (e) {
      // 继续下一个引擎
    }
  }
  return null;
}

/** Bing 搜索 */
async function searchBing(query) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-cn&ensearch=0`;
  const html = await httpGet(url);
  if (!html) return null;

  const results = [];
  // 提取搜索结果摘要
  const blocks = html.split('<li class="b_algo"');
  for (let i = 1; i < Math.min(blocks.length, 7); i++) {
    const text = stripHtml(blocks[i]).substring(0, 200);
    if (text.length > 10) results.push(text);
  }
  return results.length > 0 ? results.join("\n").substring(0, 1200) : null;
}

/** 搜狗搜索 */
async function searchSogou(query) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const html = await httpGet(url);
  if (!html) return null;

  const results = [];
  const blocks = html.split('class="vrwrap"');
  for (let i = 1; i < Math.min(blocks.length, 7); i++) {
    const text = stripHtml(blocks[i]).substring(0, 200);
    if (text.length > 10) results.push(text);
  }
  return results.length > 0 ? results.join("\n").substring(0, 1200) : null;
}

/** HTTP GET 带浏览器 UA */
async function httpGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "当对方问到需要实时信息、新闻、数据或你不确定的事实时，搜索互联网获取准确答案。用中文关键词搜索。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，简洁准确的中文" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "当对方想看某样东西的照片/图片/样子时，生成一张AI图片发给对方。比如对方说'看看你的猫''发张图看看''长什么样''有照片吗'，你就调用这个工具生成对应的图片。用中文描述要生成的画面，越具体越好。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "图片描述，具体描述画面内容、风格、构图。例如'一只橘猫躺在电脑键盘上，室内温馨光线'。" },
        },
        required: ["prompt"],
      },
    },
  },
];

// 存储最近一次生成的图片（URL或本地路径，bot.js 读取后发送）
let lastImageUrl = null;

export function consumeGeneratedImage() {
  const url = lastImageUrl;
  lastImageUrl = null;
  return url;
}

/** 查看是否有生成的图片待发送（不消费），用于判断模型是否调用了 generate_image */
export function peekGeneratedImage() {
  return lastImageUrl;
}

/** bot.js 直接注入图片（模型不配合工具调用时兜底） */
export function _setGeneratedImage(urlOrPath) {
  lastImageUrl = urlOrPath;
}

export async function executeTool(name, args, chatEngine) {
  if (name === "web_search") return await webSearch(args.query);
  if (name === "generate_image") {
    if (!chatEngine) return "图片生成功能暂不可用";
    try {
      // 注入宠物外观事实，确保每次生成的图片外观一致
      let imagePrompt = args.prompt;
      const petFacts = buildImageFacts();
      if (petFacts && (imagePrompt.includes("猫") || imagePrompt.includes("咪咪") || imagePrompt.includes("宠物"))) {
        imagePrompt = `${imagePrompt}。注意：必须严格按以下外观生成：${petFacts}`;
        console.log(`[tools] 注入宠物事实到图片prompt`);
      }
      const url = await chatEngine.generateImage(imagePrompt);
      if (url) {
        lastImageUrl = url;
        return `图片已生成，请在回复中自然地提及这幅图（但不要重复图片描述），用户会在你的消息之后看到这幅图。`;
      }
      return "图片生成失败，用文字简单描述一下对方想看的东西吧";
    } catch (e) {
      return `图片生成失败: ${e.message}`;
    }
  }
  return null;
}
