import { WechatyBuilder, types } from "wechaty";
import { FileBox } from "file-box";
import { config, isQuietTime, randomDelay } from "../config/index.js";
import { ChatEngine } from "./chat.js";
import { MemoryManager } from "./memory.js";
import { loadPersona, buildSystemPrompt, getFewShotMessages, getTimeContext, buildImageFacts } from "./persona.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StickerManager } from "./sticker.js";
import { EmotionTracker } from "./emotion.js";
import { ReminderManager } from "./reminder.js";
import { consumeGeneratedImage, peekGeneratedImage, _setGeneratedImage } from "./tools.js";
import { SelfStateTracker } from "./self-state.js";
import { readJSONL } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTED_FILE = path.resolve(__dirname, "..", "data", "contacted.json");

/** 持久化 contactedFriends 到磁盘，handleMessage 和 createBot 都需调用 */
function saveContactedFriends(map) {
  const data = [];
  for (const [id, info] of map) {
    data.push({ id, name: info.name });
  }
  try { fs.writeFileSync(CONTACTED_FILE, JSON.stringify(data), "utf-8"); } catch {}
}

// 记录最近发过的图片描述 → 下次回复时注入上下文，避免模型乱编
const recentImagePrompt = new Map();

/**
 * 解析收到的消息，将 emoji/表情包 XML 转为可读文字
 */
// 模型可能发明的 emoji 名 → 微信真实 emoji 名（发前修复）
const EMOJI_ALIAS = {
  doge: "旺柴", 狗头: "旺柴",  dog: "旺柴",
  笑哭: "捂脸", 笑cry: "捂脸", 笑死: "捂脸",
  白眼: "白眼", 翻白眼: "白眼",
  吃瓜群众: "吃瓜", 围观: "吃瓜",
  破涕为笑: "捂脸", 破涕: "捂脸",
  裂开了: "裂开", 裂开: "裂开",
  苦涩: "委屈", 苦: "委屈",
  保佑: "合十", 祈祷: "合十",
};

function fixEmojiAliases(text) {
  return text.replace(/\[([^\]]+)\]/g, (match, name) => {
    const fixed = EMOJI_ALIAS[name];
    return fixed ? `[${fixed}]` : match;
  });
}

// 模型输出的 emoji → 📎表情包关键词（除纯确认用的4个外，其余全部转贴图）
const EMOJI_TO_STICKER = {
  嘿哈: "好笑", 呲牙: "好笑", 偷笑: "好笑", 憨笑: "好笑", 愉快: "好笑", 机智: "好笑",
  坏笑: "好笑", 吐: "好笑", 调皮: "好笑", 抠鼻: "好笑", 阴险: "好笑",
  捂脸: "无语", 裂开: "无语", 擦汗: "无语", 尴尬: "无语", 流汗: "无语",
  发怒: "生气", 鄙视: "生气", 敲打: "生气", 抓狂: "生气", 菜刀: "生气", 白眼: "生气",
  旺柴: "吃瓜", 惊讶: "吃瓜", 发呆: "吃瓜", 吓: "吃瓜", 惊恐: "吃瓜",
  流泪: "哭", 大哭: "哭", 委屈: "哭", 快哭了: "哭", 可怜: "哭", 凋谢: "哭",
  爱心: "爱心", 亲亲: "爱心", 拥抱: "爱心", 玫瑰: "爱心", 色: "爱心",
  强: "赞", 鼓掌: "赞", 奋斗: "赞", 加油: "赞", 耶: "赞", 转圈: "赞", 跳跳: "赞",
  困: "睡觉", 睡: "睡觉", 哈欠: "睡觉", 月亮: "睡觉",
  微笑: "好笑", 吃瓜: "吃瓜",
};

function convertEmojiToSticker(text) {
  return text.replace(/\[([^\]]+)\]/g, (match, name) => {
    // 纯确认用的4个保留，其余转📎
    if (name === "OK" || name === "好的" || name === "握手" || name === "抱拳") {
      return match;
    }
    const kw = EMOJI_TO_STICKER[name];
    if (kw) {
      console.log(`[emoji-convert] [${name}] → 📎${kw}`);
      return `📎${kw}`;
    }
    // 未知 emoji → 去掉（可能是模型幻觉）
    console.log(`[emoji-convert] 未知emoji [${name}] 已移除`);
    return "";
  });
}

function parseIncoming(msg) {
  const msgType = msg.type();
  const rawText = msg.text() || "";

  // 表情包 vs 图片 分开标记，避免模型把表情包当成截图/视频
  if (msgType === types.Message.Emoticon) return "[发了一个表情包]";
  if (msgType === types.Message.Image) return "[收到一张图片]";

  // 撤回消息：剔除 XML，只留标记。对方撤回通常是想重发，别追问
  if (rawText.includes("<sysmsg") && rawText.includes("revokemsg")) {
    let cleaned = rawText.replace(/<sysmsg\s[^>]*type\s*=\s*["']?revokemsg["']?[\s\S]*?<\/sysmsg>/gi, "");
    cleaned = cleaned.replace(/<[^>]+>/g, "").trim();
    if (!cleaned) return "[对方撤回了一条消息]";
    return `${cleaned}；[对方撤回了一条消息]`;
  }

  // 文本消息中可能夹杂 emoji XML，清洗并提取
  if (rawText.includes("<emoji") || rawText.includes("emoji emoji")) {
    let cleaned = rawText;
    // 提取所有 emoji 文字描述
    const emojis = [];
    cleaned = cleaned.replace(/<img class="(?:qq)?emoji [^"]*" text="\[([^\]]+)\][^"]*"[^>]*\/?>/gi, (_, name) => {
      emojis.push(`[${name}]`);
      return `[${name}]`;
    });
    cleaned = cleaned.replace(/<span class="emoji [^"]*"><\/span>/gi, (match) => {
      const codeMatch = match.match(/emoji([0-9a-f]+)/i);
      if (codeMatch) emojis.push(`[微信emoji:${codeMatch[1]}]`);
      return "";
    });
    cleaned = cleaned.replace(/<msg>.*?<\/msg>/gi, "");
    cleaned = cleaned.replace(/<[^>]+>/g, "").trim();
    if (!cleaned && emojis.length > 0) return emojis.join("");
    if (emojis.length > 0 && cleaned) return `${cleaned} ${emojis.join("")}`;
    return cleaned || rawText;
  }

  // 引用/回复消息：提取被引用原文，让 bot 理解对方在回复什么
  // WeChat 引用格式: <appmsg ...><type>57</type><des>被引用的内容</des>...</appmsg>
  if (rawText.includes("<appmsg") && rawText.includes("<type>57</type>")) {
    const desMatch = rawText.match(/<des>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)<\/des>/i)
                  || rawText.match(/<des>([\s\S]*?)<\/des>/i);
    const quoted = desMatch ? desMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    // 去除整个 appmsg XML 块，保留回复文字
    let replyText = rawText.replace(/<appmsg[\s\S]*?<\/appmsg>/gi, "").replace(/<[^>]+>/g, "").trim();
    if (quoted) {
      return replyText
        ? `[对方引用了你的消息: "${quoted}"] 然后说: ${replyText}`
        : `[对方引用了你的消息: "${quoted}"]`;
    }
    return replyText || rawText.replace(/<[^>]+>/g, "").trim();
  }

  return rawText;
}

export async function createBot() {
  const persona = await loadPersona(config.persona);
  const chatEngine = new ChatEngine(config);
  const memory = new MemoryManager(config.contextWindow);
  memory.setChatEngine(chatEngine);
  const stickerMgr = new StickerManager();
  const emotionTracker = new EmotionTracker();
  const reminderMgr = new ReminderManager();
  const selfState = new SelfStateTracker();

  const bot = WechatyBuilder.build({
    name: "wechat-ai-friend",
    puppet: "wechaty-puppet-wechat4u",
    puppetOptions: {},
  });

  bot.on("scan", (qrcode, status) => {
    console.log(`\n[${status}] 请扫描二维码登录微信:`);
    console.log(`https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`);
    console.log(`\n或直接访问: ${qrcode}\n`);
  });

  // 已聊过的好友集合（用于主动消息选人）
  const contactedFriends = new Map(); // friendId -> { name, target }

  bot.on("login", async (user) => {
    console.log(`\n[login] 已登录: ${user.name()} (${user.id})\n`);

    // 等待 3 秒让 WeChat puppet 同步联系人数据，避免 bot.Contact.find() 全返回 null
    await new Promise(r => setTimeout(r, 3000));

    // 从历史恢复已聊过的好友（重启后 contactedFriends 为空导致主动消息无法选人）
    try {
      let restored = 0;
      // 方式1：从 contacted.json 恢复（按 ID 查找，最可靠）
      if (fs.existsSync(CONTACTED_FILE)) {
        const list = JSON.parse(fs.readFileSync(CONTACTED_FILE, "utf-8"));
        for (const { id, name } of list) {
          try {
            const contact = await bot.Contact.find({ id });
            if (contact) { contactedFriends.set(id, { name, target: contact }); restored++; }
          } catch { /* contact may not be available yet */ }
        }
      }
      // 方式2：兜底 — 扫描 data/*.jsonl，用 findAll 匹配名称
      if (contactedFriends.size === 0) {
        const dataDir = path.resolve(__dirname, "..", "data");
        const jsonlNames = new Set(
          fs.readdirSync(dataDir).filter(f => f.endsWith(".jsonl") && !f.includes("self_state")).map(f => f.replace(".jsonl", ""))
        );
        if (jsonlNames.size > 0) {
          try {
            const allContacts = await bot.Contact.findAll();
            for (const contact of allContacts) {
              const id = contact.id || "";
              if (id.startsWith("gh_")) continue;
              // 过滤公众号/系统账号
              try { if (contact.type() === types.Contact.Official) continue; } catch {}
              const name = contact.name();
              if (name === "微信团队" || name === "weixin") continue;
              if (jsonlNames.has(name)) {
                contactedFriends.set(id, { name, target: contact });
                restored++;
              }
            }
          } catch { console.log("[restore] Contact.findAll 不可用，等待主动聊天"); }
        }
      }
      if (contactedFriends.size > 0) {
        saveContactedFriends(contactedFriends);
        const names = [...contactedFriends.values()].map(v => v.name).join(", ");
        console.log(`[restore] 已恢复 ${contactedFriends.size} 个好友: ${names}`);
      } else {
        console.log("[restore] 暂无历史好友，等待首次聊天后自动记录");
      }
    } catch (e) { console.warn("[restore] 恢复好友失败:", e.message); }
    // 启动主动聊天定时器
    startProactiveScheduler(bot, persona, chatEngine, memory, stickerMgr, contactedFriends, selfState);
    // 心跳日志（每5分钟，确认 bot 存活）
    setInterval(() => {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      console.log(`[heartbeat] ${timeStr} 运行中`);
    }, 300000);

    // 定时检查提醒（每30秒）
    setInterval(async () => {
      const due = reminderMgr.getDue();
      for (const r of due) {
        try {
          const contact = await bot.Contact.find({ id: r.friendId });
          if (contact) {
            await contact.say(`⏰ ${r.message}`);
            console.log(`[reminder] 已发送: ${r.friendName} - "${r.message}"`);
          }
        } catch (e) {
          console.error(`[reminder] 发送失败: ${r.friendName}`, e.message);
        }
      }
    }, 30000);

    // 每日总结调度器（23:55 执行）
    scheduleDailySummary(memory, contactedFriends);
  });

  bot.on("logout", (user) => {
    console.log(`[logout] ${user.name()} 已登出`);
  });

  bot.on("error", (e) => {
    console.error("[bot error]", e.message || String(e));
    if (e.stack) console.error(e.stack);
  });

  bot.on("message", async (msg) => {
    try {
      await handleMessage(msg, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState, contactedFriends);
    } catch (e) {
      console.error("[message handler error]", e.message);
    }
  });

  return { bot, persona, chatEngine, memory, stickerMgr, emotionTracker };
}

