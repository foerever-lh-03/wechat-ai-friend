import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR = path.resolve(__dirname, "..", "config", "personas");
const FACTS_FILE = path.resolve(__dirname, "..", "config", "facts.js");

const cache = new Map();
let _factsCache = null;

/** 加载持久人设事实 */
export function loadFacts() {
  if (_factsCache) return _factsCache;
  try {
    if (fs.existsSync(FACTS_FILE)) {
      const url = pathToFileURL(FACTS_FILE).href;
      import(url).then(mod => {
        _factsCache = mod.default;
      });
    }
  } catch (e) {
    console.warn(`[facts] 加载失败:`, e.message);
  }
  return _factsCache;
}

// 启动时同步加载（顶层 await 不支持时用动态 import + cache）
try {
  if (fs.existsSync(FACTS_FILE)) {
    const url = pathToFileURL(FACTS_FILE).href;
    const initFacts = await import(url);
    _factsCache = initFacts.default;
    console.log(`[facts] 已加载持久人设`);
  }
} catch (e) {
  console.warn(`[facts] 初始化加载失败:`, e.message);
}

/** 将 facts 对象转为系统提示文本 */
export function buildFactsContext() {
  const f = _factsCache;
  if (!f) return "";

  const lines = [];
  if (f.pet) {
    lines.push(`你养的宠物：${f.pet.species}，叫"${f.pet.name}"，${f.pet.age}，${f.pet.color}。外观：${f.pet.appearance}。性格：${f.pet.personality}。`);
  }
  if (f.home) {
    lines.push(`你住在${f.home.city}，${f.home.type}，${f.home.roomDesc}。`);
  }
  if (f.self) {
    lines.push(`你今年${f.self.age}岁，职业${f.self.job}，工作时间${f.self.workHours}，通勤${f.self.commute}。`);
  }
  return lines.join("\n");
}

/** 为图片生成构建宠物外观描述（用于prompt注入） */
export function buildImageFacts() {
  const f = _factsCache;
  if (!f || !f.pet) return "";
  return `${f.pet.appearance}`;
}

export async function loadPersona(personaId = "brother") {
  if (cache.has(personaId)) return cache.get(personaId);

  const filepath = path.join(PERSONA_DIR, `${personaId}.js`);
  let id = personaId;
  let fp = filepath;

  if (!fs.existsSync(fp)) {
    console.warn(`[persona] "${personaId}" not found, fallback to brother`);
    id = "brother";
    fp = path.join(PERSONA_DIR, "brother.js");
  }

  try {
    const url = pathToFileURL(fp).href;
    const mod = await import(url);
    const data = mod.default;
    data.id = id;
    cache.set(personaId, data);
    return data;
  } catch (e) {
    console.error(`[persona] load error: ${personaId}`, e.message);
    const fallback = {
      id: "brother",
      name: "损友/死党",
      description: "默认人设",
      systemPrompt: `你是{ai_name}，一个真实的人。`,
      behavior: { temperature: 0.9, maxTokens: 1024, replyDelayMin: 3, replyDelayMax: 15, proactiveChance: 0.02 },
    };
    cache.set(personaId, fallback);
    return fallback;
  }
}

export function buildSystemPrompt(persona, aiName = "阿杰", userName = "你", extraContext = "", emotionContext = null) {
  let prompt = persona.systemPrompt
    .replace(/\{ai_name\}/g, aiName)
    .replace(/\{user_name\}/g, userName)
    .replace(/\{time_context\}/g, getTimeContext());

  // 注入情绪上下文
  if (emotionContext) {
    prompt += `\n\n【当前状态】\n对方情绪：${emotionContext.style}`;
    if (emotionContext.trajectory) {
      prompt += `\n${emotionContext.trajectory}`;
    }
    if (emotionContext.shouldAsk) {
      prompt += `\n注意：已经聊了几条了，你可以自然地主动问对方一个问题，显得更关心对方。`;
    }
  }

  // 注入持久人设事实（宠物、居住、个人信息等不会频繁变动的设定）
  const factsCtx = buildFactsContext();
  if (factsCtx) {
    prompt += `\n\n【你的固定设定】\n${factsCtx}\n注意：以上是你的真实信息，不要临时编造。比如有人问你的猫长什么样，就按上面说的描述，每次都要一致。`;
  }

  // 注入记忆/画像
  if (extraContext) {
    prompt += `\n\n【关于${userName}的记忆】\n${extraContext}`;
  }

  return prompt;
}

/** 根据当前时间生成上下文提示 */
export function getTimeContext() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();
  const weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日周${weekNames[day]}`;
  const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  let ctx = `现在是${dateStr} ${timeStr}。`;

  if (h >= 0 && h < 6) {
    ctx += "凌晨时段。如果对方在熬夜，可以问一句怎么还不睡。语气轻一点。";
  } else if (h >= 6 && h < 9) {
    ctx += day === 0 || day === 6 ? "周末早上。可以问早，聊聊周末计划。" : "工作日早上。可以问早，问问今天忙不忙。";
  } else if (h >= 9 && h < 12) {
    ctx += "上午。正常聊天。";
  } else if (h >= 12 && h < 14) {
    ctx += "午饭时间。可以聊吃的，问问吃了没、吃了啥。";
  } else if (h >= 14 && h < 18) {
    ctx += "下午。";
  } else if (h >= 18 && h < 22) {
    ctx += "晚上。对方可能在休息放松，可以聊聊今天过得怎么样。";
  } else {
    ctx += "深夜。对方可能准备睡了，别聊太多，如果对方有睡意就主动道晚安。";
  }

  return ctx;
}

/** 将 fewShots 转为 OpenAI 消息格式，用于注入对话历史 */
export function getFewShotMessages(persona) {
  if (!persona.fewShots || persona.fewShots.length === 0) return [];
  const msgs = [];
  for (const shot of persona.fewShots) {
    msgs.push({ role: "user", content: shot.user });
    msgs.push({ role: "assistant", content: shot.assistant });
  }
  return msgs;
}

export function listPersonas() {
  const personas = [];
  if (fs.existsSync(PERSONA_DIR)) {
    for (const f of fs.readdirSync(PERSONA_DIR)) {
      if (f.endsWith(".js")) {
        const id = f.replace(".js", "");
        try {
          const filepath = path.join(PERSONA_DIR, f);
          const mod = fs.readFileSync(filepath, "utf-8");
          // simple regex to extract name
          const nameMatch = mod.match(/name:\s*"([^"]+)"/);
          const descMatch = mod.match(/description:\s*"([^"]+)"/);
          personas.push({
            id,
            name: nameMatch?.[1] || id,
            description: descMatch?.[1] || "",
          });
        } catch {}
      }
    }
  }
  return personas;
}
