/**
 * 表情包管理器
 * - 优先：本地缓存（已验证过的优质表情包）+ 用户发送的表情包
 * - 在线：API盒子 + MemeMeow 双源搜索
 * - 后备：微信原生 emoji 代码（如 [捂脸]）
 * - 无需本地文件（表情包存URL，不存文件）
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, writeJSON } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const STICKERS_DIR = path.join(DATA_DIR, "stickers");
const USER_STICKERS_FILE = "user_stickers.json";

// 关键词 → 微信 emoji 代码（在线搜索失败时使用）
const EMOJI_MAP = {
  funny:    ["[呲牙]", "[偷笑]", "[憨笑]", "[愉快]", "[坏笑]"],
  sad:      ["[流泪]", "[大哭]", "[委屈]", "[快哭了]", "[可怜]"],
  angry:    ["[发怒]", "[咒骂]", "[敲打]", "[抓狂]"],
  surprise: ["[惊讶]", "[吓]", "[发呆]", "[恐惧]"],
  praise:   ["[强]", "[鼓掌]", "[抱拳]", "[玫瑰]", "[啤酒]"],
  disdain:  ["[擦汗]", "[捂脸]", "[裂开]", "[撇嘴]", "[苦涩]"],
  sleep:    ["[困]", "[睡]", "[月亮]"],
  love:     ["[爱心]", "[亲亲]", "[玫瑰]", "[拥抱]"],
  ok:       ["[OK]", "[好的]", "[抱拳]", "[耶]", "[握手]"],
  cute:     ["[小狗]", "[小兔]", "[猪头]", "[太阳]"],
  funny2:   ["[捂脸]", "[裂开]", "[苦涩]", "[嘿哈]", "[吃瓜]", "[旺柴]"],
};

const KEYWORD_TO_CATEGORY = {
  funny:    ["搞笑","好笑","笑","哈哈","沙雕","逗","欢乐","滑稽","开心","嘿嘿","笑了","笑死"],
  sad:      ["哭","难过","伤心","泪","委屈","悲","丧","心累","emo"],
  angry:    ["生气","怒","骂","愤怒","暴躁","火大","气","爆炸"],
  surprise: ["惊讶","震惊","吃瓜","惊呆","吓","懵","恐怖","卧槽","离谱"],
  praise:   ["赞","牛","棒","厉害","6","鼓掌","优秀","强","respect","膜拜","大佬"],
  disdain:  ["嫌弃","白眼","鄙视","嘲讽","呵呵","敷衍","服了","绝了"],
  sleep:    ["晚安","睡觉","困","累","躺","休息","歇","疲惫"],
  love:     ["爱心","比心","爱","喜欢","亲亲","抱抱","想你","甜蜜","亲","贴贴"],
  ok:       ["好的","ok","收到","明白","行","懂","了解","安排"],
  cute:     ["猫","狗","萌","可爱","动物","兔","熊","宠","喵","汪","哈基米"],
  funny2:   ["捂脸","旺柴","苦涩","裂开","嘿哈","笑哭","吃瓜","加油","无语"],
};

export class StickerManager {
  constructor() {
    this._cache = readJSON("sticker_cache.json") || {};
    this._cacheHits = 0;
    this._userStickers = [];
    this._loadUserStickers();
    console.log(`[sticker] 多源搜索模式 (缓存${this._cacheSize()}张 + API盒子 + MemeMeow + 用户${this._userStickers.length}张)`);
  }

  _cacheSize() {
    let n = 0;
    for (const urls of Object.values(this._cache)) n += urls.length;
    return n;
  }

  _cacheFile() { return "sticker_cache.json"; }

  _saveCache() {
    writeJSON(this._cacheFile(), this._cache);
  }

  _loadUserStickers() {
    this._userStickers = readJSON(USER_STICKERS_FILE) || [];
  }

  _saveUserStickers() {
    writeJSON(USER_STICKERS_FILE, this._userStickers);
    fs.mkdirSync(STICKERS_DIR, { recursive: true });
  }

  /** 将成功发送的表情包URL加入缓存 */
  addToCache(keyword, url) {
    if (!this._cache[keyword]) this._cache[keyword] = [];
    if (!this._cache[keyword].includes(url)) {
      this._cache[keyword].push(url);
      if (this._cache[keyword].length > 20) {
        this._cache[keyword] = this._cache[keyword].slice(-20);
      }
      this._saveCache();
    }
  }

  /**
   * 缓存用户发送的表情包文件，后续bot可复用
   * @param {string} filePath - 本地文件路径
   * @param {string[]} keywords - 视觉模型提取的关键词
   */
  addUserSticker(filePath, keywords) {
    if (!keywords || keywords.length === 0) return;
    const entry = {
      file: filePath,
      keywords,
      addedAt: Date.now(),
    };
    this._userStickers.push(entry);
    if (this._userStickers.length > 200) {
      // 超出限制时删除最旧的，并清理文件
      const removed = this._userStickers.shift();
      try { fs.unlinkSync(removed.file); } catch {}
    }
    this._saveUserStickers();
    console.log(`[sticker] 用户表情包已缓存: ${path.basename(filePath)} → ${keywords.join(",")} (共${this._userStickers.length}张)`);
  }

  /**
   * 关键词 → 微信 emoji 代码（本地后备）
   */
  search(keyword) {
    if (!keyword) return null;
    const kw = keyword.toLowerCase();

    for (const emojis of Object.values(EMOJI_MAP)) {
      const hit = emojis.find(e => e.includes(kw));
      if (hit) {
        console.log(`[sticker] "${keyword}" → emoji ${hit}`);
        return hit;
      }
    }

    for (const [cat, keywords] of Object.entries(KEYWORD_TO_CATEGORY)) {
      const matched = keywords.some(k => kw.includes(k) || k.includes(kw));
      if (matched && EMOJI_MAP[cat]) {
        const emojis = EMOJI_MAP[cat];
        const pick = emojis[Math.floor(Math.random() * emojis.length)];
        console.log(`[sticker] "${keyword}" → emoji分类${cat} ${pick}`);
        return pick;
      }
    }

    return null;
  }

  /**
   * 在线搜索表情包，返回全部候选URL列表（最多15张）
   * 顺序：用户缓存 → url缓存 → API盒子 → MemeMeow
   */
  async searchOnline(keyword) {
    if (!keyword) return [];

    const results = [];

    // 0. 用户表情包（最高优先级，已验证过语境匹配）
    const userStickers = this._matchUserStickers(keyword);
    if (userStickers.length > 0) {
      results.push(...userStickers);
    }

    // 1. 本地URL缓存（已验证的好表情包，跳过视觉重检）
    const cached = this._cache[keyword];
    if (cached && cached.length > 0) {
      const pick = [...cached].sort(() => Math.random() - 0.5).slice(0, 5);
      const cachedList = pick.map(u => ({ url: u, filename: `cached_${Date.now()}.jpg`, fromCache: true }));
      this._cacheHits++;
      if (this._cacheHits % 5 === 0) {
        console.log(`[sticker] 缓存命中${this._cacheHits}次 (共${this._cacheSize()}张)`);
      }
      results.push(...cachedList);
    }

    if (results.length >= 8) return results;

    // 2. 在线搜索
    const online = await this._searchAllSources(keyword);
    results.push(...online);

    return results;
  }

  /** 匹配用户表情包：关键词重叠即命中 */
  _matchUserStickers(keyword) {
    const matches = [];
    for (const s of this._userStickers) {
      if (!fs.existsSync(s.file)) continue;
      const overlap = s.keywords.some(k => k.includes(keyword) || keyword.includes(k));
      if (overlap) {
        matches.push({
          file: s.file,
          filename: path.basename(s.file),
          fromFile: true,
          fromUser: true,
        });
      }
    }
    if (matches.length > 0) {
      matches.sort(() => Math.random() - 0.5);
      console.log(`[sticker] 用户表情包"${keyword}"→${matches.length}张`);
    }
    return matches.slice(0, 5);
  }

  async _searchAllSources(keyword) {
    // 1. API盒子 原词
    let results = await this._searchApihz(keyword);
    if (results.length >= 5) return results;

    // 2. API盒子 + "表情包"
    let results2 = await this._searchApihz(keyword + "表情包");
    if (results2.length > 0) {
      results.push(...results2);
      if (results.length >= 5) return results;
    }

    // 3. API盒子 + "搞笑"（宽泛兜底）
    if (results.length === 0) {
      let results3 = await this._searchApihz(keyword + "搞笑");
      if (results3.length > 0) results.push(...results3);
    }

    // 4. MemeMeow 最后兜底（减少数量，降低垃圾结果浪费的视觉API调用）
    const meow = await this._searchMemeMeow(keyword, 5);
    results.push(...meow);
    return results;
  }

  /** API盒子搜索 */
  async _searchApihz(keyword) {
    try {
      const id = "88888888";
      const key = "88888888";
      const apiUrl = `https://cn.apihz.cn/api/img/apihzbqb.php?id=${id}&key=${key}&type=2&words=${encodeURIComponent(keyword)}&limit=15`;
      const data = await this._httpGet(apiUrl);
      const result = JSON.parse(data);

      if (result.code !== 200 || !Array.isArray(result.res) || result.res.length === 0) {
        console.log(`[sticker] API盒子"${keyword}"→0张`);
        return [];
      }

      const urls = result.res;
      const rest = urls.filter(u => !u.endsWith(".gif"));
      const gifs = urls.filter(u => u.endsWith(".gif"));
      const shuffled = [...rest.sort(() => Math.random() - 0.5), ...gifs.sort(() => Math.random() - 0.5)];

      const list = shuffled.map(u => {
        const ext = u.match(/\.(gif|png|jpg|jpeg|webp)/i)?.[0] || ".jpg";
        return { url: u, filename: `${keyword}_${Date.now()}${ext}` };
      });

      console.log(`[sticker] API盒子"${keyword}"→${list.length}张 (GIF ${gifs.length})`);
      return list;
    } catch (e) {
      console.warn(`[sticker] API盒子"${keyword}"失败:`, e.message);
      return [];
    }
  }

  /** MemeMeow 自然语言表情包搜索，limit 控制数量减少浪费 */
  async _searchMemeMeow(keyword, limit = 5) {
    try {
      const apiUrl = `https://api.zvv.quest/search?q=${encodeURIComponent(keyword)}&n=${limit}`;
      const data = await this._httpGet(apiUrl);
      const result = JSON.parse(data);

      if (result.code !== 200 || !Array.isArray(result.data) || result.data.length === 0) {
        console.log(`[sticker] MemeMeow"${keyword}"→0张`);
        return [];
      }

      const urls = result.data;
      // 预过滤：排除非图片URL和已知垃圾域名，减少后续视觉API浪费
      const BAD_DOMAINS = /(?:douyin\.com\/aweme|xiaohongshu\.com\/discovery|zhihu\.com\/question|weixin\.qq\.com\/cgi-bin)/;
      const validUrls = urls.filter(u => {
        if (BAD_DOMAINS.test(u)) return false;
        // 必须有合理的图片扩展名或来自已知图床
        if (!/\.(gif|png|jpg|jpeg|webp|bmp)(\?|$)/i.test(u) && !/i\.pximg|imgur|ibb\.co|picsum|unsplash/i.test(u)) return false;
        if (u.length > 500) return false; // 超长URL通常是追踪重定向
        return true;
      });
      if (validUrls.length === 0) {
        console.log(`[sticker] MemeMeow"${keyword}"→0张 (全部被预过滤)`);
        return [];
      }
      const rest = validUrls.filter(u => !u.endsWith(".gif"));
      const gifs = validUrls.filter(u => u.endsWith(".gif"));
      const shuffled = [...rest.sort(() => Math.random() - 0.5), ...gifs.sort(() => Math.random() - 0.5)];
      const skipped = urls.length - validUrls.length;
      const list = shuffled.map(u => {
        const ext = u.match(/\.(gif|png|jpg|jpeg|webp)/i)?.[0] || ".jpg";
        return { url: u, filename: `${keyword}_${Date.now()}${ext}` };
      });

      console.log(`[sticker] MemeMeow"${keyword}"→${list.length}张${skipped > 0 ? ` (预过滤${skipped}张)` : ""} (GIF ${gifs.length})`);
      return list;
    } catch (e) {
      console.warn(`[sticker] MemeMeow"${keyword}"失败:`, e.message);
      return [];
    }
  }

  random() { return "[捂脸]"; }
  getCount() { return this._cacheSize() + this._userStickers.length; }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(this._httpGet(res.headers.location));
          return;
        }
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
  }
}
