// 角色：進入對局前選一個，全隊得到一個小加成。要調平衡就改這裡的數字。
export const CHARS = {
  digger: { name: '老礦工 阿土', perk: '挖掘速度 +15%', mod: { dig: 0.85 } },
  scout: { name: '探險家 小光', perk: '礦工視野 +1 格', mod: { vision: 1 } },
  merchant: { name: '商人 金算盤', perk: '商店所有東西打 85 折', mod: { price: 0.85 } },
  guard: { name: '守衛 鐵柱', perk: '礦工血量 +1', mod: { hp: 1 } },
};

export const CHAR_IDS = Object.keys(CHARS);

const BASE = { dig: 1, vision: 0, price: 1, hp: 0 };

// 沒選角色（或角色代號不存在）就是完全沒有加成。
export function charMod(id) {
  return { ...BASE, ...(typeof id === 'string' && Object.hasOwn(CHARS, id) ? CHARS[id].mod : null) };
}
