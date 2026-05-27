import { readJSON, writeJSON } from "./store.js";

const REMINDER_FILE = "reminders.json";

export class ReminderManager {
  constructor() {
    this.reminders = readJSON(REMINDER_FILE) || [];
    if (this.reminders.length > 0) {
      console.log(`[reminder] 已恢复 ${this.reminders.length} 条提醒`);
    }
  }

  /** 从消息中解析提醒请求，返回 { target: Date, message: string } 或 null */
  parse(text) {
    const now = new Date();
    let target = null;
    let message = "";

    // ① "10分钟后叫我/提醒我..."
    let m = text.match(/(\d{1,3})\s*分钟后?\s*(?:叫我|提醒我|喊我|叫我起床|叫我起来)\s*(.+)/);
    if (m) {
      target = new Date(now.getTime() + parseInt(m[1]) * 60000);
      message = m[2] || "到点了";
      return { target, message };
    }

    // ② "明天/后天/今晚/明早 X点..."
    m = text.match(/(明天|后天|今晚|明早|明晚|今天)\s*(早上|上午|中午|下午|晚上|凌晨)?\s*(\d{1,2})\s*点(?:半|钟)?\s*(?:叫我|提醒我|喊我|叫我起床|叫我起来)\s*(.*)/);
    if (m) {
      const dayWord = m[1];
      const period = m[2] || "";
      const hour = this._adjustHour(parseInt(m[3]), period);
      message = m[4] || "到点了";

      let dayOffset = 0;
      if (dayWord === "明天" || dayWord === "明早" || dayWord === "明晚") dayOffset = 1;
      else if (dayWord === "后天") dayOffset = 2;

      target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0);
      return { target, message };
    }

    // ③ 只有时间 "早上7点叫我..."（今天，过了就明天）
    m = text.match(/(早上|上午|中午|下午|晚上|凌晨)\s*(\d{1,2})\s*点(?:半|钟)?\s*(?:叫我|提醒我|喊我|叫我起床|叫我起来)\s*(.*)/);
    if (m) {
      const period = m[1];
      const hour = this._adjustHour(parseInt(m[2]), period);
      message = m[3] || "到点了";

      target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      return { target, message };
    }

    // ④ 纯数字时间 "7点叫我..."
    m = text.match(/(\d{1,2})\s*点(?:半|钟)?\s*(?:叫我|提醒我|喊我|叫我起床|叫我起来)\s*(.+)/);
    if (m) {
      let hour = parseInt(m[1]);
      message = m[2] || "到点了";

      // 默认上午，除非看起来像下午
      target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      return { target, message };
    }

    return null;
  }

  /** "下午3点" → 15, "晚上8点" → 20, etc. */
  _adjustHour(hour, period) {
    if (period === "下午" || period === "晚上") {
      return hour === 12 ? 12 : hour + 12;
    }
    if (period === "中午" && hour < 12) return hour + 12;
    if (period === "凌晨" && hour === 12) return 0;
    return hour;
  }

  /** 添加提醒 */
  add(friendId, friendName, target, message) {
    const item = {
      friendId,
      friendName,
      target: target.toISOString(),
      message,
    };
    this.reminders.push(item);
    writeJSON(REMINDER_FILE, this.reminders);
    console.log(`[reminder] 添加: ${friendName} → ${target.toLocaleString()} "${message}"`);
  }

  /** 获取到期提醒并删除 */
  getDue() {
    const now = new Date();
    const due = [];
    this.reminders = this.reminders.filter(r => {
      if (new Date(r.target) <= now) {
        due.push(r);
        return false;
      }
      return true;
    });
    if (due.length > 0) {
      writeJSON(REMINDER_FILE, this.reminders);
    }
    return due;
  }
}
