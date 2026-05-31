import { readJSONL, appendJSONL, writeJSON, readJSON, shiftJSONL, readAllJSONL } from "./store.js";

const SUMMARIZE_THRESHOLD = 40;
const KEEP_RECENT = 30;

/** 余弦相似度 (结果 0~1，越高越相关) */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-10 ? 0 : dot / denom;
}

export class MemoryManager {
  constructor(contextWindow = 50) {
    this.contextWindow = contextWindow;
    this.memories = new Map();     // friendId -> Map<key, value>
    this.embeddings = new Map();   // friendId -> Map<key, number[]>
    this.episodic = new Map();     // friendId -> [{date, summary}, ...]
    this._chatEngine = null;
    this._summarizing = new Set();
    this._embedQueue = [];         // 待向量化队列，后台批量处理
    this._embedTimer = null;
    this._loadMemories();
    this._loadEmbeddings();
    this._loadEpisodic();
  }

  setChatEngine(engine) {
    this._chatEngine = engine;
    // 为已有记忆补生成向量（延迟启动后执行，不阻塞构造）
    setTimeout(() => this._backfillEmbeddings(), 5000);
  }

  async _backfillEmbeddings() {
    for (const [friendId, kv] of this.memories) {
      const friendEmb = this.embeddings.get(friendId) || new Map();
      for (const [key, value] of kv) {
        if (!friendEmb.has(key) && this._chatEngine) {
          const text = key + ": " + value;
          const vec = await this._chatEngine.embed(text);
          if (vec) {
            if (!this.embeddings.has(friendId)) {
              this.embeddings.set(friendId, new Map());
            }
            this.embeddings.get(friendId).set(key, vec);
            console.log(`[memory] 补向量: ${friendId}/${key}`);
          }
        }
      }
    }
    this._saveEmbeddings();
    console.log(`[memory] 补向量完成`);
  }

  // ── 持久化 ──

  _memFile() { return "memories.json"; }
  _embFile() { return "embeddings.json"; }

  _loadMemories() {
    const data = readJSON(this._memFile());
    if (data) {
      for (const [friendId, kv] of Object.entries(data)) {
        this.memories.set(friendId, new Map(Object.entries(kv)));
      }
    }
  }

  _saveMemories() {
    const data = {};
    for (const [friendId, kv] of this.memories) {
      data[friendId] = Object.fromEntries(kv);
    }
    writeJSON(this._memFile(), data);
  }

  _loadEmbeddings() {
    const data = readJSON(this._embFile());
    if (data) {
      for (const [friendId, kv] of Object.entries(data)) {
        this.embeddings.set(friendId, new Map(Object.entries(kv)));
      }
    }
  }

  _saveEmbeddings() {
    const data = {};
    for (const [friendId, kv] of this.embeddings) {
      data[friendId] = Object.fromEntries(kv);
    }
    writeJSON(this._embFile(), data);
  }

  // ── 情景记忆 ──

  _epiFile() { return "episodic.json"; }

  _loadEpisodic() {
    const data = readJSON(this._epiFile());
    if (data) {
      for (const [friendId, entries] of Object.entries(data)) {
        // 只保留14天内的
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const valid = entries.filter(e => new Date(e.date).getTime() > cutoff);
        if (valid.length > 0) this.episodic.set(friendId, valid);
      }
    }
  }

  _saveEpisodic() {
    const data = {};
    for (const [friendId, entries] of this.episodic) {
      data[friendId] = entries;
    }
    writeJSON(this._epiFile(), data);
  }

  /** 保存一天的情景摘要 */
  _saveEpisode(friendId, dateStr, summary) {
    if (!summary || summary.trim().length < 5) return;
    if (!this.episodic.has(friendId)) this.episodic.set(friendId, []);

    const entries = this.episodic.get(friendId);
    // 同一天覆盖
    const existing = entries.find(e => e.date === dateStr);
    if (existing) {
      // 合并：如果新的和旧的不同，拼在一起
      if (!existing.summary.includes(summary.trim())) {
        existing.summary = existing.summary + " " + summary.trim();
      }
    } else {
      entries.push({ date: dateStr, summary: summary.trim() });
    }
    // 只保留14天
    if (entries.length > 14) entries.splice(0, entries.length - 14);
    this._saveEpisodic();
    console.log(`[memory] 情景记忆 ${friendId}/${dateStr}: ${summary.trim().substring(0, 50)}`);
  }

