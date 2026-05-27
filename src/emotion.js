/**
 * 情绪关键词检测 + 状态机
 * 当前情绪 = 上次情绪 × 0.7 + 当前检测情绪 × 0.3
 */

const EMOTION_KEYWORDS = {
  happy: [
    "哈哈", "笑死", "开心", "高兴", "快乐", "好耶", "nice", "太棒", "终于",
    "恭喜", "赞", "牛", "666", "可以啊", "不错", "爽", "耶", "嘿嘿",
    "哈哈哈哈", "嘻嘻", "拿奖", "过了", "上岸", "收到",
  ],
  sad: [
    "难过", "伤心", "哭", "想哭", "好累", "累了", "疲惫", "心累",
    "郁闷", "沮丧", "失望", "崩溃", "撑不住", "扛不住", "好烦",
    "压力", "焦虑", "慌", "怕", "睡不着", "失眠",
  ],
  angry: [
    "气死", "生气", "愤怒", "火大", "无语", "离谱", "傻逼", "有病",
    "靠", "操", "妈的", "烦死", "恶心", "讨厌", "受不了",
    "凭什么", "居然", "真是的",
  ],
  bored: [
    "无聊", "没意思", "不知道干嘛", "好闲", "没事做", "发呆",
    "躺平", "咸鱼", "摸鱼", "划水", "不想动",
  ],
};

// 情绪 → 回答风格映射
const EMOTION_STYLE = {
  happy: "对方看起来挺开心，你可以幽默、调侃、一起嗨",
  sad: "对方情绪低落，需要关心和安慰，语气温和",
  angry: "对方在生气，站他这边帮着说两句，别讲道理",
  bored: "对方无聊，轻松随意，抛个话题聊聊",
  neutral: "正常聊天，随意自然",
};

export class EmotionTracker {
  constructor() {
    // 每个好友独立的状态: friendId -> { emotion, score, msgCount }
    this.states = new Map();
  }

  _getState(friendId) {
    if (!this.states.has(friendId)) {
      this.states.set(friendId, {
        emotion: "neutral",
        msgCount: 0,
        emotionHistory: [],   // { emotion, time } 最近10条
        intensityHistory: [], // 情绪强度 0-5
      });
    }
    return this.states.get(friendId);
  }

