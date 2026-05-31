import { createRequire } from "node:module";
import { createBot } from "./bot.js";
import { config } from "../config/index.js";
import { loadPersona, listPersonas } from "./persona.js";

let botInstance = null;

// Monkey-patch wechat4u assert.equal — 微信 API 在 session 预热期返回 1205
// wechat4u 将其视为 fatal 并无限重试，导致 bot 永远卡在初始化
// 这里将 1205 降级为 warn，让同步继续进行
function patchWechat4u() {
  try {
    const req = createRequire(import.meta.url);
    const globalMod = req.resolve("wechat4u/lib/util/global.js");
    const mod = req(globalMod);
    const origEqual = mod.assert.equal;
    mod.assert.equal = function (actual, expected, response) {
      if (actual === 1205 && expected === 0) {
        console.warn("[patch] wechat4u assert.equal(1205, 0) 降级为 warn，跳过");
        return;
      }
      return origEqual.call(this, actual, expected, response);
    };
    console.log("[patch] wechat4u assert.equal 已热修复");
  } catch (e) {
    console.warn("[patch] wechat4u 热修复失败:", e.message);
  }
}
patchWechat4u();

async function main() {
  console.log("====================================");
  console.log("  WeChat AI 好友");
  console.log("  24小时在线 AI 聊天机器人");
  console.log("====================================");
  console.log();

  // 检查配置
  if (!config.deepseekApiKey) {
    console.error("[error] 请先在 .env 中配置 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  // 加载人设
  const persona = await loadPersona(config.persona);
  console.log(`[config] AI名称: ${config.aiName}`);
  console.log(`[config] 人设: ${persona.name} - ${persona.description}`);
  console.log(`[config] 白名单: ${config.aliasWhitelist.length > 0 ? config.aliasWhitelist.join(", ") : "所有人"}`);
  console.log(`[config] 群聊: ${config.roomWhitelist.length > 0 ? config.roomWhitelist.join(", ") : "不回复群聊"}`);
  console.log(`[config] 触发词: ${config.triggerKeyword || "全部触发"}`);

  // 列出可用人设
  const personas = listPersonas();
  console.log(`[config] 可用人设: ${personas.map(p => p.name).join(", ")}`);
  console.log();

  // 启动机器人
  const { bot } = await createBot();
  botInstance = bot;
  console.log("[bot] 正在启动...\n");
  await bot.start();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});

// 优雅退出——必须先 stop bot 再退出，否则 session 可能丢失
async function gracefulExit(signal) {
  console.log(`\n[exit] 收到 ${signal}，正在保存数据...`);
  try {
    if (botInstance) {
      // 强制保存 memory-card 到磁盘（不调用 stop，避免向微信发登出请求废掉 session）
      if (botInstance.memory && typeof botInstance.memory.save === "function") {
        await botInstance.memory.save();
        console.log("[exit] session 已保存");
      }
      // 直接断开 puppet 不登出
      if (botInstance.puppet) {
        await botInstance.puppet.stop();
      }
    }
  } catch (e) {
    console.error("[exit] 保存失败:", e.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));
