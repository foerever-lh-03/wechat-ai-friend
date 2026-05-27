import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

export function readJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
  } catch (e) {
    console.warn(`[store] read error: ${filename}`, e.message);
  }
  return null;
}

export function writeJSON(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`[store] write error: ${filename}`, e.message);
  }
}

export function appendJSONL(filename, entry) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    fs.appendFileSync(filepath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (e) {
    console.error(`[store] append error: ${filename}`, e.message);
  }
}

export function readJSONL(filename, limit = 50) {
  const filepath = path.join(DATA_DIR, filename);
  const lines = [];
  try {
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8");
      const all = content.trim().split("\n").filter(Boolean);
      for (const line of all.slice(-limit)) {
        try { lines.push(JSON.parse(line)); } catch {}
      }
    }
  } catch (e) {
    console.warn(`[store] read JSONL error: ${filename}`, e.message);
  }
  return lines;
}

/** 读取 JSONL 最旧的 N 条并返回，同时从文件中删除它们 */
export function shiftJSONL(filename, keepLast) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filepath)) return [];
    const content = fs.readFileSync(filepath, "utf-8");
    const all = content.trim().split("\n").filter(Boolean);
    if (all.length <= keepLast) return [];
    const toShift = all.slice(0, all.length - keepLast);
    const kept = all.slice(-keepLast);
    fs.writeFileSync(filepath, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    return toShift.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.warn(`[store] shiftJSONL error: ${filename}`, e.message);
    return [];
  }
}
