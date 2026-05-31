/**
 * 自我状态追踪（带时间线）— bot 的位置/活动随时间和对话自然演进
 *
 * 核心逻辑：
 * 1. 时间驱动自动切换：工作日 9:30→公司，18:30→家，中间有通勤过渡
 * 2. bot 自己的话可覆盖时间推断（如"请假在家"）
 * 3. 保留当天时间线，prompt 中展示完整轨迹
 */
import { readJSON, writeJSON } from "./store.js";

const STATE_FILE = "self_state.json";

const LOC_NAME = { office: "在公司", commuting: "在路上/通勤中", home: "在家", out: "在外面" };
const ACT_NAME = {
  working: "正在工作", commuting: "在通勤路上", eating: "在吃饭",
  resting: "在休息", gaming: "在打游戏", watching: "在刷手机/看视频",
  cleaning: "在收拾东西", withCat: "在和猫在一起",
};

// ── 规则 ──

const LOCATION_RULES = [
  { loc: "office",  re: /(?:到|在|回|去)\s*(?:公司|单位|办公室|工位|上班)|开会|加班(?!到)|同事.*(?:找|叫我|过来)|老板.*(?:找|叫|喊|让)|请假(?!.*在家)/ },
  { loc: "commuting", re: /(?:在|去)\s*(?:路上|地铁|公交|通勤|打车)|刚?出门.*上班|赶.*地铁|挤.*地铁|堵.*路上/ },
  { loc: "home",   re: /(?:在|回|到|躺)\s*(?:家|屋里|房间|床上|沙发)|猫.*(?:在|趴|睡|打翻|闹|叫|蹭)|喂.*猫|撸.*猫|做.*饭|煮(?:了|的|面|饭|菜)|收拾.*(?:桌子|房间|屋子|家)|洗.*澡|刚.*睡醒|刚.*起床|请假.*在家|在家.*办公|远程|WFH/ },
  { loc: "out",    re: /(?:在|去)\s*(?:外面|外面吃|商场|超市|逛街|买东西|吃饭(?!了)|看电影|健身房|打球|跑步|遛|取快递|拿快递)/ },
];

const ACTIVITY_RULES = [
  { act: "working",   re: /(?:在|要|得)?(?:上班|工作|干活|写代码|搬砖|开会|加班|忙|改.*bug|项目|需求|文档|报告|PPT|做表|对接|联调|上线|部署|摸鱼)/ },
  { act: "commuting", re: /(?:在|去)\s*(?:路上|地铁|公交|通勤|打车|走路.*上班|骑车|赶路)/ },
  { act: "eating",    re: /(?:在|吃|点(?:了|的)?)\s*(?:饭|外卖|食堂|面|粉|米线|麻辣烫|火锅|烤|炸|煮(?:了|的|面|饭|菜)|早餐|午餐|晚饭|午饭|早午饭|下午茶|夜宵|零食)|在(?:吃|啃|喝)|吃.*(?:去|了|过|完|饱|撑)|点.*外卖|叫.*外卖/ },
  { act: "resting",   re: /(?:在|躺|瘫|歇|睡|眯|摸鱼|发呆|休息|放松|葛优躺)|(?:睡|躺|瘫)(?:了|着|下|会|一会儿|一下|觉|午觉)|刚.*睡醒|午休|小睡/ },
  { act: "gaming",    re: /(?:在|打|玩|开黑|排位|上分).*(?:游戏|LOL|原神|王者|吃鸡|CS|DOTA|switch|PS5|steam|单机|网游)|在.*(?:开黑|排位|上分|打本|刷图|肝)/ },
  { act: "watching",  re: /(?:在)?(?:刷|看|追|逛)(?:B站|抖音|视频|剧|番|直播|微博|小红书|淘宝|京东|拼多多|知乎|贴吧|豆瓣|虎扑|NGA)|在.*(?:刷手机|看.*手机|追剧|追番|看.*直播)/ },
  { act: "cleaning",  re: /(?:在|刚)?(?:收拾|打扫|整理|拖地|扫地|擦.*(?:桌子|键盘|屏幕|地|窗|灰)|洗.*(?:碗|衣服|袜子|澡|头|脸|手))|打扫.*(?:房间|卫生|屋子|家)|大扫除/ },
  { act: "withCat",   re: /(?:猫|咪咪).*(?:在|趴|睡|打翻|闹|叫|蹭|撸|摸|喂|抱|吸|逗|玩|抓住|跑|跳|爬|钻|躲)|(?:撸|摸|喂|抱|吸|逗).*猫/ },
];

// ── 时间驱动的默认状态 ──