  /**
   * 从消息文本检测情绪，返回主情绪 + 次情绪 + 强度
   */
  detect(text) {
    const scores = {};
    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
      scores[emotion] = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          scores[emotion] += 1;
        }
      }
    }

    let best = "neutral";
    let bestScore = 0;
    let secondary = null;
    let secondaryScore = 0;

    for (const [emotion, score] of Object.entries(scores)) {
      if (score > bestScore) {
        secondary = bestScore > 0 ? best : null;
        secondaryScore = bestScore;
        best = emotion;
        bestScore = score;
      } else if (score > secondaryScore) {
        secondary = emotion;
        secondaryScore = score;
      }
    }

    return {
      primary: bestScore > 0 ? best : "neutral",
      secondary: secondaryScore > 0 ? secondary : null,
      intensity: Math.min(bestScore, 5),
    };
  }

  /**
   * 更新情绪状态：当前 = 上次 × 0.7 + 检测 × 0.3
   * 返回情绪描述文本，可直接注入 prompt
   */
  update(friendId, text) {
    const state = this._getState(friendId);
    const detected = this.detect(text);

    if (detected.primary !== "neutral") {
      state.emotion = detected.primary;
      state.neutralStreak = 0;
    } else {
      state.neutralStreak = (state.neutralStreak || 0) + 1;
      if (state.neutralStreak >= 2) {
        state.emotion = "neutral";
      }
    }

    state.msgCount += 1;
    state.totalMsgCount = (state.totalMsgCount || 0) + 1;

    // 记录情绪历史（含强度和次情绪）
    state.emotionHistory.push({
      emotion: state.emotion,
      secondary: detected.secondary,
      intensity: detected.intensity,
      time: Date.now(),
    });
    if (state.emotionHistory.length > 10) state.emotionHistory.shift();

    return {
      emotion: state.emotion,
      secondary: detected.secondary,
      intensity: detected.intensity,
      style: EMOTION_STYLE[state.emotion] || EMOTION_STYLE.neutral,
      msgCount: state.msgCount,
      totalMsgCount: state.totalMsgCount,
    };
  }

  /**
   * 是否需要主动提问（每 3-5 条消息）
   */
  shouldAskProactive(friendId) {
    const state = this._getState(friendId);
    // 每 3-5 条随机决定是否主动问
    if (state.msgCount >= 3 && Math.random() < 0.35) {
      state.msgCount = 0; // 重置计数
      return true;
    }
    return false;
  }

  /**
   * 获取情绪上下文，供 prompt 使用
   */
  getContext(friendId) {
    const state = this._getState(friendId);
    return {
      emotion: state.emotion,
      style: EMOTION_STYLE[state.emotion] || EMOTION_STYLE.neutral,
      msgCount: state.msgCount,
    };
  }

  /**
   * 获取情绪轨迹上下文，用于 prompt 注入
   * 分析最近消息的情绪趋势、强度、混合情绪、关系阶段
   */
  getEmotionalContext(friendId) {
    const state = this._getState(friendId);
    const history = state.emotionHistory || [];
    if (history.length < 2) return "";

    const recent = history.slice(-5);
    const emotions = recent.map(h => h.emotion);
    const intensities = recent.map(h => h.intensity || 0);
    const avgIntensity = intensities.reduce((a, b) => a + b, 0) / intensities.length;

    const sadCount = emotions.filter(e => e === "sad").length;
    const happyCount = emotions.filter(e => e === "happy").length;
    const angryCount = emotions.filter(e => e === "angry").length;
    const boredCount = emotions.filter(e => e === "bored").length;

    const parts = [];

    // 1. 主导情绪 + 强度
    if (sadCount >= 3) {
      parts.push("对方最近情绪持续低落，不要急着转移话题，认真倾听和安慰");
    } else if (angryCount >= 3) {
      parts.push("对方最近一直很烦躁，别讲道理，多共情，站在他这边");
    } else if (happyCount >= 3) {
      parts.push("对方最近心情一直很好，可以多开玩笑、调侃");
    } else if (boredCount >= 3) {
      parts.push("对方最近一直很无聊，你可以主动抛个有趣的话题");
    }

    // 2. 情绪强度提示
    if (avgIntensity >= 3 && sadCount >= 2) {
      parts.push("对方情绪很强烈，需要认真对待，不要轻描淡写");
    } else if (avgIntensity >= 3 && angryCount >= 2) {
      parts.push("对方情绪很激动，先让他发泄，别急着给建议");
    }

    // 3. 混合情绪检测（最近2条）
    const latest = history[history.length - 1];
    if (latest?.secondary && latest.secondary !== "neutral") {
      const mixMap = {
        "happy+sad": "对方表面开心但可能藏着心事，注意话里的弦外之音",
        "angry+sad": "对方愤怒背后可能是受伤了，别只看到表面怒气",
        "sad+angry": "对方除了难过还有点生气，可能是对某件事不甘心",
        "bored+sad": "对方无聊中透着低落，可能不只是闲而是有点丧",
        "happy+bored": "对方心情还行但缺点新鲜感，可以聊点有意思的",
      };
      const mixKey = [latest.emotion, latest.secondary].sort().join("+");
      const mixHint = mixMap[mixKey];
      if (mixHint) parts.push(mixHint);
    }

    // 4. 情绪转折（前3条 vs 最近2条）
    if (history.length >= 5) {
      const older = history.slice(-5, -2);
      const newer = history.slice(-2);
      const olderEmos = older.map(h => h.emotion);
      const newerEmos = newer.map(h => h.emotion);

      if (olderEmos.some(e => e === "happy") && newerEmos.some(e => e === "sad")) {
        parts.push("注意：对方情绪从开心变低落了，可能遇到了什么事，适当关心一下");
      }
      if (olderEmos.some(e => e === "sad") && newerEmos.some(e => e === "happy")) {
        parts.push("对方情绪似乎在好转，可以配合他开心的节奏");
      }
      if (olderEmos.some(e => e === "neutral") && newerEmos.some(e => e === "angry")) {
        parts.push("对方突然生气了，可能是刚才聊的内容触发了什么，注意下");
      }
    }

    // 5. 关系阶段
    const total = state.totalMsgCount || 0;
    if (total <= 10) {
      parts.push("你们还不太熟，保持友好但别太越界，少打听隐私");
    } else if (total >= 100) {
      parts.push("你们已经很熟了，可以随意开玩笑、吐槽，不用太客气");
    } else if (total >= 50) {
      parts.push("你们比较熟了，可以适当调侃、分享日常，不用太拘谨");
    }

    return parts.join("。") + (parts.length > 0 ? "。" : "");
  }

  /**
   * 重置某好友的状态
   */
  reset(friendId) {
    this.states.delete(friendId);
  }
}
