// Bot name generator — a curated local list beats a naming API: instant,
// offline, and every name is on-brand (short, friendly, a little pet-like,
// which suits the Maus). Picks avoid names already in use; when the pool is
// exhausted it falls back to "Name 2", "Name 3", …
import { getLocale } from "../shared/i18n.ts";

const NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Ember", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Waffle", "Ziggy", "Noodle",
  "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
  "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli",
  "Ursa", "Yuki", "Zuko", "Momo", "Kiwi", "Plum", "Sprout", "Turnip",
];

// Chinese builds name new bots from a list of friendly two-character
// nicknames in the same spirit (snacks, fruit, weather, sky).
const ZH_NAMES = [
  "团子", "麻薯", "布丁", "可可", "糯米", "年糕", "汤圆", "饺子",
  "包子", "豆豆", "芒果", "橙子", "柚子", "桃子", "椰子", "栗子",
  "果冻", "奶糖", "卷卷", "星星", "月牙", "小云", "小雨", "小风",
  "闪电", "火花", "彗星", "极光", "晴天", "青柠", "薄荷", "松果",
  "花卷", "煎饼", "锅巴", "虾饺", "烧麦", "酥饼", "米粒", "豆浆",
  "抹茶", "樱桃", "蓝莓", "草莓", "西柚", "葡萄", "雪梨", "蜜瓜",
  "小鹿", "小熊", "喵喵", "啾啾", "咕噜", "阿福", "旺财", "小满",
  "小禾", "立夏", "秋分", "白露", "北斗", "银河", "星河", "麦芽",
];

/** The nickname pool for the app's language. */
export function botNamePool(): readonly string[] {
  return getLocale() === "zh-CN" ? ZH_NAMES : NAMES;
}

export function pickBotName(taken: Iterable<string>): string {
  const pool = botNamePool();
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = pool.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  // pool exhausted — number a random base name
  const base = pool[Math.floor(Math.random() * pool.length)];
  for (let i = 2; ; i++) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}