async function handleMessage(msg, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState, contactedFriends) {
  if (msg.self()) return;

  const talker = msg.talker();
  // 过滤公众号/服务号：types.Contact.Official 不一定覆盖所有情况
  if (talker.type() === types.Contact.Official) return;
  try {
    const wid = talker.payload?.weixin || talker.id || "";
    if (wid.startsWith("gh_")) return; // 公众号 ID
  } catch {}
  const room = msg.room();
  let text = parseIncoming(msg);

  // 图片消息：尝试下载图片用于视觉识别
  const msgType = msg.type();
  if (msgType === types.Message.Image || msgType === types.Message.Attachment || msgType === types.Message.Emoticon) {
    const isEmoticon = msgType === types.Message.Emoticon;
    console.log(`[image] ${talker.name()}: 收到${isEmoticon ? "表情包" : "图片"}，尝试下载...`);
    let imageBase64 = null;
    let imageBuffer = null;
    let imageMime = "image/jpeg";
    let downloaded = false;

    // 策略1: 标准路径 toFileBox → puppet.messageFile
    try {
      const fileBox = await msg.toFileBox();
      const buffer = await fileBox.toBuffer();
      if (buffer.length > 0) {
        imageBuffer = buffer;
        imageBase64 = buffer.toString("base64");
        imageMime = fileBox.mediaType || imageMime;
        console.log(`[image] ✅ 下载成功! 大小: ${buffer.length} bytes, 类型: ${imageMime}`);
        downloaded = true;
      } else {
        console.log(`[image] ⚠️ toFileBox 返回空数据`);
      }
    } catch (e) {
      console.log(`[image] ⚠️ toFileBox 失败: ${e.message.substring(0, 100)}`);
    }

    // 策略2: Emoticon/Image 回退 — 绕过 puppet 的 FileBox 包装，直接调 wechat4u.getMsgImg()
    // messageFile() 对 Emoticon 走 FileBox.fromUrl(cdnurl) 可能因防盗链失败
    // messageImage() 内部 FileBox.fromStream 处理 arraybuffer 有兼容问题
    // 所以直接拿 wechat4u 实例 → getMsgImg(MsgId) → FileBox.fromBuffer
    if (!downloaded && bot.puppet && bot.puppet.wechat4u) {
      try {
        console.log(`[image] 尝试 getMsgImg 直接调用回退...`);
        const result = await bot.puppet.wechat4u.getMsgImg(msg.id);
        if (result && result.data && result.data.length > 0) {
          const { FileBox } = await import("file-box");
          const fileBox = FileBox.fromBuffer(result.data, `msg_${msg.id}.jpg`);
          const buffer = await fileBox.toBuffer();
          if (buffer.length > 0) {
            imageBuffer = buffer;
            imageBase64 = buffer.toString("base64");
            imageMime = result.type || fileBox.mediaType || "image/jpeg";
            console.log(`[image] ✅ getMsgImg 直调成功! 大小: ${buffer.length} bytes, 类型: ${imageMime}`);
            downloaded = true;
          }
        } else {
          console.log(`[image] ⚠️ getMsgImg 返回空数据`);
        }
      } catch (e2) {
        console.log(`[image] ⚠️ getMsgImg 直调失败: ${e2.message.substring(0, 100)}`);
      }
    }

    // 用户表情包 → AI打标后缓存复用（MD5去重）
    if (imageBase64 && msgType === types.Message.Emoticon && chatEngine.tagSticker) {
      try {
        const crypto = await import("node:crypto");
        const fullMd5 = crypto.createHash("md5").update(imageBuffer).digest("hex");
        const shortHash = fullMd5.substring(0, 8);

        // 内容去重：相同MD5不再重复保存
        if (stickerMgr.hasStickerByMD5(fullMd5)) {
          console.log(`[sticker] 重复表情包跳过 (MD5: ${shortHash})`);
        } else {
          const ext = imageMime.includes("gif") ? "gif" : "jpg";
          const stickerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "stickers");
          fs.mkdirSync(stickerDir, { recursive: true });
          const stickerPath = path.join(stickerDir, `user_${Date.now()}_${shortHash}.${ext}`);
          fs.writeFileSync(stickerPath, imageBuffer);
          const tags = await chatEngine.tagSticker(imageBase64, ext === "gif" ? "image/gif" : "image/jpeg");
          if (tags && tags.keywords && tags.keywords.length > 0) {
            stickerMgr.addUserSticker(stickerPath, tags.keywords, fullMd5);
          } else {
            // 打标失败，删除文件
            try { fs.unlinkSync(stickerPath); } catch {}
          }
        }
      } catch (e) {
        console.log(`[sticker-cache] 用户表情包缓存失败: ${e.message.substring(0, 80)}`);
      }
    }

    // 普通图片 → 视觉描述
    if (imageBase64 && msgType !== types.Message.Emoticon && chatEngine.describeImage) {
      try {
        const desc = await chatEngine.describeImage(imageBase64, "image/jpeg");
        if (desc) {
          console.log(`[vision] 识别结果: ${desc}`);
          text = text ? `${text} [对方发了一张图: ${desc}]` : `[对方发了一张图: ${desc}]`;
        }
      } catch (e) {
        console.log(`[vision] 识别失败: ${e.message.substring(0, 100)}`);
      }
    }

    if (!text || text.trim().length < 2) {
      text = text || "";
      if (!text.includes("[对方发了一张图")) text += "[对方发了一张图]";
    }
  }

  if (!text || text.trim().length === 0) return;

  const friendName = talker.name();
  const friendId = talker.id;

  // 记录好友（用于主动消息）—— 排除公众号
  if (!room && friendId && talker.type() !== types.Contact.Official) {
    try {
      const wid = talker.payload?.weixin || friendId || "";
      if (!wid.startsWith("gh_")) {
        contactedFriends.set(friendId, { name: friendName, target: talker });
        saveContactedFriends(contactedFriends);
      }
    } catch {
      contactedFriends.set(friendId, { name: friendName, target: talker });
      saveContactedFriends(contactedFriends);
    }
  }

  if (room) {
    const roomName = await room.topic();
    if (config.roomWhitelist.length > 0 && !config.roomWhitelist.includes(roomName)) {
      return;
    }
    // 群聊每条都回（不限@）
    if (!text) return;
    await processAndReply(bot, room, roomName, text, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
    return;
  }

  if (config.aliasWhitelist.length > 0) {
    const alias = await talker.alias();
    if (!config.aliasWhitelist.includes(friendName) && !config.aliasWhitelist.includes(alias)) {
      console.log(`[filter] 非白名单用户: ${friendName}`);
      return;
    }
  }

  if (config.triggerKeyword && !text.startsWith(config.triggerKeyword)) {
    return;
  }

  // 发送后冷却期内 → 只缓冲，每收到新消息重置冷却计时
  if (cooldownBuf.has(friendName)) {
    const cb = cooldownBuf.get(friendName);
    cb.texts.push(text);
    console.log(`[cooldown] ${friendName}: 冷却缓冲 (${cb.texts.length}条)`);
    if (cb.timer) clearTimeout(cb.timer);
    cb.timer = setTimeout(() => {
      flushCooldown(friendName, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
    }, COOLDOWN_MS);
    return;
  }

  // 对方正在发送中 → 把消息交给 processAndReply 的 pending 队列
  if (busyTargets.has(friendName)) {
    busyTargets.get(friendName).push(text);
    console.log(`[busy] ${friendName}: 转交pending (${busyTargets.get(friendName).length}条)`);
    return;
  }

  // 消息合并窗口：快速连续发来的消息合并成一回合，AI 一次回复
  // 每次都重置定时器：清除旧的，设置新的，确保在最后一条消息后等满 DEBOUNCE_MS 再处理
  if (pendingTimers.has(friendName)) {
    clearTimeout(pendingTimers.get(friendName));
  } else {
    pendingBuffers.set(friendName, { target: talker, targetName: friendName, texts: [] });
    console.log(`[debounce] ${friendName}: 启动合并窗口 (${DEBOUNCE_MS}ms)`);
  }
  pendingBuffers.get(friendName).texts.push(text);
  console.log(`[debounce] ${friendName}: 合并缓冲 (${pendingBuffers.get(friendName).texts.length}条)`);
  pendingTimers.set(friendName, setTimeout(() => {
    console.log(`[debounce] ${friendName}: 定时器触发，准备flush`);
    try {
      flushDebounced(friendName, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
    } catch (e) {
      console.error(`[debounce] ${friendName}: flush异常:`, e.message, e.stack);
    }
  }, DEBOUNCE_MS));
  return;
}

/**
 * 主动聊天调度器：每隔一段时间随机决定是否主动找好友聊天
 */
// 主动聊天话题池（不含"好久没联系"类死板话题——由时间间隔上下文自然驱动）
const PROACTIVE_TOPICS = [
  "（你突然想找朋友聊聊天，分享你今天遇到的一件小事。直接说内容，不要铺垫。）",
  "（你刷手机看到一个好笑的，想分享给朋友。说具体的趣事。）",
  "（你刚忙完一阵，想找人聊两句。轻松随意，别太正式。）",
  "（你刚下班/吃完饭，无聊想找人聊两句。抛个轻松的话题。）",
  "（你的猫刚做了个搞笑的事，想跟朋友分享一下。）",
  "（你突然想起之前聊过的某个话题，接着问一句。显得你一直惦记着。）",
  "（你看到一个好玩的梗/视频，想让朋友也看看。分享加一句吐槽。）",
  "（躺在沙发上发呆，突然想找人说两句话。随便说点啥。）",
  `（你现在有点无聊，拍了个日常想发给对方。配合时间：${getTimeContext()}）`,
];

// 发送锁：防止同一目标的消息穿插发送
const busyTargets = new Map(); // targetName -> string[] 缓冲消息

// 追踪每个好友最近的消息分类，用于检测"收尾"模式
const lastMsgType = new Map(); // targetName -> { type, count }

/** 将模型回复转为发送段：按语义边界拆分，多策略 fallback */
function splitReply(reply) {
  // 统一换行为 \n（处理 Windows \r\n）
  const normalized = reply.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 策略1: 空行分隔（模型用段落表达语义转折，最自然）
  let segments = normalized.split(/\n{2,}/).filter(s => s.trim());

  // 策略2: "" 显式分隔（兼容旧格式）
  if (segments.length <= 1) {
    segments = reply.split(/""/).filter(s => s.trim());
  }

  // 策略3: 句子边界拆分
  if (segments.length <= 1) {
    const text = segments[0] || reply;
    let raw = text.split(/(?<=[。！？])/).filter(s => s.trim());
    if (raw.length === 1 && raw[0].length > 18) {
      const parts = raw[0].split(/，/).filter(s => s.trim());
      if (parts.length >= 2) {
        if (parts[0].length <= 4 && parts.length >= 3) {
          parts[1] = parts[0] + "，" + parts[1];
          parts.shift();
        }
        raw = parts;
      }
    }
    if (raw.length >= 2) {
      segments = raw;
    }
  }

  if (segments.length === 0) return [reply];

  // 清理段首段尾的标点残留
  segments = segments.map(s => s.replace(/^[，。！？、""\s]+/, "").replace(/[，。！？、""\s]+$/, "").trim()).filter(s => s);

  // 超过3条 → 尾部收束到第3条
  if (segments.length > 3) {
    const last = segments.slice(2).join("，");
    return [segments[0], segments[1], last];
  }

  return segments;
}

/**
 * 检查表情包是否与关键词匹配（支持URL和本地文件）
 * candidate: { url } | { file, fromFile }
 * 返回 true 表示可以发送，false 表示该张不合适
 */
async function stickerTextMatch(candidate, keyword, chatEngine, replyContext = "") {
  try {
    let base64, mimeType;

    if (candidate.fromFile) {
      // 本地文件直接读取
      const buffer = fs.readFileSync(candidate.file);
      if (buffer.length === 0) return false;
      base64 = buffer.toString("base64");
      const extMatch = candidate.file.match(/\.(gif|png|jpg|jpeg|webp)/i);
      const ext = extMatch?.[1] || "jpg";
      const mimeMap = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      mimeType = mimeMap[ext] || "image/jpeg";
    } else {
      // URL下载
      const url = candidate.url;
      const https = await import("node:https");
      const buffer = await new Promise((resolve, reject) => {
        https.get(url, { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, { timeout: 6000 }, (r2) => {
              const chunks = [];
              r2.on("data", c => chunks.push(c));
              r2.on("end", () => resolve(Buffer.concat(chunks)));
            }).on("error", reject);
            return;
          }
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject);
      });

      base64 = buffer.toString("base64");
      const extMatch = url.match(/\.(gif|png|jpg|jpeg|webp)/i);
      const ext = extMatch?.[1] || "jpg";
      const mimeMap = { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      mimeType = mimeMap[ext] || "image/jpeg";
    }

    // 由视觉模型直接判断表情包是否匹配关键词
    const result = await chatEngine.readStickerText(base64, mimeType, keyword, replyContext);
    if (!result) {
      console.log(`[sticker-check] 视觉识别失败，跳过该张`);
      return false; // 不放行，换下一张
    }

    const text = (result.text || "").toLowerCase();
    const meaning = (result.meaning || "").toLowerCase();
    const match = result.match !== false; // 默认true（兼容旧格式）

    console.log(`[sticker-check] 文字:"${result.text}" 含义:"${result.meaning}" match:${match} reason:"${result.reason||""}"`);

    // 安全检查：即使模型说match，也要过一遍禁词
    const badWords = ["互赞", "互粉", "关注", "点赞", "转发", "抽奖", "广告", "加微信", "扫码", "下载", "求关注", "求点赞"];
    for (const w of badWords) {
      if (text.includes(w) || meaning.includes(w)) {
        console.log(`[sticker-check] ❌ 命中禁词"${w}"`);
        return false;
      }
    }


    if (!match) {
      console.log(`[sticker-check] ❌ 模型判断不匹配: ${result.reason || ""}`);
      return false;
    }

    console.log(`[sticker-check] ✅ 通过`);
    return true;
  } catch (e) {
    console.log(`[sticker-check] 检查异常: ${e.message}，跳过`);
    return false; // 异常不放行
  }
}

/** 发送表情包（含搜索+筛选+后备，逻辑统一复用） */
async function sendStickerForKeyword(target, keyword, stickerMgr, chatEngine, emotionCtx, replyContext = "") {
  const kw = normalizeKeyword(keyword);
  if (kw !== keyword) console.log(`[sticker-norm] "${keyword}" → "${kw}"`);

  const candidates = await stickerMgr.searchOnline(kw);
  if (candidates.length > 0) {
    let sent = false;
    // 优先尝试本地文件/用户表情包（免视觉检查），然后尝试缓存/在线（需视觉检查）
    const sorted = [
      ...candidates.filter(c => c.fromFile),
      ...candidates.filter(c => !c.fromFile),
    ];
    for (let i = 0; i < Math.min(sorted.length, 3); i++) {
      const c = sorted[i];
      // 本地文件/用户表情包免检；缓存和在线URL需要视觉验证
      const needCheck = !c.fromFile;
      const ok = needCheck ? await stickerTextMatch(c, kw, chatEngine, replyContext) : true;
      if (ok) {
        try {
          if (c.fromFile) {
            await target.say(FileBox.fromFile(c.file, c.filename));
            console.log(`[sticker-sent] ${keyword} → ${c.fromUser ? "用户表情包" : "本地文件"} ${c.filename}`);
          } else {
            await target.say(FileBox.fromUrl(c.url, c.filename));
            console.log(`[sticker-sent] ${keyword} → 第${i + 1}/${sorted.length}张`);
          }
          sent = true;
        } catch (e) { /* try next */ }
        if (sent) break;
      }
    }
    if (!sent) {
      const fallbackMap = {
        "吃饭": ["美食", "干饭"], "好笑": ["哈哈", "笑"], "无语": ["捂脸", "裂开"],
        "生气": ["怒", "无语"], "哭": ["伤心", "泪"], "赞": ["棒", "牛"],
        "摸鱼": ["偷懒", "躺平"], "爱心": ["比心", "亲亲"], "猫": ["萌宠", "喵"],
        "狗": ["萌宠", "汪"], "吃瓜": ["围观"], "偷懒": ["摸鱼", "躺平"],
      };
      const fallbacks = fallbackMap[kw] || [];
      let fallbackSent = false;
      for (const fbk of fallbacks) {
        console.log(`[sticker-fallback] "${kw}" → 后备"${fbk}"`);
        const fbc = await stickerMgr.searchOnline(fbk);
        if (fbc.length > 0) {
          for (let i = 0; i < Math.min(fbc.length, 2); i++) {
            const needCheck = !fbc[i].fromFile;
            const ok = needCheck ? await stickerTextMatch(fbc[i], fbk, chatEngine, replyContext) : true;
            if (ok) {
              try {
                if (fbc[i].fromFile) {
                  await target.say(FileBox.fromFile(fbc[i].file, fbc[i].filename));
                  console.log(`[sticker-sent] 后备"${fbk}" → ${fbc[i].fromUser ? "用户" : "本地"} ${fbc[i].filename}`);
                } else {
                  await target.say(FileBox.fromUrl(fbc[i].url, fbc[i].filename));
                  console.log(`[sticker-sent] 后备"${fbk}" → 第${i + 1}张`);
                }
                fallbackSent = true;
              } catch (e) { /* continue */ }
              if (fallbackSent) break;
            }
          }
        }
        if (fallbackSent) break;
      }
      if (!fallbackSent) {
        const emoji = emotionCtx ? contextEmoji(emotionCtx.emotion) : stickerMgr.search(kw);
        console.log(`[sticker-blocked] ${keyword}: 全部未通过/无本地 → emoji ${emoji}`);
        if (emoji) { await target.say(emoji); }
      }
    }
    return;
  }

  // 无候选结果 → 直接 emoji
  const emoji = emotionCtx ? contextEmoji(emotionCtx.emotion) : stickerMgr.search(kw);
  console.log(`[sticker-noresult] ${keyword}: 搜索无结果 → emoji ${emoji}`);
  if (emoji) { await target.say(emoji); }
}

/**
 * 发送 AI 生成的图片（从 tool calling 产出）
 * 在文字回复之前发送，模拟真人"先发图再说话"
 */
async function sendGeneratedImage(target) {
  const urlOrPath = consumeGeneratedImage();
  if (!urlOrPath) return false;

  try {
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
      await target.say(FileBox.fromUrl(urlOrPath, "generated.jpg"));
    } else {
      await target.say(FileBox.fromFile(urlOrPath));
    }
    console.log(`[image-sent] ${urlOrPath.substring(0, 60)}`);
    return true;
  } catch (e) {
    console.warn(`[image-send] 失败:`, e.message);
    return false;
  }
}

// 情绪 → emoji 后备（在关键词匹配失败时，根据聊天氛围选择）
function contextEmoji(mood) {
  const map = {
    happy:     ["[呲牙]", "[偷笑]", "[憨笑]", "[耶]", "[愉快]"],
    sad:       ["[拥抱]", "[爱心]", "[可怜]", "[快哭了]"],
    angry:     ["[擦汗]", "[捂脸]", "[裂开]"],
    surprised: ["[惊讶]", "[发呆]", "[吃瓜]"],
    love:      ["[爱心]", "[亲亲]", "[玫瑰]", "[拥抱]"],
    bored:     ["[吃瓜]", "[旺柴]", "[嘿哈]"],
    neutral:   ["[捂脸]", "[嘿哈]", "[吃瓜]", "[旺柴]", "[偷笑]"],
  };
  const pool = map[mood] || map.neutral;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 关键词归一化：将模型输出的口语化/小众词映射为API盒子能搜到的常见词
function normalizeKeyword(kw) {
  const map = {
    "干饭": "吃饭", "淦饭": "吃饭", "饿了": "吃饭",
    "困了": "睡觉", "睡了": "晚安", "晚安": "睡觉",
    "笑死": "好笑", "哈哈": "好笑", "搞笑": "好笑", "笑": "好笑",
    "气死": "生气", "怒了": "生气", "火大": "生气",
    "牛": "赞", "棒": "赞", "厉害": "赞", "强": "赞",
    "哭死": "哭", "泪目": "哭", "想哭": "哭",
    "摸鱼": "偷懒", "躺平": "偷懒", "摆烂": "偷懒",
    "爱": "爱心", "喜欢": "爱心", "甜": "爱心",
    "猫猫": "猫", "喵": "猫", "猫咪": "猫",
    "狗狗": "狗", "汪": "狗",
    "八卦": "围观",
    "裂开": "无语", "服了": "无语", "绝了": "无语",
    "比心": "爱心", "亲亲": "爱心",
  };
  return map[kw] || kw;
}

// 根据聊天氛围自动决定是否配表情包（不依赖模型手动输出📎）
function decideSticker(emotion, classification, replyText) {
  // 知识类问题不加表情包，其余场景都可以
  if (classification === "complex") return null;
  // 已经有📎的不重复加
  if (/📎\S+/.test(replyText)) return null;

  const mood = (emotion && emotion.emotion) || "neutral";
  const isShort = replyText.length <= 3;
  const isFarewell = /拜拜|bye|再见|晚安|睡了|忙了|开会|有事|先撤|下了|先忙/.test(replyText);
  const isAck = /^(ok|OK|Ok|okk|欧克|好的|好嘞|行|行吧|嗯嗯|嗯呢|嗯呐|好滴|好哒|好哦|得嘞|妥|成|中|阔以|可|哦哦|哦|好呀|行呀|对|是的|没错|收到|知道了|懂了|明白了|1|👌|👍)$/.test(replyText.trim());

  // 基础候选池
  const candidates = {
    happy:    ["好笑", "好笑", "赞", "爱心"],
    sad:      ["哭", "爱心", "爱心", "摸鱼"],
    angry:    ["无语", "生气"],
    surprised:["吃瓜", "好笑"],
    love:     ["爱心", "爱心", "比心"],
    neutral:  ["好笑", "赞", "猫", "狗", "吃瓜", "好的"],
  };

  const pool = [...(candidates[mood] || candidates.neutral)];

  // 告别/晚安 → 偏好的/睡觉类
  if (isFarewell) {
    pool.push("好的", "好的", "睡觉", "睡觉");
  }
  // 简短确认 → 偏好的/OK
  if (isAck || isShort) {
    pool.push("好的", "好的", "赞", "赞");
  }
  // 倾诉发泄 → 共情类
  if (classification === "vent") {
    pool.push("爱心", "爱心", "哭");
  }

  // 概率：告别/确认/短回复更高，因为表情包本身就是回复
  let chance;
  if (isFarewell || isAck) {
    chance = 0.50; // 告别和确认一半概率用表情包代替文字
  } else if (isShort) {
    chance = 0.40;
  } else {
    chance = mood === "neutral" ? 0.25 : 0.30;
  }

  if (Math.random() > chance) return null;

  const kw = pool[Math.floor(Math.random() * pool.length)];
  console.log(`[sticker-auto] 氛围检测: mood=${mood} class=${classification}${isFarewell ? " farewell" : ""}${isAck ? " ack" : ""}${isShort ? " short" : ""} → 自动追加📎${kw}`);
  return kw;
}

/**
 * 消息分类器：双脑架构入口
 * simple  → 寒暄/确认/单字，秒回无需工具
 * complex → 知识/事实问题，启用搜索 + 高 token
 * normal  → 日常聊天，启用工具但标准 token
 */
function classifyMessage(text) {
  const t = text.trim();
  const len = t.length;

  // 极短确认/寒暄
  const simpleSet = new Set([
    "在吗", "在", "嗯", "哦", "好", "行", "ok", "OK", "好的", "好嘞", "行吧",
    "是的", "对", "没错", "哈哈", "嘿嘿", "1", "知道了", "收到", "明白了",
    "懂了", "嗯嗯", "哦哦", "哇", "牛", "6", "666", "nb", "厉害", "可以",
    "可", "不", "不是", "没有", "没", "有", "吃了", "睡了", "早", "晚安",
    "拜拜", "再见", "88", "886", "嗨", "hi", "hello", "hey", "嗯呢",
    "好哒", "okk", "okok", "fine", "阔以", "妥", "得嘞", "成", "中",
    "彳亍", "嗯嗯嗯", "好滴", "嘻嘻", "来啦", "来了", "好呀", "行呀",
    "可呀", "嗯呐", "好哦", "好喔", "对呀", "是呀", "是啊", "对啊",
    "没错没错", "就是", "确实", "真的", "嗯对", "嗯好", "哦好",
  ]);
  if (simpleSet.has(t)) return "simple";
  // 剥离[xxx]表情后再判断（如 "好的[OK]" → "好的"）
  const stripped = t.replace(/\[[^\]]+\]/g, "").trim();
  if (stripped && simpleSet.has(stripped)) return "simple";
  // 2字以内且首字为常见语气词
  if (len <= 2 && /^[嗯哦好行可中对妥成是的有没有不嗯啊哈嘿]/u.test(t)) return "simple";
  // 纯微信表情/emoji（[xxx]格式），如 [加油] [旺柴] [捂脸] [旺柴][玫瑰]
  if (/^(\[[^\]]+\]\s*)+$/.test(t)) return "simple";
  // 只含 unicode emoji（如 "😊" "👍👍"）
  if (/^[\p{Emoji}\s]+$/u.test(t)) return "simple";
  // 3字以内的纯标点/语气组合（如 "好的吧" "行吧嗯"）
  if (len <= 3 && /^[嗯哦好行可中对妥成是有没啊哈嘿呀呢嘛吧了啦的]+$/u.test(t)) return "simple";

  // 情绪宣泄：长消息 + 强烈情绪词 → 需要共情而非搜索
  const ventPatterns = [
    /气死[我了]?|崩溃[了]?|受不了[了]?|好烦|难过(?:死了|哭了|crying|[了得])/,
    /想哭|焦虑|压力.*[大死]|好累|撑不住|扛不住|真的.*[难受烦累困倦绝望]/,
    /凭什么|为什么.*[我]|我.*太.*[难痛苦累]了|烦死[我了]?/,
    /(失恋|分手|被甩|吵架|闹掰|被裁|离职|裸辞|挂科|考砸)/,
  ];
  if (len >= 10) {
    for (const p of ventPatterns) {
      if (p.test(t)) return "vent";
    }
  }

  // 知识/事实问题 → 需要搜索
  const complexPatterns = [
    /为什么|什么是|怎么(做|办|回事)|如何|什么时候|在哪里|是谁/,
    /查一下|搜一下|搜索|帮我查|知不知道|听说过吗/,
    /(去|帮我|给我)?(了?解一下|了解下|了解|查查|搜搜)/,
    /介绍一下|科普|解释一下|最新|新闻|今天.*发生/,
    /推荐.*(电影|书|游戏|番|剧|音乐|歌|吃的|餐厅|手机|电脑|耳机|键盘)/,
    /有什么.*(好|推荐|新|好玩|好看|好吃)/,
    /真的假的|确定吗|靠谱吗|是这样的吗|对吗/,
    /(天气|股价|汇率|比分|排名|考试|政策|法规).*/,
    /(哪|什么|谁|怎么|为什么|何时|何地).*\?*$/,
    /你觉得.*怎么样|你怎么看|你知不知道/,
  ];
  for (const p of complexPatterns) {
    if (p.test(t)) return "complex";
  }

  return "normal";
}