function getTimeBasedState(now) {
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;

  // 周末默认在家
  if (isWeekend) {
    if (h >= 0 && h < 10) return { location: "home", activity: "resting" };
    if (h >= 22) return { location: "home", activity: "resting" };
    return { location: "home", activity: "resting" }; // 周末全天默认在家
  }

  // 工作日时间线
  const t = h * 60 + m;

  if (t < 6 * 60)       return { location: "home", activity: "resting" };      // 0:00-6:00 睡觉
  if (t < 7 * 60 + 30)  return { location: "home", activity: "resting" };      // 6:00-7:30 起床准备
  if (t < 8 * 60)       return { location: "home", activity: "eating" };        // 7:30-8:00 吃早餐
  if (t < 9 * 60)       return { location: "commuting", activity: "commuting" }; // 8:00-9:00 通勤
  if (t < 9 * 60 + 30)  return { location: "office", activity: "working" };     // 9:00-9:30 到公司
  if (t < 12 * 60)      return { location: "office", activity: "working" };     // 9:30-12:00 上午工作
  if (t < 14 * 60)      return { location: "office", activity: "eating" };      // 12:00-14:00 午休吃饭
  if (t < 18 * 60 + 30) return { location: "office", activity: "working" };     // 14:00-18:30 下午工作
  if (t < 19 * 60 + 30) return { location: "commuting", activity: "commuting" }; // 18:30-19:30 下班通勤
  if (t < 22 * 60)      return { location: "home", activity: "resting" };       // 19:30-22:00 在家休息
  return { location: "home", activity: "resting" };                             // 22:00后 准备睡觉
}

/** 检查两个状态是否属于同一大类（避免微小变动） */
function isSameCategory(a, b) {
  if (a.location !== b.location) return false;
  // 活动归大类
  const cat = (act) => {
    if (act === "working" || act === "eating" && a.location === "office") return "workday";
    if (act === "resting" || act === "gaming" || act === "watching" || act === "cleaning" || act === "withCat") return "homeLife";
    return act;
  };
  return cat(a.activity) === cat(b.activity);
}

/** 活动大类：用于判断显式记录与时间推断是否兼容 */
function getActivityCategory(act) {
  if (act === "working" || act === "commuting") return "work";
  if (act === "resting" || act === "gaming" || act === "watching" || act === "cleaning" || act === "withCat") return "home";
  return "any"; // eating 等通用活动
}

// ── 主类 ──

export class SelfStateTracker {
  constructor() {
    this._timeline = [];        // [{time, location, activity, detail, source}]
    this._load();
  }

  _load() {
    const data = readJSON(STATE_FILE);
    if (data && data.timeline) {
      // 只保留今天的时间线
      const today = new Date().toDateString();
      this._timeline = (data.timeline || []).filter(e => {
        return new Date(e.time).toDateString() === today;
      });
    }
  }

  _save() {
    writeJSON(STATE_FILE, { timeline: this._timeline });
  }

  /**
   * 检查匹配位置是否处于"过去时"语境（前面有过去时间状语）
   * 例："中午在家待着" → 过去时，不应更新位置
   */
  _isPastContext(text, match) {
    if (match.index === undefined) return false;
    const PAST_TIME_RE = /(?:中午|刚才|之前|昨天|早上|今天早上|今早|上午|昨晚|刚刚|昨晚|前天|下午的时候|今天下午|昨天下午)/;
    const before = text.substring(Math.max(0, match.index - 12), match.index);
    return PAST_TIME_RE.test(before);
  }

  /** 扫描 bot 回复，检测并记录状态 */
  updateFromReply(replyText) {
    if (!replyText || replyText.length < 2) return;

    let newLoc = null, newAct = null;

    for (const rule of LOCATION_RULES) {
      const m = replyText.match(rule.re);
      if (m && !this._isPastContext(replyText, m)) { newLoc = rule.loc; break; }
    }
    for (const rule of ACTIVITY_RULES) {
      const m = replyText.match(rule.re);
      if (m && !this._isPastContext(replyText, m)) { newAct = rule.act; break; }
    }

    if (!newLoc && !newAct) return;

    // 提取细节
    const detailMatch = replyText.match(/(?:在|去|到|刚|正|要)\s*.{0,15}(?:上班|工作|开会|加班|吃饭|睡觉|休息|打游戏|看剧|收拾|打扫|撸猫|喂猫|洗澡|做饭|出门|回家|到家|通勤|挤地铁|写代码|搬砖)/);
    const detail = detailMatch ? detailMatch[0] : replyText.substring(0, 40);

    const now = Date.now();
    const timeState = getTimeBasedState(new Date());
    const loc = newLoc || timeState.location;
    const act = newAct || timeState.activity;

    // 检查是否和上一条时间线重复
    const last = this._timeline[this._timeline.length - 1];
    if (last && isSameCategory(last, { location: loc, activity: act })) {
      // 更新最近一条的细节即可
      last.detail = detail;
      last.time = new Date(now).toISOString();
      this._save();
      return;
    }

    const entry = {
      time: new Date(now).toISOString(),
      location: loc,
      activity: act,
      detail,
      source: "reply", // 来自 bot 自己的话
    };

    this._timeline.push(entry);
    // 只保留最近 20 条（一天内足够）
    if (this._timeline.length > 20) this._timeline = this._timeline.slice(-20);

    this._save();
    console.log(`[self-state] 记录: ${LOC_NAME[loc] || loc} / ${ACT_NAME[act] || act} → "${detail}" (共${this._timeline.length}条)`);
  }

