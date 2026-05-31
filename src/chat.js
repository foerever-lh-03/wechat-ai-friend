import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

export class ChatEngine {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.totalTokens = 0;
    this._buildClient();
  }

  _buildClient() {
    const apiKey = this.config.deepseekApiKey;
    const baseURL = this.config.deepseekBaseUrl || "https://api.deepseek.com";

    if (apiKey) {
      this.client = new OpenAI({ apiKey, baseURL });
    }
  }

  get isReady() {
    return this.client !== null;
  }

  /** 基础单轮调用 */
  async _call(messages, options = {}) {
    if (!this.client) {
      throw new Error("DeepSeek API key 未配置");
    }

    const model = this.config.deepseekModel || "deepseek-chat";
    const temperature = options.temperature ?? 0.85;
    const maxTokens = options.maxTokens ?? 80;
    const withTools = options.tools ?? null;
    const thinking = options.thinking ?? false;
    const reasoningEffort = options.reasoningEffort ?? "medium";

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 思考模式需要更高 token 预算（thinking token 计入 max_tokens）
        const effectiveMaxTokens = thinking ? Math.max(maxTokens, 400) : maxTokens;

        const params = {
          model,
          messages,
          temperature,
          max_tokens: effectiveMaxTokens,
          presence_penalty: 0.6,
          frequency_penalty: 0.5,
          top_p: 0.95,
        };

        if (thinking) {
          params.extra_body = {
            thinking: { type: "enabled", reasoning_effort: reasoningEffort },
          };
        }

        if (withTools && withTools.length > 0) {
          params.tools = withTools;
        }

        const response = await this.client.chat.completions.create(params);

        if (response.usage) {
          this.totalTokens += response.usage.total_tokens;
        }
        return response.choices[0]?.message;
      } catch (e) {
        console.warn(`[chat] API 调用失败 (${attempt + 1}/3):`, e.message);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          throw e;
        }
      }
    }
    return null;
  }

  /**
   * Agent 模式：支持 tool calling 的对话
   * 模型可以主动调用 web_search 等工具获取信息，再组织回复
   */
  async chat(messages, options = {}) {
    const maxTokens = options.maxTokens ?? 80;
    const temperature = options.temperature ?? 0.85;
    const enableTools = options.enableTools !== false;
    const thinking = options.thinking ?? false;
    const reasoningEffort = options.reasoningEffort ?? "medium";

    if (!enableTools) {
      const msg = await this._call(messages, { temperature, maxTokens, thinking, reasoningEffort });
      return msg?.content?.trim() || "";
    }

    // 克隆 messages 避免污染原始
    const ctx = messages.map(m => ({ role: m.role, content: m.content }));

    // 第一轮：模型可调用工具搜索信息
    let msg = await this._call(ctx, {
      temperature,
      maxTokens: Math.max(maxTokens, 150),
      tools: TOOL_DEFINITIONS,
      thinking,
      reasoningEffort,
    });

    if (!msg) return "";

    // 工具调用循环（最多2轮，防止死循环）
    for (let round = 0; round < 2; round++) {
      const toolCall = msg.tool_calls?.[0];
      if (!toolCall) break;

      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments || "{}");
      console.log(`[agent] 调用工具: ${fnName}(${JSON.stringify(fnArgs)})`);

      const result = await executeTool(fnName, fnArgs, this, options.sceneContext);

      ctx.push({
        role: "assistant",
        content: null,
        tool_calls: [toolCall],
      });
      ctx.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result || "未找到相关信息",
      });

      const fallbackMaxTokens = Math.max(maxTokens, 120);
      msg = await this._call(ctx, { temperature, maxTokens: fallbackMaxTokens, tools: TOOL_DEFINITIONS, thinking, reasoningEffort });
      if (!msg) return "";

      if (msg.tool_calls?.[0] && round === 1) {
        ctx.push({
          role: "system",
          content: "搜索已达上限，请基于你已有的知识直接回答，用自然的口吻说。如果不确定就诚实说不太清楚。",
        });
        msg = await this._call(ctx, { temperature, maxTokens: fallbackMaxTokens, tools: [], thinking, reasoningEffort });
        if (!msg) return "";
      }
    }

    return msg.content?.trim() || "";
  }

  /**
   * 纯文本调用（无工具），保留兼容
   */
  async chatSimple(messages, options = {}) {
    const msg = await this._call(messages, {
      temperature: options.temperature ?? 0.85,
      maxTokens: options.maxTokens ?? 80,
    });
    return msg?.content?.trim() || "";
  }

  /**
   * 文本向量化 (智谱 embedding-2, 1024维, 免费)
   * 用于语义记忆检索，余弦相似度匹配
   * 智谱失败时回退 DeepSeek
   */
  async embed(text) {
    // 优先智谱 embedding（免费，API key 已验证）
    const zhipuKey = this.config.visionApiKey;
    if (zhipuKey) {
      try {
        const zhipuClient = new OpenAI({
          apiKey: zhipuKey,
          baseURL: "https://open.bigmodel.cn/api/paas/v4/",
        });
        const response = await zhipuClient.embeddings.create({
          model: "embedding-2",
          input: text,
        });
        const vec = response.data[0]?.embedding;
        if (vec) {
          console.log(`[embed] 智谱向量化 (${vec.length}维)`);
          return vec;
        }
      } catch (e) {
        console.warn(`[embed] 智谱 embedding 失败:`, e.message);
      }
    }

    // 回退 DeepSeek
    if (!this.client) return null;
    try {
      const response = await this.client.embeddings.create({
        model: "deepseek-embedding",
        input: text,
      });
      const vec = response.data[0]?.embedding;
      if (vec) console.log(`[embed] DeepSeek向量化 (${vec.length}维)`);
      return vec || null;
    } catch (e) {
      console.warn(`[embed] DeepSeek embedding 失败:`, e.message);
      return null;
    }
  }

  /**
   * AI 图片生成
   * 使用智谱 CogView-3-Flash（免费），下载后裁剪底部水印
   * 返回本地文件路径，失败返回 null
   * @param {string} prompt - 图片描述
   * @param {object} options - { lighting: "day"|"night"|"auto"|custom string }
   */
  async generateImage(prompt, options = {}) {
    const visionKey = this.config.visionApiKey;
    if (!visionKey) {
      console.log("[image-gen] 智谱 API key 未配置");
      return null;
    }

    const visionClient = new OpenAI({
      apiKey: visionKey,
      baseURL: "https://open.bigmodel.cn/api/paas/v4/",
    });

    // 时间感知光线：根据当前时间自动推断场景氛围
    let lightingHint;
    const lighting = options.lighting || "auto";
    if (lighting !== "auto") {
      lightingHint = lighting === "day" ? "自然光线" : lighting === "night" ? "夜晚室内温暖灯光" : lighting;
    } else {
      const hour = new Date().getHours();
      if (hour >= 20 || hour < 6) {
        lightingHint = "夜晚，室内温暖灯光";
      } else if (hour >= 18 || hour < 7) {
        lightingHint = "傍晚，暖色调灯光";
      } else {
        lightingHint = "自然光线";
      }
    }
    const fullPrompt = `${prompt}，照片级真实感，${lightingHint}`;

    try {
      const response = await visionClient.images.generate({
        model: "cogview-3-flash",
        prompt: fullPrompt,
        n: 1,
        size: "1024x1024",
      });

      const url = response.data[0]?.url;
      if (!url) {
        console.log("[image-gen] CogView 返回空URL");
        return null;
      }
      console.log(`[image-gen] CogView 生成: ${fullPrompt.substring(0, 50)}`);

      // 下载 + 裁剪底部水印 + 保存本地
      const localPath = await this._downloadAndInpaint(url);
      return localPath || url; // 裁剪失败则返回原始URL兜底
    } catch (e) {
      console.warn(`[image-gen] CogView 失败:`, e.message);
      return null;
    }
  }

  /** 下载图片并用 inpainting 去除底部水印（检测半透明白色文字 → 水平插值） */
  async _downloadAndInpaint(url) {
    try {
      const { Jimp } = await import("jimp");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!response.ok) return null;

      const buffer = Buffer.from(await response.arrayBuffer());
      const img = await Jimp.read(buffer);
      const { width: w, height: h, data } = img.bitmap;
      const roiTop = Math.floor(h * 0.85);   // 底部15%区域
      const winHalf = 15;                     // 水平窗口半宽

      for (let y = roiTop; y < h; y++) {
        const rowOff = y * w * 4;

        // Pass 1: 检测水印像素
        // 水印特征：白色/浅灰（RGB接近且都偏高），且比局部背景更亮
        const flags = new Uint8Array(w);
        for (let x = 0; x < w; x++) {
          const i = rowOff + x * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
          const saturation = maxC - minC;
          const brightness = (r + g + b) / 3;
          // 白色文字：低饱和（RGB接近）、高亮度
          const isWhiteish = saturation < 40 && brightness > 170;
          if (!isWhiteish) continue;

          // 与水平窗口中非白像素的亮度对比
          let bgSum = 0, bgCnt = 0;
          const x0 = Math.max(0, x - winHalf), x1 = Math.min(w - 1, x + winHalf);
          for (let wx = x0; wx <= x1; wx++) {
            const wi = rowOff + wx * 4;
            const wr = data[wi], wg = data[wi + 1], wb = data[wi + 2];
            const wSat = Math.max(wr, wg, wb) - Math.min(wr, wg, wb);
            if (wSat > 30 || (wr + wg + wb) / 3 < 170) { // 非白像素=背景
              bgSum += (wr + wg + wb) / 3;
              bgCnt++;
            }
          }
          if (bgCnt >= 3 && brightness > bgSum / bgCnt + 35) {
            flags[x] = 1;
          }
        }

        // Pass 2: 合并连续段（容忍 ≤4px 间隙）
        const mask = [];
        let seg = null;
        for (let x = 0; x < w; x++) {
          if (flags[x]) {
            if (!seg) seg = { start: x, end: x };
            else seg.end = x;
          } else if (seg) {
            let gapEnd = x;
            while (gapEnd < w && !flags[gapEnd] && gapEnd - x < 4) gapEnd++;
            if (gapEnd < w && flags[gapEnd]) { seg.end = gapEnd; x = gapEnd; }
            else { if (seg.end - seg.start >= 2) mask.push(seg); seg = null; }
          }
        }
        if (seg && seg.end - seg.start >= 2) mask.push(seg);

        // Pass 3: 水平插值填充
        for (const seg of mask) {
          const s = seg.start, e = seg.end;
          const len = e - s + 1;
          for (let dx = 0; dx < len; dx++) {
            const x = s + dx;
            const ti = rowOff + x * 4;
            const t = (dx + 1) / (len + 1);

            // 找左邻非水印像素（可跨段外）
            let lr = -1, lg = -1, lb = -1;
            for (let lx = s - 1; lx >= Math.max(0, s - 30); lx--) {
              if (!flags[lx]) { const li = rowOff + lx * 4; lr = data[li]; lg = data[li + 1]; lb = data[li + 2]; break; }
            }
            let rr = -1, rg = -1, rb = -1;
            for (let rx = e + 1; rx < Math.min(w, e + 30); rx++) {
              if (!flags[rx]) { const ri = rowOff + rx * 4; rr = data[ri]; rg = data[ri + 1]; rb = data[ri + 2]; break; }
            }
            // 水平方向找不到就用上方像素
            if (lr < 0) {
              const aboveI = (Math.max(roiTop, y - 1) * w + x) * 4;
              lr = data[aboveI]; lg = data[aboveI + 1]; lb = data[aboveI + 2];
            }
            if (rr < 0) rr = lr, rg = lg, rb = lb;

            data[ti]     = Math.round(lr * (1 - t) + rr * t);
            data[ti + 1] = Math.round(lg * (1 - t) + rg * t);
            data[ti + 2] = Math.round(lb * (1 - t) + rb * t);
            data[ti + 3] = 255;
          }
        }
      }

      const processed = await img.getBuffer("image/jpeg", { quality: 92 });
      const dir = path.resolve("/app/data/generated");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `gen_${Date.now()}.jpg`);
      fs.writeFileSync(filePath, processed);
      console.log(`[image-gen] inpainting去水印(${w}x${h}) → ${path.basename(filePath)}`);
      return filePath;
    } catch (e) {
      console.warn(`[image-gen] inpainting失败:`, e.message);
      return null;
    }
  }

  /** 图片识别：通过智谱 GLM-4V-Flash 将图片转为文字描述 */
  async describeImage(base64, mimeType = "image/jpeg") {
    const visionKey = this.config.visionApiKey;
    if (!visionKey) {
      console.log("[vision] 智谱 API key 未配置，跳过图片识别");
      return "";
    }

    const visionClient = new OpenAI({
      apiKey: visionKey,
      baseURL: "https://open.bigmodel.cn/api/paas/v4/",
    });

    const model = this.config.visionModel || "glm-4.6v-flash";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "用简短中文描述这张图片的内容，1-2句话。如果是表情包/梗图，描述画面+文字。如果是普通照片，描述场景。不要加任何前缀如'这张图片'。",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await visionClient.chat.completions.create({
          model,
          messages,
          max_tokens: 80,
          temperature: 0.3,
        });
        return response.choices[0]?.message?.content?.trim() || "";
      } catch (e) {
        console.warn(`[vision] 智谱调用失败 (${attempt + 1}/2):`, e.message);
        if (attempt < 1) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return "";
  }

  /**
   * 识别表情包图片并判断是否与目标关键词匹配
   * 返回 { text, meaning, match, reason } 或 null
   */
  async readStickerText(base64, mimeType, keyword, replyContext = "") {
    const visionKey = this.config.visionApiKey;
    if (!visionKey) return null;

    const visionClient = new OpenAI({
      apiKey: visionKey,
      baseURL: "https://open.bigmodel.cn/api/paas/v4/",
    });

    const model = this.config.visionModel || "glm-4v-flash";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `分析这张表情包，判断它是否适合用来表达"${keyword}"这个情绪/话题。

返回JSON（不要任何其他文字）：
{"text":"图片上的所有文字","meaning":"表情包的情绪/含义(5字内)","match":true/false,"reason":"匹配/不匹配的简短原因(10字内)"}

${replyContext ? `这张表情包将会附在以下回复中发送给对方：\n"${replyContext}"\n` : ""}判断match的标准（画面+文字结合当前语境综合判断）：
- 首先看画面和文字整体是否适合表达"${keyword}"这个情绪/话题 → 不符合就false
${replyContext ? "- 再看图片上的文字是否和上面的回复语境协调——如果文字会扭曲、冲淡、甚至反转回复的意思 → false\n" : ""}- 文字是不相关的广告、互赞、求关注、游戏ID等 → false
- 综合考虑后画面+文字适合当前聊天场景 → true`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ];

    try {
      const response = await visionClient.chat.completions.create({
        model,
        messages,
        max_tokens: 100,
        temperature: 0.1,
      });
      let raw = response.choices[0]?.message?.content?.trim() || "";
      // 剥离markdown代码块（智谱有时返回 ```json ... ``` 格式）
      raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      try { return JSON.parse(raw); } catch {
        console.warn(`[vision] JSON解析失败，原始返回: ${raw.substring(0, 80)}`);
        return { text: "", meaning: "", match: false, reason: "解析失败-拒绝" };
      }
    } catch (e) {
      console.warn(`[vision] 表情包文字识别失败:`, e.message);
      return null;
    }
  }

  /**
   * 分析用户发的表情包，提取关键词用于后续复用
   * 返回 { keywords: string[], meaning: string } 或 null
   */
  async tagSticker(base64, mimeType) {
    const visionKey = this.config.visionApiKey;
    if (!visionKey) return null;

    const visionClient = new OpenAI({
      apiKey: visionKey,
      baseURL: "https://open.bigmodel.cn/api/paas/v4/",
    });

    const model = this.config.visionModel || "glm-4v-flash";
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `分析这张表情包，提取关键信息用于后续搜索复用。

返回JSON（不要任何其他文字）：
{"meaning":"表情包表达的情绪/含义(5字内)","keywords":["关键词1","关键词2","关键词3"]}

关键词要求：2-5个中文关键词，覆盖情绪和话题，例如"好笑""无语""猫""吃瓜""晚安"。关键词要与表情包的画面+文字直接相关。`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ];

    try {
      const response = await visionClient.chat.completions.create({
        model,
        messages,
        max_tokens: 80,
        temperature: 0.1,
      });
      let raw = response.choices[0]?.message?.content?.trim() || "";
      raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      try { return JSON.parse(raw); } catch {
        console.warn(`[vision] tagSticker JSON解析失败: ${raw.substring(0, 80)}`);
        return null;
      }
    } catch (e) {
      console.warn(`[vision] tagSticker 失败:`, e.message);
      return null;
    }
  }
}