/**
 * 检测对话结束信号：对方要离开/睡觉/忙了
 * 此时应简短告别，不抛新话题
 */
function detectEndingSignal(text) {
  const t = text.trim();
  const endingSet = new Set([
    "拜拜", "再见", "88", "886", "晚安", "睡了", "先睡了", "困了",
    "先忙", "忙了", "开会", "开会了", "有事", "先这样", "回头聊",
    "下了", "先下了", "不聊了", "休息了", "去洗澡", "洗澡了",
  ]);
  if (endingSet.has(t)) return true;
  // 包含结束关键词的短消息
  if (t.length <= 15 && /(拜拜|再见|晚安|先睡|先忙|开会|回头聊|下了|不聊|洗澡|休息)/.test(t)) {
    return true;
  }
  return false;
}

// 消息合并窗口：2.5秒内的连续消息合并成一回合
const DEBOUNCE_MS = 8000;
const pendingBuffers = new Map(); // targetName -> { target, targetName, texts: [] }
const pendingTimers = new Map(); // targetName -> timeoutId

// 发送后冷却期：bot 发完回复后 8 秒内只缓冲不回复，等用户说完
const COOLDOWN_MS = 8000;
const cooldownBuf = new Map(); // targetName -> { target, texts: [], timer }

function flushCooldown(name, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState) {
  const buf = cooldownBuf.get(name);
  if (!buf || buf.texts.length === 0) return;
  cooldownBuf.delete(name);
  const merged = buf.texts.join("；");
  console.log(`[cooldown] ${name}: 冷却结束，flush ${buf.texts.length}批 → "${merged.substring(0, 40)}"`);
  // 如果正在处理中，转交 pending 而非再造一轮 debounce
  if (busyTargets.has(name)) {
    busyTargets.get(name).push(merged);
    console.log(`[cooldown] ${name}: busy中，转交pending (${busyTargets.get(name).length}条)`);
    return;
  }
  if (pendingTimers.has(name)) {
    clearTimeout(pendingTimers.get(name));
    pendingBuffers.get(name).texts.push(merged);
  } else {
    pendingBuffers.set(name, { target: buf.target, targetName: name, texts: [merged] });
  }
  pendingTimers.set(name, setTimeout(() => {
    flushDebounced(name, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
  }, DEBOUNCE_MS));
}

function scheduleDailySummary(memory, contactedFriends) {
  // 计算到今晚 23:55 的毫秒数
  const now = new Date();
  const target = new Date(now);
  target.setHours(23, 55, 0, 0);
  if (target <= now) {
    // 已经过了今天 23:55，等到明天
    target.setDate(target.getDate() + 1);
  }

  const msUntilTarget = target.getTime() - now.getTime();
  console.log(`[daily-summary] 每日总结已调度，首次 ${target.toLocaleString()} (${Math.round(msUntilTarget / 60000)}分钟后)`);

  const runDailySummary = async () => {
    const todayStr = new Date().toLocaleDateString("zh-CN");
    console.log(`\n[daily-summary] ========== ${todayStr} 每日总结开始 ==========`);
    const friends = [...contactedFriends.values()];
    if (friends.length === 0) {
      console.log("[daily-summary] 无联系好友，跳过");
      return;
    }
    for (const friend of friends) {
      try {
        await memory.dailySummarize(friend.name);
      } catch (e) {
        console.error(`[daily-summary] ${friend.name} 失败:`, e.message);
      }
    }
    console.log(`[daily-summary] ========== 完成 ==========\n`);
  };

  // 首次用 setTimeout，之后用 setInterval
  setTimeout(() => {
    runDailySummary();
    setInterval(runDailySummary, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}

// 主动聊天调度器状态（防重复启动）
let proactiveState = null; // { active: true } | null

function startProactiveScheduler(bot, persona, chatEngine, memory, stickerMgr, contactedFriends, selfState) {
  // 取消旧调度链，用最新的 Map 重新开始
  if (proactiveState) {
    proactiveState.active = false;
    console.log("[proactive] 取消旧调度链，重新启动");
  }
  const state = { active: true };
  proactiveState = state;

  const intervalMin = 8;
  const intervalMax = 20;

  const scheduleNext = () => {
    if (!state.active) return; // 旧链被取消
    const interval = (intervalMin + Math.random() * (intervalMax - intervalMin)) * 60 * 1000;
    setTimeout(async () => {
      if (!state.active) return;
      try {
        await proactiveTick(bot, persona, chatEngine, memory, stickerMgr, contactedFriends, selfState);
      } catch (e) {
        console.error("[proactive] 调度错误:", e.message);
      }
      scheduleNext(); // 递归调度下一次
    }, interval);
  };

  const chance = persona.behavior?.proactiveChance ?? config.proactiveChance ?? 0.02;
  console.log(`[proactive] 主动聊天已启动（每${intervalMin}-${intervalMax}分钟检查，概率${(chance * 100).toFixed(1)}%）`);
  scheduleNext();
}

async function proactiveTick(bot, persona, chatEngine, memory, stickerMgr, contactedFriends, selfState) {
  if (isQuietTime()) {
    console.log("[proactive] 免打扰时段，跳过");
    return;
  }

  // 随机判断
  const chance = persona.behavior?.proactiveChance ?? config.proactiveChance ?? 0.02;
  if (Math.random() > chance) {
    return;
  }

  // 选一个聊过的朋友
  const friends = [...contactedFriends.values()];
  if (friends.length === 0) {
    console.log("[proactive] 没有聊过的朋友，跳过");
    return;
  }

  const friend = friends[Math.floor(Math.random() * friends.length)];
  console.log(`[proactive] 主动搭话 -> ${friend.name}`);

  // 构建"主动发起话题"的 prompt
  const systemPrompt = buildSystemPrompt(
    persona,
    config.aiName,
    config.userName,
    memory.getMemoryContext(friend.name),
    { style: "对方可能无聊或无回应，轻松随意地抛个话题" }
  );

  const messages = await memory.getContextMessages(friend.name, systemPrompt);

  // 注入 few-shot 示例
  const fewShots2 = getFewShotMessages(persona);
  messages.splice(1, 0, ...fewShots2);

  // 计算距上次聊天的时间间隔，让模型自然判断该聊什么
  let timeNote = "";
  try {
    const logEntries = readJSONL(`${friend.name}.jsonl`, 1);
    if (logEntries.length > 0) {
      const lastTime = new Date(logEntries[logEntries.length - 1].time);
      if (!isNaN(lastTime)) {
        const minutesAgo = Math.floor((Date.now() - lastTime.getTime()) / 60000);
        if (minutesAgo < 30) {
          timeNote = "\n（你们刚刚才聊过，别说好久没聊之类的话。顺便提一嘴刚聊的事。）";
        } else if (minutesAgo > 300) {
          timeNote = `\n（你们大概${Math.floor(minutesAgo / 60)}小时没聊了，自然地问候一下，别太刻意。）`;
        } else if (minutesAgo > 120) {
          timeNote = `\n（距离上次聊天过了${Math.floor(minutesAgo / 60)}小时，可以随口提一句。）`;
        }
      }
    }
  } catch {}

  const topic = PROACTIVE_TOPICS[Math.floor(Math.random() * PROACTIVE_TOPICS.length)];
  messages.push({ role: "user", content: topic + timeNote });

  // 当前状态注入：让模型知道自己在哪、什么时间
  {
    const stateShort = selfState.getContextShort();
    if (stateShort) {
      messages.push({ role: "system", content: stateShort });
    }
  }

  let reply = await chatEngine.chat(messages, {
    temperature: persona.behavior?.temperature ?? 0.9,
    maxTokens: persona.behavior?.maxTokens ?? 400,
    sceneContext: selfState.getContext(),
  });

  if (!reply) {
    console.log("[proactive] 生成失败");
    return;
  }

  console.log(`[proactive reply] -> ${friend.name}: ${reply.substring(0, 50)}`);

  // 检测 [图片] 标记 → 自动生图
  {
    const imgMatch = reply.match(/\[图片\]/);
    if (imgMatch) {
      const refinePrompt = `你要主动发给对方的图片，你的搭话："${reply.replace(/\[图片\]\s*/g, '').trim()}"\n\n请用一句简短中文描述这张图片的具体画面内容（照片级真实感，无文字无水印无标记）。只输出画面描述，不要其他。`;
      const refined = await chatEngine.chatSimple(
        [{ role: "user", content: refinePrompt }],
        { temperature: 0.3, maxTokens: 50 }
      );
      const prompt = (refined || reply.replace(/\[图片\]\s*/g, "").replace(/[""]/g, "")).trim().substring(0, 80);

      console.log(`[image-auto] 主动消息检测到[图片] → AI提炼: "${prompt}"`);
      const imgUrl = await chatEngine.generateImage(prompt);
      if (imgUrl) {
        try {
          if (imgUrl.startsWith("http://") || imgUrl.startsWith("https://")) {
            await friend.target.say(FileBox.fromUrl(imgUrl, "generated.jpg"));
          } else {
            await friend.target.say(FileBox.fromFile(imgUrl));
          }
          console.log(`[image-sent] ${imgUrl.substring(0, 60)}`);
        } catch (e) { /* ignore */ }
      }
      reply = reply.replace(/\[图片\]\s*/, "").trim();
      if (!reply) return;
    }
  }

  // 修复emoji别名 + 转📎表情包（必须在发送前处理）
  reply = fixEmojiAliases(reply);
  reply = convertEmojiToSticker(reply);

  // 延迟后发送（主动消息也加点随机延迟）
  const delay = randomDelay(5, 20);
  console.log(`[proactive delay] ${delay / 1000}s`);
  await new Promise((r) => setTimeout(r, delay));

  // 分包发送，按位置交错发送文字和表情包
  const segments = splitReply(reply);
  console.log(`[proactive send] 拆为 ${segments.length} 条`);

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      const gap = 500 + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, gap));
    }

    let text = segments[i].trim().replace(/^"|"$/g, "").trim();
    const m = text.match(/📎(\S+)/);

    if (m) {
      const keyword = m[1];
      text = text.replace(/📎\S+/, "").trim();
      await sendStickerForKeyword(friend.target, keyword, stickerMgr, chatEngine, null, reply);
    }

    if (text) {
      await friend.target.say(text);
      console.log(`[proactive sent] "${text.substring(0, 30)}"`);
    }
  }

  // 记录到记忆（剥离📎指令）
  const cleanReply = reply.replace(/📎\S+/g, "").trim();
  memory.saveExchange(friend.name, "[主动搭话]", cleanReply);
  selfState.updateFromReply(cleanReply);
}