  /** 解析当前状态：时间推断为主，显式记录仅在1小时内且不矛盾时生效 */
  _resolveState(now) {
    const cutoff1h = now - 1 * 60 * 60 * 1000; // 1小时内
    const timeState = getTimeBasedState(now);

    // 找最近的显式记录
    let explicit = null;
    for (let i = this._timeline.length - 1; i >= 0; i--) {
      const e = this._timeline[i];
      if (new Date(e.time).getTime() > cutoff1h) {
        explicit = e;
        break;
      }
    }

    // 1小时内有显式记录，且位置一致，且活动大类兼容 → 采用
    if (explicit && explicit.location === timeState.location) {
      const expCat = getActivityCategory(explicit.activity);
      const timeCat = getActivityCategory(timeState.activity);
      if (expCat === "any" || timeCat === "any" || expCat === timeCat) {
        return {
          location: explicit.location,
          activity: explicit.activity,
          detail: explicit.detail,
          source: "explicit",
        };
      }
      // 活动大类矛盾（如时间推断 resting 但显式 working），只用时间推断
    }

    // 否则以时间推断为准（1小时内但位置矛盾也以时间为准）
    return { ...timeState, detail: null, source: "time" };
  }

  /** 生成系统提示注入文本 */
  getContext(now = new Date()) {
    const current = this._resolveState(now);
    const timeState = getTimeBasedState(now);
    const lines = [];

    // 0. 当前时间（让模型有准确的时间感知）
    const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    lines.push(`现在是周${weekdayNames[now.getDay()]} ${timeStr}。`);

    // 1. 当前状态（时间推断是权威）
    const locName = LOC_NAME[current.location] || current.location;
    const actName = ACT_NAME[current.activity] || current.activity;
    const sourceNote = current.source === "time" ? "（按时间推断）" : "";
    lines.push(`你当前在：${locName}，${actName}${sourceNote}。`);

    // 只有当显式状态和当前时间位置一致时，才补充细节
    if (current.detail && current.location === timeState.location) {
      lines.push(`你最近说过："${current.detail}"。言行和这句话保持一致。`);
    }

    // 2. 今天的时间线（过去的轨迹，不是当前状态）
    if (this._timeline.length > 0) {
      const timelineText = this._timeline
        .map(e => {
          const t = new Date(e.time);
          const timeStr2 = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
          return `${timeStr2} ${LOC_NAME[e.location] || e.location} ${ACT_NAME[e.activity] || e.activity}`;
        });

      const deduped = [];
      for (const item of timelineText) {
        if (deduped.length === 0 || !deduped[deduped.length - 1].includes(item.split(" ").slice(1).join(" "))) {
          deduped.push(item);
        }
      }

      if (deduped.length > 0) {
        lines.push(`\n你今天早些时候的时间线（这是过去发生的事，不代表你现在在哪）：\n${deduped.join("\n")}`);
      }
    }

    // 3. 核心约束
    lines.push(`\n重要：你的当前状态按时间和工作日作息确定。时间线里的事已经过去了，不要根据历史时间线描述现在的状态。`);
    if (current.source !== "time" && current.location !== timeState.location) {
      lines.push(`特别注意：你现在应该在${LOC_NAME[timeState.location] || timeState.location}，不要说你在别的地方。`);
    }
    if (timeState.location === "office") {
      lines.push(`你现在在公司。猫在家里。如果对方想看猫，你只能通过家里的监控摄像头查看。`);
    }

    return `\n\n【你当前的状态】\n${lines.join("\n")}`;
  }

  /** 极简版：一行状态，用于注入到对话历史之后 */
  getContextShort(now = new Date()) {
    const current = this._resolveState(now);
    const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const h = now.getHours();
    let period = "凌晨";
    if (h >= 6 && h < 9) period = "早上";
    else if (h >= 9 && h < 12) period = "上午";
    else if (h >= 12 && h < 14) period = "中午";
    else if (h >= 14 && h < 18) period = "下午";
    else if (h >= 18 && h < 22) period = "晚上";
    else period = "深夜";
    const timeStr = `周${weekdayNames[now.getDay()]} ${period}${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const locName = LOC_NAME[current.location] || current.location;
    const actName = ACT_NAME[current.activity] || current.activity;
    const note = (h >= 6 && h < 22) ? " 现在是白天，不要说晚安/快睡/早点休息之类的话。" : "";
    return `【现在】${timeStr}。${locName}，${actName}。${note}`;
  }
}
