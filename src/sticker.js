/**
 * 表情包管理器
 * - 优先：本地分类表情包文件（stickers/，零API成本）
 * - 其次：用户发送的表情包
 * - 在线：发表情(fabiaoqing.com)
 * - 后备：微信原生 emoji 代码（如 [捂脸]）
 */
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, writeJSON } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const STICKERS_DIR = path.join(DATA_DIR, "stickers");
const LOCAL_STICKERS_DIR = path.resolve(__dirname, "..", "stickers");
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
    this._userStickers = [];
    this._loadUserStickers();
    const localCount = fs.existsSync(LOCAL_STICKERS_DIR) ?
      fs.readdirSync(LOCAL_STICKERS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .reduce((sum, d) => sum + fs.readdirSync(path.join(LOCAL_STICKERS_DIR, d.name)).filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f)).length, 0) : 0;
    console.log(`[sticker] 本地${localCount}张 + 用户${this._userStickers.length}张 + 发表情(fabiaoqing.com)`);
  }

  _loadUserStickers() {
    this._userStickers = readJSON(USER_STICKERS_FILE) || [];
  }

  _saveUserStickers() {
    writeJSON(USER_STICKERS_FILE, this._userStickers);
    fs.mkdirSync(STICKERS_DIR, { recursive: true });
  }

  /**
   * 缓存用户发送的表情包文件，后续bot可复用
   * @param {string} filePath - 本地文件路径
   * @param {string[]} keywords - 视觉模型提取的关键词
   */
  addUserSticker(filePath, keywords, md5) {
    if (!keywords || keywords.length === 0) return;
    const entry = {
      file: filePath,
      keywords,
      md5: md5 || null,
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

  /** 检查是否已存在相同MD5的表情包（内容去重） */
  hasStickerByMD5(md5) {
    if (!md5) return false;
    return this._userStickers.some(s => s.md5 === md5);
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
   * 搜索表情包，返回全部候选列表（最多15张）
   * 顺序：本地文件 → 用户缓存 → 发表情(fabiaoqing.com)
   */
  async searchOnline(keyword) {
    if (!keyword) return [];

    const results = [];

    // 1. 本地表情包文件（最高优先级，分类存储，零API成本）
    const localStickers = this._searchLocal(keyword);
    if (localStickers.length > 0) {
      results.push(...localStickers);
    }

    // 2. 用户表情包
    const userStickers = this._matchUserStickers(keyword);
    if (userStickers.length > 0) {
      results.push(...userStickers);
    }

    if (results.length >= 8) return results;

    // 3. 在线搜索
    const online = await this._searchAllSources(keyword);
    results.push(...online);

    return results;
  }

  /** 搜索本地分类表情包文件，关键词→分类目录匹配 */
  _searchLocal(keyword) {
    if (!keyword || !fs.existsSync(LOCAL_STICKERS_DIR)) return [];

    const kw = keyword.toLowerCase();
    const matchedCategories = [];
    for (const [cat, keywords] of Object.entries(KEYWORD_TO_CATEGORY)) {
      if (keywords.some(k => kw.includes(k) || k.includes(kw))) {
        matchedCategories.push(cat);
      }
    }

    const files = [];
    for (const cat of matchedCategories) {
      // funny2 没有对应目录，回退到 funny
      const catDir = path.join(LOCAL_STICKERS_DIR, cat);
      if (!fs.existsSync(catDir)) {
        // 尝试去掉数字后缀 (funny2→funny)
        const baseCat = cat.replace(/\d+$/, "");
        const altDir = path.join(LOCAL_STICKERS_DIR, baseCat);
        if (altDir !== catDir && fs.existsSync(altDir)) {
          const catFiles = fs.readdirSync(altDir)
            .filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f))
            .map(f => ({
              file: path.join(altDir, f),
              filename: f,
              fromFile: true,
              fromLocal: true,
            }));
          files.push(...catFiles);
        }
        continue;
      }
      const catFiles = fs.readdirSync(catDir)
        .filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f))
        .map(f => ({
          file: path.join(catDir, f),
          filename: f,
          fromFile: true,
          fromLocal: true,
        }));
      files.push(...catFiles);
    }

    // 当分类匹配结果不足时，从 general/ 补充（避免死数据）
    const generalDir = path.join(LOCAL_STICKERS_DIR, "general");
    if (files.length < 5 && fs.existsSync(generalDir)) {
      const generalFiles = fs.readdirSync(generalDir)
        .filter(f => /\.(gif|png|jpg|jpeg|webp)$/i.test(f))
        .map(f => ({
          file: path.join(generalDir, f),
          filename: f,
          fromFile: true,
          fromLocal: true,
          fromGeneral: true,
        }));
      files.push(...generalFiles);
    }

    if (files.length > 0) {
      files.sort(() => Math.random() - 0.5);
      console.log(`[sticker] 本地"${keyword}"→${matchedCategories.join(",") || "general"}→${files.length}张`);
    }
    return files.slice(0, 5);
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
    // 唯一在线源：发表情(fabiaoqing.com) — 免费、无水印、质量好
    let results = await this._searchFabiaoqing(keyword);
    if (results.length >= 5) return results;

    // 首次不理想，加"表情包"后缀再试
    const r2 = await this._searchFabiaoqing(keyword + "表情包");
    results.push(...r2);
    return results;
  }

  /** 发表情(fabiaoqing.com) — HTML解析提取图片URL，免费无水印 */
  async _searchFabiaoqing(keyword) {
    try {
      // 直接请求最终页面，避免相对路径302重定向问题
      const apiUrl = `https://www.fabiaoqing.com/search/bqb/keyword/${encodeURIComponent(keyword)}/type/bq/page/1.html`;
      const html = await this._httpGet(apiUrl);

      // 提取懒加载的 data-original 属性（img.soutula.com CDN）
      const imgRegex = /data-original="(https:\/\/img\.soutula\.com\/[^"]+)"/g;
      const urls = [];
      let m;
      while ((m = imgRegex.exec(html)) !== null) {
        // bmiddle → large 获取高清版
        const url = m[1].replace(/\/bmiddle\//, "/large/");
        if (!urls.includes(url)) urls.push(url);
      }

      if (urls.length === 0) {
        console.log(`[sticker] 发表情"${keyword}"→0张`);
        return [];
      }

      const rest = urls.filter(u => !u.endsWith(".gif"));
      const gifs = urls.filter(u => u.endsWith(".gif"));
      const shuffled = [...rest.sort(() => Math.random() - 0.5), ...gifs.sort(() => Math.random() - 0.5)];

      const list = shuffled.map(u => {
        const ext = u.match(/\.(gif|png|jpg|jpeg|webp)/i)?.[0] || ".jpg";
        return { url: u, filename: `fbq_${Date.now()}${ext}` };
      });

      console.log(`[sticker] 发表情"${keyword}"→${list.length}张 (GIF ${gifs.length})`);
      return list;
    } catch (e) {
      console.warn(`[sticker] 发表情"${keyword}"失败:`, e.message);
      return [];
    }
  }

  getCount() { return this._userStickers.length; }

  _httpGet(url, baseHost = "") {
    return new Promise((resolve, reject) => {
      https.get(url, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          // 处理相对路径重定向
          if (redirectUrl.startsWith("/")) {
            const u = new URL(url);
            redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
          }
          resolve(this._httpGet(redirectUrl, baseHost));
          return;
        }
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
  }
}