function flushDebounced(name, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState) {
  const buf = pendingBuffers.get(name);
  if (!buf || buf.texts.length === 0) return;
  pendingBuffers.delete(name);
  pendingTimers.delete(name);
  const merged = buf.texts.join("；");
  console.log(`[debounce] ${name}: 合并${buf.texts.length}条 → "${merged.substring(0, 40)}"`);
  processAndReply(bot, buf.target, name, merged, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
}

async function processAndReply(bot, target, targetName, text, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState) {
  console.log(`[msg] ${targetName}: ${text.substring(0, 50)}`);

  if (isQuietTime()) {
    console.log(`[quiet] 免打扰时段，跳过回复`);
    return;
  }

  // 对方正在被处理中 → 缓冲消息，合并处理
  if (busyTargets.has(targetName)) {
    busyTargets.get(targetName).push(text);
    console.log(`[busy] ${targetName}: 缓冲待处理 (${busyTargets.get(targetName).length}条)`);
    return;
  }

  // 情绪检测 + 状态更新
  const emotionState = emotionTracker.update(targetName, text);
  const shouldAsk = emotionTracker.shouldAskProactive(targetName);
  const secInfo = emotionState.secondary ? ` +${emotionState.secondary}` : "";
  const intInfo = emotionState.intensity > 2 ? ` 🔥x${emotionState.intensity}` : "";
  console.log(`[emotion] ${targetName}: ${emotionState.emotion}${secInfo}${intInfo} | ${emotionState.style}${shouldAsk ? " | 主动提问" : ""}`);

  // 检测提醒请求
  let reminderInfo = null;
  const reminderParsed = reminderMgr.parse(text);
  if (reminderParsed) {
    reminderInfo = reminderParsed;
    console.log(`[reminder] 检测到提醒: ${reminderParsed.target.toLocaleString()} "${reminderParsed.message}"`);
  }

  // 情绪轨迹（方案二：情感感知记忆）
  const emotionalTrajectory = emotionTracker.getEmotionalContext(targetName);

  let systemPrompt = buildSystemPrompt(
    persona,
    config.aiName,
    config.userName,
    memory.getMemoryContext(targetName),
    { style: emotionState.style, shouldAsk, trajectory: emotionalTrajectory }
  );

  // 白天时间意识：18点前不催休息，18-21点不说晚安但可聊晚间话题
  {
    const now = new Date();
    const h = now.getHours();
    if (h >= 6 && h < 18) {
      systemPrompt += `\n\n【时间意识】现在是白天，对方还要正常活动。绝对不能说"早点休息""晚安""快去睡""明天还要上班"之类的话。`;
    } else if (h >= 18 && h < 21) {
      systemPrompt += `\n\n【时间意识】现在是晚间。对方可能刚下班在休息。别催睡觉，但也别聊工作/上班的话题。`;
    }
  }

  // 注入提醒信息到 system prompt
  if (reminderInfo) {
    systemPrompt += `\n\n【重要】对方让你在 ${reminderInfo.target.toLocaleString()} 提醒他："${reminderInfo.message}"。你在回复里自然地表示记住了，比如"好的明天7点叫你"这样。`;
  }

  // 纯确认/收尾词：剥离表情包标记和分隔符后再判断
  const ackCheckText = text.replace(/\[发了一个表情包\]|\[收到一张图片\]|\[对方撤回了一条消息\]/g, "").replace(/[；;，,]\s*/g, "").trim();
  const isAckMsg = /^(ok|OK|Ok|okk|欧克|好的|好嘞|行|行吧|嗯嗯|嗯呢|嗯呐|好滴|好哒|好哦|得嘞|妥|成|中|阔以|可|哦哦|哦|好呀|行呀|对|是的|没错|收到|知道了|懂了|明白了|1|👌|👍)$/.test(ackCheckText);

  // 提前检测结束信号 + 消息分类，用于抑制话题回调
  const isEnding = detectEndingSignal(text) || isAckMsg;
  const preClassify = classifyMessage(text);

  // 连续简单消息追踪：如果上一条也是 simple/短消息，判定为收尾模式
  const prev = lastMsgType.get(targetName);
  if (preClassify === "simple") {
    if (prev && prev.type === "simple") {
      prev.count = (prev.count || 1) + 1;
    } else {
      lastMsgType.set(targetName, { type: "simple", count: 1 });
    }
  } else {
    // 非简单消息 → 重置计数
    lastMsgType.set(targetName, { type: preClassify, count: 0 });
  }
  const consecutiveSimple = (lastMsgType.get(targetName)?.count || 0);
  const isWindingDown = isEnding || (preClassify === "simple" && consecutiveSimple >= 2);

  if (isAckMsg && !isWindingDown) {
    systemPrompt += `\n\n【重要】对方只是确认收到。回得简短自然（3-8字）。关键：只参考你上一轮回复的话题——你上一句说了什么就顺着什么说。不要翻到更早的聊天记录里找别的话题。不要在确认回复里开启新话题。`;
    console.log(`[ack] ${targetName}: 确认信号，简短回复（可带话题）`);
  } else if (isEnding) {
    systemPrompt += `\n\n【注意】对方发出了结束对话的信号。简短告别（3-5字），不打理由、不问问题、不抛新话题。告别时参考刚才聊的内容：如果对方说在吃饭就说"好好吃"，如果在休息就说"好好休息"，不要总说"去忙吧"。`;
    console.log(`[ending] ${targetName}: 检测到结束信号`);
  } else if (isWindingDown) {
    systemPrompt += `\n\n【注意】对方连续发了${consecutiveSimple}条简短回复，明显想结束对话。你也简短回应（3-5字），直接告别，不要编造自己要去干嘛的理由（比如"去忙""打游戏"之类的），说拜拜就好。告别时参考刚才聊的内容，不要总说"去忙吧"——如果对方之前在吃饭/休息/摸鱼，就祝吃好/休息好/摸鱼愉快。不问问题、不抛新话题。`;
    console.log(`[winding-down] ${targetName}: 连续${consecutiveSimple}条简短回复，收尾模式`);
  } else if (preClassify === "simple") {
    // 第一条简短回复：保持简洁，不扩展话题
    systemPrompt += `\n\n【注意】对方发了简短回复，可能是想结束对话。你也简洁回应（5-10字），不要抛新话题、不要问问题。如果对方之前在做什么（吃饭/休息/工作），回应时可以参考一下，不要总说"去忙吧"。`;
    console.log(`[simple-hint] ${targetName}: 简短回复提示`);
  }

  // 话题回调：simple/ending 消息绝不触发
  if (preClassify !== "simple" && !isEnding) {
    const topicCallbackChance = 0.08;
    if (Math.random() < topicCallbackChance) {
      const memCtx = memory.getMemoryContext(targetName);
      if (memCtx && memCtx.length > 20) {
        const lines = memCtx.split("\n").filter(l => l.trim());
        if (lines.length > 0) {
          const pick = lines[Math.floor(Math.random() * lines.length)].replace(/^-\s*/, "");
          const callbacks = [
            `对了你上次说${pick}，后来怎么样了？`,
            `突然想起来你之前说过${pick}，最近怎么样了？`,
            `说到这个，你上次不是说${pick}吗，后续呢？`,
          ];
          const cb = callbacks[Math.floor(Math.random() * callbacks.length)];
          if (!text.includes(pick.substring(0, 4))) {
            systemPrompt += `\n\n【话题回调】你可以自然地带出这句话，但不要生硬地插入："${cb}"`;
            console.log(`[callback] ${targetName}: 话题回调 -> "${pick.substring(0, 20)}"`);
          }
        }
      }
    }
  }

  const messages = await memory.getContextMessages(targetName, systemPrompt, text);

  // 写入文件方便诊断
  try { fs.writeFileSync("/app/data/last_system_prompt.txt", systemPrompt, "utf-8"); } catch {}

  // 时间间隔检测：如果距上次聊天很久，注入自然的场景过渡
  {
    try {
      const logEntries = readJSONL(`${targetName}.jsonl`, 1);
      if (logEntries.length > 0) {
        const lastTime = new Date(logEntries[logEntries.length - 1].time);
        if (!isNaN(lastTime)) {
          const gapMin = Math.floor((Date.now() - lastTime.getTime()) / 60000);
          if (gapMin > 60) {
            const hr = Math.floor(gapMin / 60);
            const stateShort = selfState.getContextShort();
            const gapText = hr >= 3
              ? `（${hr}个小时过去了。${stateShort ? stateShort.replace("【现在】", "") : ""}）`
              : `（过了${hr}个多小时。${stateShort ? stateShort.replace("【现在】", "") : ""}）`;
            messages.push({ role: "system", content: gapText });
            console.log(`[time-gap] ${targetName}: 距上次${gapMin}分钟，注入场景过渡`);
          }
        }
      }
    } catch {}
  }

  // few-shot 对话示例：放在历史之后、状态之前
  // 测试证明，在思考模式下，few-shots 靠近生成点比放在 system 之后更有效
  const fewShots = getFewShotMessages(persona);
  messages.push(...fewShots);

  // 直接发原文
  messages.push({ role: "user", content: text });

  console.log(`[diagnose] systemPrompt(${systemPrompt.length}字) + ${fewShots.length}条few-shot → 总${messages.length}条消息`);

  // 注入上次生成图片的画面描述 → 模型知道自己发了什么，后续不会瞎编
  const lastImgPrompt = recentImagePrompt.get(targetName);
  if (lastImgPrompt) {
    messages.push({
      role: "system",
      content: `【你上次发的图片】你刚给对方发了一张照片，你拍到的画面是："${lastImgPrompt}"。后续聊天如果对方谈到这张图，你的描述必须和这个画面内容一致，不要编造不同场景。`,
    });
    recentImagePrompt.delete(targetName);
  }

  // 日间防睡眠误判：用户说累/困/睡觉但现在是白天，提醒模型不要劝睡
  if (/(睡|睡觉|困了|好累|躺|看不动|卷不动|顶不住)/.test(text) && !/(睡了吗|睡着|睡不着|失眠|几点睡|晚睡)/.test(text)) {
    const now = new Date();
    const h = now.getHours();
    if (h >= 6 && h < 18) {
      const timeStr = `${String(h).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      messages.push({
        role: "system",
        content: `【时间提醒】现在是白天 ${timeStr}，不是晚上。对方可能只是累了想休息一下，但绝对不是要睡觉。不要说"赶紧睡""快去睡"之类的话。可以建议歇会儿/喝杯水/摸会儿鱼。`,
      });
      console.log(`[daytime] 日间防睡眠: ${timeStr}`);
    }
  }

  // 时间类问题：直接注入准确时间，不让模型瞎编
  if (/几点|什么时间|几点了|现在时间|几号|今天.*几|今天星期|周几|星期几/.test(text)) {
    const now = new Date();
    const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
    const timeAnswer = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 周${weekNames[now.getDay()]} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    messages.push({
      role: "system",
      content: `【系统时间】现在是北京时间 ${timeAnswer}。这是你手机的真实时间。你必须用这个时间回答，即使之前说过别的时间，直接纠正就行，像真人看手机确认一样自然。不要说"看错了"之类的话，直接说出正确时间。`,
    });
    console.log(`[time] 注入系统时间: ${timeAnswer}`);
  }

  // 双脑路由（方案三）：按消息类型分流
  let classification = preClassify;

  // 用户想看东西（"看看咪咪""看看猫""看看照片"等）→ 注入生图指令 + 强制生图标志
  let forceImage = false;
  const wantsViewRE = /看看|想看|瞧瞧|瞅瞅|瞧一瞧|看一下|给我看|发.*(照片|图片|图)/;
  if (wantsViewRE.test(text) && !/^看看你[了]?$|^看看我[了]?$|看看你自己|看看自己|表情包|表情|贴图|emoji/.test(text)) {
    forceImage = true;
    const imgFacts = buildImageFacts();
    const factsHint = imgFacts ? `\n你养的宠物外观：${imgFacts}` : "";
    messages.push({
      role: "system",
      content: `【重要】对方想看你发的东西（照片/图片）。${factsHint ? '你宠物外观是：' + imgFacts : ''}你现在必须调用 generate_image 工具，根据对方想看的内容生成一张照片发给对方。不要找借口说"发了呀""发过了""往上翻翻"，直接调工具生图。`,
    });
    // 强制启用工具，提升token预算
    classification = "complex";
    console.log(`[img-intent] 检测到用户想看东西，注入生图指令`);
  }
  // 结束信号或收尾模式 → 强制快速通道，简短告别
  if (isWindingDown && classification !== "simple") {
    classification = "simple";
  }
  console.log(`[classify] ${targetName}: ${classification}${isWindingDown ? " [winding-down]" : ""} (${text.substring(0, 20)})`);

  const baseTok = persona.behavior?.maxTokens ?? 250;
  const inLen = text.trim().length;
  let maxTok;
  if (inLen <= 3) {
    maxTok = 20;
  } else if (inLen <= 8) {
    maxTok = 30;
  } else if (inLen <= 15) {
    maxTok = 45;
  } else if (inLen <= 30) {
    maxTok = 60;
  } else {
    maxTok = Math.min(baseTok, 80);
  }
  // 纯确认：低 token 但够简短带话题（如"好的我去看看"）
  if (isAckMsg) {
    maxTok = Math.min(maxTok, 25);
  } else if (isWindingDown) {
    maxTok = Math.min(maxTok, 15);
  } else if (classification === "simple") {
    maxTok = Math.min(maxTok, 16);
  }

  const sceneCtx = selfState.getContext();

  // 当前状态注入：放在所有条件消息之后，模型生成前最后看到
  {
    const stateShort = selfState.getContextShort();
    if (stateShort) {
      messages.push({ role: "system", content: stateShort });
    }
  }

  let reply;
  switch (classification) {
    case "simple":
      // 快速通道：无工具，无思考，低 token
      reply = await chatEngine.chatSimple(messages, {
        temperature: persona.behavior?.temperature,
        maxTokens: Math.min(maxTok, 20),
      });
      break;

    case "vent":
      // 共情通道：思考模式（理解深层情绪），关闭工具（不需要搜索）
      reply = await chatEngine.chat(messages, {
        temperature: persona.behavior?.temperature,
        maxTokens: Math.max(maxTok, 120),
        enableTools: false,
        thinking: true,
        reasoningEffort: "medium",
        sceneContext: sceneCtx,
      });
      break;

    case "complex":
      // 深度通道：思考模式 + 搜索工具 + 高 token
      reply = await chatEngine.chat(messages, {
        temperature: persona.behavior?.temperature,
        maxTokens: Math.max(maxTok, 200),
        thinking: true,
        reasoningEffort: "medium",
        sceneContext: sceneCtx,
      });
      break;

    default:
      // 日常通道：轻思考 + 可能用工具
      reply = await chatEngine.chat(messages, {
        temperature: persona.behavior?.temperature,
        maxTokens: Math.max(maxTok, 60),
        thinking: true,
        reasoningEffort: "low",
        sceneContext: sceneCtx,
      });
      break;
  }
  console.log(`[token] in=${inLen} ${classification} → maxTok=${maxTok}`);

  if (!reply) {
    console.log(`[reply] 生成失败，跳过`);
    return;
  }

  console.log(`[reply] -> ${targetName}: ${reply.substring(0, 50)}`);

  // ── 图片承诺检测：模型承诺了发图但没调工具 → 两步兜底 ──
  {
    const alreadyHasImage = peekGeneratedImage() !== null;
    // 回复中有📎标记 → 这是表情包请求，不是照片，跳过图片fixup
    const isStickerReply = /📎\S+/.test(reply);
    if (!alreadyHasImage && !isStickerReply) {
      const imagePromiseRE = /(?:给你看|给你拍|拍了[张一]|拍一[张个]|[刚就]拍的|拍个[图照片]|发给你|发给|发张[图照片]|发个[图照片]|发来[图照片]|发一[张个]|看看.*[样照图猫狗崽它]|照片|上图|看图|图片|\b图\b|发了呀|发过了|发了没|往上翻翻|往上翻|翻一翻|换了个姿势|来.*看|发.*[图照片])/;
      if (imagePromiseRE.test(reply)) {
        console.log(`[image-fixup] 回复承诺了图片但未调工具，开始兜底...`);

        // 步骤1：让模型再试一次（带强指令）
        messages.push({ role: "assistant", content: reply });
        messages.push({ role: "system", content: "你刚才说要发照片/图片给对方。现在立即使用 generate_image 工具，描述你要拍/发的画面。只输出你的回复文字（简短说明），工具会自动生成图片。" });
        const retryReply = await chatEngine.chat(messages, {
          temperature: persona.behavior?.temperature,
          maxTokens: Math.max(maxTok, 100),
          thinking: true,
          reasoningEffort: "high",
          sceneContext: sceneCtx,
        });

        // 步骤2：如果模型还是不调工具，我们自己生图
        if (peekGeneratedImage() === null) {
          console.log(`[image-fixup] 模型仍不调工具，直接生图...`);
          // 从模型回复+对话上下文提取图片描述
          const imgFacts = buildImageFacts();
          const factsHint = imgFacts ? `\n\n关键设定（必须遵守）：${imgFacts}` : "";
          const refinePrompt = `你的回复是："${reply}"${factsHint}\n\n从你的回复中提取图片画面描述。必须100%忠实于回复文字——回复里说什么场景就是什么场景，禁止改动替换或自由发挥。10-25字中文。只输出画面描述。`;
          const prompt = await chatEngine.chatSimple(
            [{ role: "user", content: refinePrompt }],
            { temperature: 0.3, maxTokens: 50 }
          );
          if (prompt) {
            console.log(`[image-fixup] 提炼prompt: "${prompt}"`);
            const imgResult = await chatEngine.generateImage(prompt.trim());
            if (imgResult) {
              _setGeneratedImage(imgResult);
              recentImagePrompt.set(targetName, prompt.trim());
              console.log(`[image-fixup] 直接生图成功，记录上下文`);
            }
          }
        }

        // 如果步骤2成功生图，保留原始回复（自然有人情味）；只有模型在步骤1乖乖调了工具才用重试回复
        // 但如果原始回复是"发了呀/往上翻翻"之类的借口，则必须替换
        if (peekGeneratedImage() !== null) {
          const excuseRE = /发了呀|发过了|往上翻翻|往上翻|翻一翻|刚刚.*发|没.*看到/;
          if (excuseRE.test(reply) && retryReply) {
            reply = retryReply.replace(/📎\S+/g, "").replace(/[""]/g, "").trim();
            console.log(`[image-fixup] 原始回复是借口，替换为: ${reply.substring(0, 50)}`);
          } else {
            console.log(`[image-fixup] 兜底生图成功，保留原始回复`);
          }
        } else if (retryReply) {
          reply = retryReply.replace(/📎\S+/g, "").replace(/[""]/g, "").trim();
          console.log(`[image-fixup] 模型重试回复: ${reply.substring(0, 50)}`);
        }
      }
    }
  }

  // ── 强制生图保障：用户明确要求看图，但模型没调工具也没命中fixup正则 ──
  if (forceImage && peekGeneratedImage() === null) {
    console.log(`[image-force] 用户要求看图但未生成，强制执行...`);
    const imgFacts = buildImageFacts();
    const factsHint = imgFacts ? `\n关键设定：${imgFacts}` : "";
    const extractPrompt = `你的回复是："${reply}"${factsHint}\n\n请从你自己的回复中提取你要发的那张图片的画面描述。关键：必须100%忠实于你的回复文字——回复里说什么场景就是什么场景，回复说"趴在腿上"就写趴在腿上，回复说"蹲在阳台"才写蹲在阳台。禁止改动、替换或自由发挥。10-25字中文。只输出画面描述。`;
    const sceneDesc = await chatEngine.chatSimple(
      [{ role: "user", content: extractPrompt }],
      { temperature: 0.3, maxTokens: 50 }
    );
    if (sceneDesc) {
      console.log(`[image-force] 提炼prompt: "${sceneDesc.trim()}"`);
      const imgResult = await chatEngine.generateImage(sceneDesc.trim());
      if (imgResult) {
        _setGeneratedImage(imgResult);
        recentImagePrompt.set(targetName, sceneDesc.trim());
        console.log(`[image-force] 强制生图成功，记录上下文`);
      }
    }
  }

  // 检测模型输出的 [图片] 标记 → 用 AI 从对话上下文提炼生图描述
  {
    const imgMatch = reply.match(/\[图片\]/);
    if (imgMatch) {
      // 让 AI 根据对方消息和回复上下文，提炼出具体的图片画面描述
      const imgFacts = buildImageFacts();
      const factsHint = imgFacts ? `\n\n重要：你固定养的宠物外观：${imgFacts}` : "";
      const refinePrompt = `你的回复是："${reply.replace(/\[图片\]\s*/g, '').trim()}"${factsHint}\n\n从你的回复中提取图片画面描述。必须100%忠实于回复文字——回复里说什么场景就是什么场景，禁止改动替换或自由发挥。10-25字中文。只输出画面描述。`;
      const refined = await chatEngine.chatSimple(
        [{ role: "user", content: refinePrompt }],
        { temperature: 0.3, maxTokens: 50 }
      );
      const prompt = (refined || reply.replace(/\[图片\]\s*/g, "").replace(/[""]/g, "")).trim().substring(0, 80);

      console.log(`[image-auto] 检测到[图片] → AI提炼: "${prompt}"`);
      const imgUrl = await chatEngine.generateImage(prompt);
      if (imgUrl) {
        recentImagePrompt.set(targetName, prompt);
        try {
          if (imgUrl.startsWith("http://") || imgUrl.startsWith("https://")) {
            await target.say(FileBox.fromUrl(imgUrl, "generated.jpg"));
          } else {
            await target.say(FileBox.fromFile(imgUrl));
          }
          console.log(`[image-sent] ${imgUrl.substring(0, 60)}`);
        } catch (e) {
          console.warn(`[image-send] 失败:`, e.message);
        }
      }
      // 移除 [图片] 标记文本，保留后面的描述
      reply = reply.replace(/\[图片\]\s*/, "").trim();
      if (!reply) { busyTargets.delete(targetName); return; }
    }
  }

  // 日间防睡眠回复：如果模型输出包含夜间用语 → 拦截
  {
    const now = new Date();
    const h = now.getHours();
    if (h >= 6 && h < 22 && /(早点休息|快去睡|赶紧睡|早点睡|晚安|快去休息|好好休息|休息吧|快睡觉|睡吧|明天还要|别太晚睡|太晚睡|不要熬夜|别熬夜|快去睡吧|早点躺|明天早起|明早要|赶紧休息|早休息|快休息|不早了)/.test(reply)) {
      console.log(`[daytime-block] 拦截日间睡眠回复 (${h}:${now.getMinutes()}): ${reply.substring(0, 40)}`);
      reply = reply.replace(/(，|。|！|！)?\s*(早点休息|快去睡|赶紧睡|早点睡|晚安|快去休息|好好休息|休息吧|快睡觉|睡吧|别太晚睡|太晚睡|不要熬夜|别熬夜|快去睡吧|早点躺|明天还要(上班|打工|工作|早起)|明天早起|明早要[^\s，。！]{0,10}|赶紧休息|早休息|快休息|不早)[吧啦呢哦啊呀吗了你我他]{0,8}[。！，\s]*/g, "");
      reply = reply.replace(/📎[夜困累睡]/g, "").trim();
      if (!reply || reply.length < 2) {
        reply = "嗯嗯";
      }
      console.log(`[daytime-block] 修正为: ${reply.substring(0, 40)}`);
    }
  }

  // 保存提醒（不等发送完成）
  if (reminderInfo) {
    reminderMgr.add(target.id, targetName, reminderInfo.target, reminderInfo.message);
  }

  // 自动提取对方信息存入记忆
  const facts = memory.extractFacts(text);
  if (facts) {
    for (const [k, v] of Object.entries(facts)) {
      memory.saveMemory(targetName, k, v);
    }
    console.log(`[memory] 提取到 ${targetName}: ${JSON.stringify(facts)}`);
  }

  // 标记为"正在发送"，防止消息穿插
  const pending = [];
  busyTargets.set(targetName, pending);

  const min = persona.behavior?.replyDelayMin ?? config.replyDelayMin;
  const max = persona.behavior?.replyDelayMax ?? config.replyDelayMax;
  const delay = randomDelay(min, max);
  console.log(`[delay] ${delay / 1000}s`);
  await new Promise((r) => setTimeout(r, delay));

  // 延迟期间有新消息到达 → 合并后重新生成，丢弃当前回复
  if (pending.length > 0) {
    console.log(`[debounce] ${targetName}: ${pending.length} new msgs during delay, merging`);
    const allText = text + "；" + pending.join("；");
    busyTargets.delete(targetName);
    return processAndReply(bot, target, targetName, allText, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState);
  }

  // 修复模型发明的emoji名 → 微信真实名（如 [doge]→[旺柴]）
  reply = fixEmojiAliases(reply);

  // 模型输出的 emoji 转 📎表情包（仅保留 [OK][好的][握手][抱拳]）
  reply = convertEmojiToSticker(reply);

  // 根据聊天氛围自动决定是否配表情包（不依赖模型📎输出）
  const emotionCtx = emotionTracker.getContext(targetName);
  const autoKw = decideSticker(emotionState, classification, reply);
  if (autoKw && !/📎\S+/.test(reply)) {
    reply = "📎" + autoKw + " " + reply;
  }

  // 确认发送后才保存记忆（剥离📎指令，避免模型学到输出📎）
  const cleanReply = reply.replace(/📎\S+/g, "").trim();
  memory.saveExchange(targetName, text, cleanReply);
  selfState.updateFromReply(cleanReply);

  // 先发AI生成的图片（如有），再发文字。发了图就不再发同主题表情包
  const imageSent = await sendGeneratedImage(target);
  if (imageSent) {
    reply = reply.replace(/📎\S+/g, "").trim(); // 图片已是视觉内容，去掉表情包指令
  }

  // 按 "" 拆成多个短消息，按位置交错发送文字和表情包
  try {
    const segments = splitReply(reply);
    console.log(`[send] ${segments.length}条`);

    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        const gap = 500 + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, gap));
      }

      let text = segments[i].trim().replace(/^"|"$/g, "").trim();
      const m = text.match(/📎(\S+)/);

      if (m) {
        const keyword = m[1];
        text = text.replace(/📎\S+/, "").trim();
        await sendStickerForKeyword(target, keyword, stickerMgr, chatEngine, emotionCtx, reply);
      }

      if (text) {
        await target.say(text);
        console.log(`[sent] "${text.substring(0, 30)}"`);
      }
    }
  } finally {
    // 释放锁，启动发送后冷却期（无论发送成功与否都要释放）
    busyTargets.delete(targetName);
    if (!cooldownBuf.has(targetName)) {
      cooldownBuf.set(targetName, { target, texts: [] });
    }
    const cb = cooldownBuf.get(targetName);
    if (pending.length > 0) {
      cb.texts.push(pending.join("；"));
      console.log(`[cooldown] ${targetName}: ${pending.length}条缓冲转入冷却`);
    }
    if (cb.timer) clearTimeout(cb.timer);
    cb.timer = setTimeout(() => {
      try { flushCooldown(targetName, bot, persona, chatEngine, memory, stickerMgr, emotionTracker, reminderMgr, selfState); } catch {}
    }, COOLDOWN_MS);
  }
}