  /** 按日期检索情景记忆 */
  _retrieveEpisodic(friendId, query = "") {
    const entries = this.episodic.get(friendId);
    if (!entries || entries.length === 0) return [];

    // 解析日期引用
    const dateTargets = this._parseDateRefs(query);

    if (dateTargets.length > 0) {
      // 精确日期匹配
      const results = [];
      for (const d of dateTargets) {
        const hit = entries.find(e => e.date === d);
        if (hit) results.push(hit);
      }
      if (results.length > 0) return results;
    }

    // 模糊匹配：关键词搜索情景记忆（简单关键词重叠）
    if (query && query.length > 2) {
      const tokens = query.split(/[,，。、\s]+/).filter(t => t.length > 1);
      const scored = entries.map(e => {
        let score = 0;
        for (const t of tokens) {
          if (e.summary.includes(t)) score += 1;
        }
        return { ...e, score };
      }).filter(e => e.score > 0).sort((a, b) => b.score - a.score);
      if (scored.length > 0) return scored.slice(0, 3);
    }

    return [];
  }

  /** 解析中文日期引用 → YYYY-MM-DD */
  _parseDateRefs(query) {
    if (!query) return [];
    const now = new Date();
    const results = [];

    // 今天/昨天/前天
    if (/今天|今儿/.test(query)) results.push(this._dateStr(now));
    if (/昨天|昨儿/.test(query)) results.push(this._dateStr(new Date(now - 86400000)));
    if (/前天/.test(query)) results.push(this._dateStr(new Date(now - 2 * 86400000)));

    // 大前天 = 3天前
    const daMatch = query.match(/大前天/);
    if (daMatch) results.push(this._dateStr(new Date(now - 3 * 86400000)));

    // N天前
    const dayAgoMatch = query.match(/(\d{1,2})\s*天[之以]?前/);
    if (dayAgoMatch) results.push(this._dateStr(new Date(now - parseInt(dayAgoMatch[1]) * 86400000)));

    // 周几
    const weekdayMap = { "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
    const wdMatch = query.match(/周([一二三四五六日天])/);
    const wd2Match = query.match(/星期([一二三四五六日天])/);
    const wd = wdMatch ? weekdayMap[wdMatch[1]] : wd2Match ? weekdayMap[wd2Match[1]] : null;
    if (wd !== null) {
      const todayWD = now.getDay();
      let diff = wd - todayWD;
      if (diff > 0) diff -= 7; // 本周的某天，已经在过去了
      if (diff === 0) diff = 0; // 今天
      else if (diff > 0) diff -= 7;
      results.push(this._dateStr(new Date(now + diff * 86400000)));
    }

    // 上周X
    const lwMatch = query.match(/上周([一二三四五六日天])/);
    if (lwMatch) {
      const targetWD = weekdayMap[lwMatch[1]];
      const todayWD = now.getDay();
      let diff = targetWD - todayWD - 7;
      results.push(this._dateStr(new Date(now + diff * 86400000)));
    }

    // 直接日期格式: MM-DD 或 M月D日
    const dateMatch = query.match(/(\d{1,2})[月\-](\d{1,2})[日号]?/);
    if (dateMatch) {
      const m = parseInt(dateMatch[1]);
      const d = parseInt(dateMatch[2]);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        results.push(`${now.getFullYear()}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
    }

    return results;
  }

  _dateStr(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // ── 后台向量化（不阻塞回复） ──

  _scheduleEmbed(friendId, key, value) {
    this._embedQueue.push({ friendId, key, text: key + ": " + value });
    if (!this._embedTimer) {
      this._embedTimer = setTimeout(() => this._flushEmbedQueue(), 2000);
    }
  }

  async _flushEmbedQueue() {
    this._embedTimer = null;
    const batch = this._embedQueue.splice(0);
    if (batch.length === 0 || !this._chatEngine) return;

    for (const { friendId, key, text } of batch) {
      const vec = await this._chatEngine.embed(text);
      if (vec) {
        if (!this.embeddings.has(friendId)) {
          this.embeddings.set(friendId, new Map());
        }
        this.embeddings.get(friendId).set(key, vec);
      }
    }
    this._saveEmbeddings();
    console.log(`[memory] 向量化 ${batch.length} 条记忆完成`);
  }

  // ── 上下文构建 ──

  async getContextMessages(friendId, systemPrompt, latestUserMsg = "") {
    const messages = [{ role: "system", content: systemPrompt }];

    // 语义检索相关记忆
    const relevantFacts = await this._retrieveRelevant(friendId, latestUserMsg);
    if (relevantFacts.length > 0) {
      messages[0].content += `\n\n关于对方，你记得：\n${relevantFacts.join("\n")}`;
    }

    // 情景记忆检索（跨天回忆）
    const episodes = this._retrieveEpisodic(friendId, latestUserMsg);
    if (episodes.length > 0) {
      const todayStr = this._dateStr(new Date());
      const epiLines = episodes.map(e => {
        const isToday = e.date === todayStr;
        const prefix = isToday ? `[今天稍早]` : `[${e.date}]`;
        return `${prefix} ${e.summary}`;
      });
      const note = episodes.some(e => e.date === todayStr)
        ? "\n（标记\"今天稍早\"的事是几小时前发生的，不代表你现在的状态。）" : "";
      messages[0].content += `\n\n你记得之前和对方聊过（注意：这些都是过去发生的事，不是现在正在做的事）：\n${epiLines.join("\n")}${note}`;
    }

    // 最近对话
    const recent = readJSONL(`${friendId}.jsonl`, this.contextWindow);
    for (const msg of recent) {
      messages.push({ role: msg.role, content: msg.content });
    }

    return messages;
  }

  // ── 记忆检索 ──

  async _retrieveRelevant(friendId, query) {
    const memories = this.memories.get(friendId);
    if (!memories || memories.size === 0) return [];

    if (!query || query.trim().length === 0) {
      return this._formatFacts(memories);
    }

    // 优先向量检索
    const friendEmbeddings = this.embeddings.get(friendId);
    if (friendEmbeddings && friendEmbeddings.size > 0 && this._chatEngine) {
      const result = await this._vectorRetrieve(query, memories, friendEmbeddings);
      if (result.length > 0) return result;
    }

    // 降级：关键词（向量不可用时）
    return this._keywordRetrieve(query, memories);
  }

  async _vectorRetrieve(query, memories, friendEmbeddings) {
    const queryVec = await this._chatEngine.embed(query);
    if (!queryVec) return [];

    const scored = [];
    for (const [key, vec] of friendEmbeddings) {
      if (!vec || vec.length === 0) continue;
      const sim = cosineSimilarity(queryVec, vec);
      const value = memories.get(key);
      if (value && sim > 0.35) {
        scored.push({ key, value, score: sim });
      }
    }

    // "对话摘要" 长期记忆加分
    for (const item of scored) {
      if (item.key === "对话摘要") item.score += 0.15;
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5).map(f => `- ${f.key}: ${f.value}`);
    if (top.length > 0) {
      console.log(`[memory] 向量检索命中 ${top.length} 条 (query="${query.substring(0, 20)}")`);
    }
    return top;
  }

  _keywordRetrieve(query, memories) {
    const tokens = new Set();
    for (const ch of query) {
      if (/[一-鿿]/.test(ch)) tokens.add(ch);
    }
    query.split(/\s+/).filter(w => w.length > 1).forEach(w => tokens.add(w.toLowerCase()));

    if (tokens.size === 0) return this._formatFacts(memories);

    const scored = [];
    for (const [key, value] of memories) {
      let score = 0;
      const kvText = key + value;
      for (const t of tokens) {
        if (kvText.includes(t)) score += 1;
      }
      if (key === "对话摘要") score += 2;
      if (score > 0) scored.push({ key, value, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(f => `- ${f.key}: ${f.value}`);
  }

  _formatFacts(memories) {
    const facts = [];
    for (const [k, v] of memories) {
      facts.push(`- ${k}: ${v}`);
    }
    return facts;
  }

  // ── 对话保存 ──

  saveExchange(friendId, incoming, outgoing) {
    appendJSONL(`${friendId}.jsonl`, {
      role: "user",
      content: incoming,
      time: new Date().toISOString(),
    });
    appendJSONL(`${friendId}.jsonl`, {
      role: "assistant",
      content: outgoing,
      time: new Date().toISOString(),
    });

    // 自动提取事实 (从用户消息)
    const facts = this.extractFacts(incoming);
    if (facts) {
      for (const [k, v] of Object.entries(facts)) {
        this.saveMemory(friendId, k, v);
      }
      console.log(`[memory] ${friendId}: 自动提取事实 ${Object.keys(facts).join(", ")}`);
    }

    // 异步摘要
    if (this._chatEngine && !this._summarizing.has(friendId)) {
      setImmediate(() => this._trySummarize(friendId));
    }
  }

  // ── 摘要 ──

  async _trySummarize(friendId) {
    if (this._summarizing.has(friendId)) return;
    this._summarizing.add(friendId);
    try {
      const oldEntries = shiftJSONL(`${friendId}.jsonl`, KEEP_RECENT);
      if (oldEntries.length < 4) return;

      console.log(`[memory] ${friendId}: 开始摘要 ${oldEntries.length} 条旧对话`);

      const lines = [];
      for (const e of oldEntries) {
        const role = e.role === "user" ? "对方" : "我";
        const time = e.time ? e.time.substring(0, 16) : "";
        lines.push(`${time} ${role}: ${e.content}`);
      }
      const conversationText = lines.join("\n");

      const summary = await this._chatEngine.chatSimple([
        {
          role: "system",
          content: `你是对话摘要助手。从聊天记录中提取值得记住的关键信息。忽略寒暄、表情、日常废话。
只提取：个人事实（名字、职业、地点、爱好、宠物）、约定/计划（时间地点）、明确偏好（喜欢/讨厌什么）、重要经历（换工作、搬家、分手等）。
用简洁中文，每条一行，格式："- 事实描述"。如果没有任何值得记的内容，输出"无"。`,
        },
        { role: "user", content: conversationText },
      ], { temperature: 0.3, maxTokens: 300 });

      if (!summary || summary.includes("无")) {
        console.log(`[memory] ${friendId}: 摘要结果为空，跳过`);
        return;
      }

      const existing = this.memories.get(friendId)?.get("对话摘要") || "";
      const merged = existing
        ? existing + "\n" + summary
        : summary;
      this.saveMemory(friendId, "对话摘要", merged);
      console.log(`[memory] ${friendId}: 摘要完成 (${summary.length}字)`);

      // 同时生成情景记忆（按日期归档，用于跨天回忆）
      const todayStr = this._dateStr(new Date());
      const epiSummary = await this._chatEngine.chatSimple([
        {
          role: "system",
          content: `你是对话情景记录助手。根据今天的聊天记录，用一两句话总结今天和对方聊了什么、发生了什么值得记住的事。
用第一人称"我"的视角（你就是说话者本人），像写日记一样自然。
只输出总结本身，不要加"今天"开头，不要加引号。不超过60字。如果只是纯寒暄没实质性内容，输出"无"。`,
        },
        { role: "user", content: conversationText },
      ], { temperature: 0.4, maxTokens: 150 });

      if (epiSummary && epiSummary !== "无") {
        this._saveEpisode(friendId, todayStr, epiSummary);
      }
    } catch (e) {
      console.error(`[memory] 摘要失败 ${friendId}:`, e.message);
    } finally {
      this._summarizing.delete(friendId);
    }
  }

  // ── 每日总结（每天23:55触发，确保短对话也能被记住）──

  async dailySummarize(friendId) {
    if (!this._chatEngine) return;

    const todayStr = this._dateStr(new Date());
    const all = readAllJSONL(`${friendId}.jsonl`);

    // 只取今天的消息
    const todayMsgs = all.filter(e => e.time && e.time.startsWith(todayStr));
    if (todayMsgs.length < 2) {
      console.log(`[memory] ${friendId}: 今天消息太少(${todayMsgs.length}条)，跳过每日总结`);
      return;
    }

    console.log(`[memory] ${friendId}: 开始每日总结 (${todayMsgs.length}条)`);

    const lines = todayMsgs.map(e => {
      const role = e.role === "user" ? "对方" : "我";
      const time = e.time ? e.time.substring(11, 16) : "";
      return `${time} ${role}: ${e.content}`;
    });

    // 检查今天是否已有情景记忆（合并而不是覆盖）
    const existingEpi = this.episodic.get(friendId)?.find(e => e.date === todayStr);

    // 生成情景总结
    const epiSummary = await this._chatEngine.chatSimple([
      {
        role: "system",
        content: `你是对话情景记录助手。根据今天的聊天记录，用一两句话总结今天和对方聊了什么、发生了什么值得记住的事。
用第一人称"我"的视角（你就是说话者本人），像写日记一样自然。
只输出总结本身，不要加"今天"开头，不要加引号。不超过60字。如果只是纯寒暄没实质性内容，输出"无"。`,
      },
      { role: "user", content: lines.join("\n") },
    ], { temperature: 0.4, maxTokens: 150 });

    if (epiSummary && epiSummary !== "无") {
      this._saveEpisode(friendId, todayStr, epiSummary);
    }

    // 生成事实提取
    const factSummary = await this._chatEngine.chatSimple([
      {
        role: "system",
        content: `你是对话摘要助手。从聊天记录中提取值得记住的关键信息。忽略寒暄、表情、日常废话。
只提取：个人事实（名字、职业、地点、爱好、宠物）、约定/计划（时间地点）、明确偏好（喜欢/讨厌什么）、重要经历。
用简洁中文，每条一行，格式："- 事实描述"。如果没有任何值得记的内容，输出"无"。`,
      },
      { role: "user", content: lines.join("\n") },
    ], { temperature: 0.3, maxTokens: 300 });

    if (factSummary && factSummary !== "无") {
      const existing = this.memories.get(friendId)?.get("对话摘要") || "";
      const merged = existing ? existing + "\n" + factSummary : factSummary;
      this.saveMemory(friendId, "对话摘要", merged);
    }

    console.log(`[memory] ${friendId}: 每日总结完成`);
  }

  // ── 事实提取 ──

  extractFacts(text) {
    const facts = {};

    const nameHit = text.match(/(?:我叫|我是|叫我|名字是)\s*([一-龥a-zA-Z]{1,8})(?:，|。|啦|哈|的|$|!|！)/);
    const notNames = /^(起床|睡觉|吃饭|喝水|走路|跑步|洗澡|上班|下班|上课|下课|开门|关门|出去|回来|走了|来了|好的?|嗯嗯?|哈哈|呵呵|嘿嘿|哦哦?|行吧|可以|是的?|没有|不是|不用|没事|无聊|还行|一般|还行吧|还好|好吧|算了|随便|都可|都可以|也[行可以对]?|不.*[知道清楚了]|谢谢|再见|拜拜|晚安|早安|你好|大家好|有人吗|在吗|在不在|在干嘛|干嘛呢|睡了|醒了|饿了|累了|困了|忙了|闲着|无聊了|过去了|快了|好了|到了|知道了|明白了|了解了|记住了|忘了|想起来了|想不起来了|怎么办|怎么说|怎么弄|怎么搞|怎么了|咋了|啥了|那行|那算了|那好吧|那随便|那可以|那也[行对]|那就|这行|这可以|这不好|这也是|这也是吗|这是|那是|我也[是想觉得]|我没有?|我不是?|我不[知懂会能行敢想怕怕喜欢爱恨讨厌烦嫌怕信]|你说的?|对的?|不对的?|是这样的?|不是这样的?|真的吗|假的吧|骗人|吹牛|厉害了|厉害了|牛逼|牛啊|真的假的|不会吧|不是吧|太好了|太棒了|太强了|太弱了|太差了|太贵了|太便宜了|太难了|太简单了|太多了|太少了|太高了|太低了|太远了|太近了|太热了|太冷了|太快了|太慢了|太吵了|太安静了|太多了|太大了|太小了)/;
    if (nameHit && !/AI|机器人|人工智能/.test(nameHit[1]) && !notNames.test(nameHit[1])) facts["称呼"] = nameHit[1];

    const jobHit = text.match(/(?:我是|我在|做|搞)\s*(?:一[个份]|.){0,4}?(程序员|码农|工程师|设计师|老师|医生|护士|学生|上班|实习|自由职业|创业|运营|产品经理|销售|市场|HR|财务|行政|客服|外卖|快递|司机|厨师|理发|健身教练|教练|保安|主播|自媒体|写手|编辑|画师|摄影师|音乐人|公务员|事业编|国企|外包|在读|考研|考公|待业|找工作)/);
    if (jobHit) facts["职业"] = jobHit[0].replace(/^一[个份]/, "");

    const locHit = text.match(/(?:我在|我住|我在|坐标)\s*([一-龥]{2,4})(?:市|省)?(?:，|。|的|$|!|！|这|那)/);
    if (locHit) facts["所在地"] = locHit[1];

    const likeHit = text.match(/(?:我喜欢|我爱|我会|我平时|我经常|偶尔)\s*.{0,30}?(打游戏|打LOL|打王者|打原神|打吃鸡|看书|运动|健身|跑步|游泳|篮球|足球|羽毛球|乒乓球|网球|骑车|爬山|旅行|旅游|看电影|看剧|追剧|听歌|唱歌|跳舞|画画|拍照|摄影|做饭|烘焙|养猫|养狗|养鱼|种花|打牌|麻将|桌游|剧本杀|密室|蹦迪|喝酒|奶茶|咖啡|美食|逛街|手办|模型|乐高|Switch|PS5|cosplay|二次元)/);
    if (likeHit) facts["爱好"] = likeHit[0];

    if (/(?:养了|养的|我家|养过).{0,10}(?:猫|狗|鱼|仓鼠|兔子|鸟|鹦鹉|乌龟|龙猫|荷兰猪|柯基|金毛|泰迪|布偶|英短|美短|橘猫|狸花猫|蓝猫)/.test(text)) {
      const petHit = text.match(/(?:养了|养的|我家|养过).{0,10}(?:猫|狗|鱼|仓鼠|兔子|鸟|鹦鹉|乌龟|龙猫|荷兰猪|柯基|金毛|泰迪|布偶|英短|美短|橘猫|狸花猫|蓝猫)/);
      if (petHit) facts["宠物"] = petHit[0];
    }

    const ageHit = text.match(/(?:我|今年)\s*(\d{1,2})\s*(?:岁|了)/);
    if (ageHit && parseInt(ageHit[1]) >= 10 && parseInt(ageHit[1]) <= 80) facts["年龄"] = ageHit[1] + "岁";

    if (/失恋|分手|被甩/.test(text)) facts["近期状态"] = "刚失恋";
    if (/找到工作|入职|上岸|拿了offer/.test(text)) facts["近期状态"] = "刚找到工作";
    if (/辞职|裸辞|离职|被裁/.test(text)) facts["近期状态"] = "辞职了";
    if (/考试|期末|期中|备考|复习/.test(text)) facts["近期状态"] = "考试期";
    if (/脱单|恋爱|在一起/.test(text)) facts["近期状态"] = "恋爱中";

    return Object.keys(facts).length > 0 ? facts : null;
  }

  // ── 记忆 CRUD ──

  saveMemory(friendId, key, value) {
    if (!this.memories.has(friendId)) {
      this.memories.set(friendId, new Map());
    }
    this.memories.get(friendId).set(key, value);
    this._saveMemories();

    // 后台向量化（不阻塞）
    if (this._chatEngine) {
      this._scheduleEmbed(friendId, key, value);
    }
  }

  getMemoryContext(friendId) {
    const memories = this.memories.get(friendId);
    if (!memories || memories.size === 0) return "";

    const facts = [];
    for (const [k, v] of memories) {
      facts.push(`- ${k}: ${v}`);
    }
    return facts.join("\n");
  }
}
