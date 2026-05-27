import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export const config = {
  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",

  // 智谱 (for image vision)
  visionApiKey: process.env.VISION_API_KEY || "",
  visionModel: process.env.VISION_MODEL || "glm-4.6v-flash",

  // Bot identity
  aiName: process.env.AI_NAME || "阿杰",
  userName: process.env.USER_NAME || "你",

  // Whitelist
  aliasWhitelist: (process.env.ALIAS_WHITELIST || "")
    .split(",").map(s => s.trim()).filter(Boolean),
  roomWhitelist: (process.env.ROOM_WHITELIST || "")
    .split(",").map(s => s.trim()).filter(Boolean),
  triggerKeyword: process.env.TRIGGER_KEYWORD || "",

  // Behavior
  replyDelayMin: parseInt(process.env.REPLY_DELAY_MIN || "3", 10),
  replyDelayMax: parseInt(process.env.REPLY_DELAY_MAX || "15", 10),
  contextWindow: parseInt(process.env.CONTEXT_WINDOW || "50", 10),
  quietStart: process.env.QUIET_START || "23:00",
  quietEnd: process.env.QUIET_END || "08:00",
  proactiveChance: parseFloat(process.env.PROACTIVE_CHANCE || "0.02"),
  persona: process.env.PERSONA || "brother",
};

export function isQuietTime() {
  // 如果未配置或设为 "off"，则不禁用
  if (!config.quietStart || !config.quietEnd || config.quietStart === "off") return false;

  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { quietStart, quietEnd } = config;

  if (quietStart <= quietEnd) {
    return current >= quietStart && current <= quietEnd;
  }
  return current >= quietStart || current <= quietEnd;
}

export function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}
