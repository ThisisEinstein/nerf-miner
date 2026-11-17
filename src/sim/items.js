// 商店道具。instant：買了立刻生效；buff：礦工回家拿了就永久生效到被擊殺；其餘要拿在手上再使用。
export const ITEMS = {
  bomb: { name: '炸彈', icon: '💣', price: 150, cat: '進攻', desc: '送進敵方的家就獲勝。同時只能有一個；攜帶的礦工走得慢、也不能打架。' },
  intel1: { name: '概略情報', icon: '🗺️', price: 50, cat: '視野', instant: true, desc: '在地圖上標出敵方的家所在的大概範圍。買了立刻生效。' },
  intel2: { name: '精確情報', icon: '🎯', price: 200, cat: '視野', instant: true, desc: '直接標出敵方的家的位置。買了立刻生效。' },
  snuff: { name: '拆火把', icon: '🧯', price: 40, cat: '視野', desc: '拆掉 4 格內所有敵方火把，削減對方的視野。' },
  scope: { name: '望遠鏡', icon: '🔭', price: 40, cat: '增幅', buff: 'vision', desc: '拿到的礦工視野 +2，直到被擊殺。' },
  boots: { name: '加速靴', icon: '🥾', price: 40, cat: '增幅', buff: 'speed', desc: '拿到的礦工移動加快 25%，直到被擊殺。' },
  pick: { name: '鋼鎬', icon: '⛏️', price: 50, cat: '增幅', buff: 'dig', desc: '拿到的礦工挖掘加快 40%，直到被擊殺。' },
  hard: { name: '硬土', icon: '🧱', price: 30, cat: '干擾', desc: '把周圍 5×5 的土變成硬土，挖掘時間變 3 倍。' },
  mud: { name: '泥土', icon: '🟤', price: 30, cat: '干擾', desc: '把周圍 5×5 的通道變成泥地，敵方礦工走過去慢 3 倍。' },
  laser: { name: '激光塔', icon: '🔴', price: 80, cat: '防守', desc: '放在腳下。把 3 格內的敵方礦工打回家，每 6 秒一發。開火前敵方看不到。' },
  spike: { name: '尖刺', icon: '📌', price: 30, cat: '防守', desc: '放在腳下的陷阱，敵方看不到。踩到的敵方礦工被擊殺，只能用一次。' },
  spell: { name: '冰凍法術', icon: '❄️', price: 50, cat: '防守', desc: '凍住 4 格內的敵方礦工 5 秒。出手會暴露位置。' },
  fake: { name: '假的家', icon: '🏚️', price: 140, cat: '特殊', desc: '在腳下蓋一個假的家，騙掉敵方的炸彈。假的家沒有視野。' },
  portal: { name: '傳送門', icon: '🌀', price: 120, cat: '特殊', desc: '在腳下開一個通往自己家的傳送門，只有己方礦工能用。' },
  miner: { name: '買礦工', icon: '👷', price: 100, cat: '特殊', instant: true, desc: '家裡多一名礦工（最多 5 名）。買了立刻生效。' },
  tnt: { name: 'TNT', icon: '🧨', price: 60, cat: '特殊', desc: '炸開前方 3×4 格的土（沒有錢）、擊殺範圍內的敵方礦工並拆掉敵方設施，炸完插火把。' },
};

export const CATEGORIES = ['進攻', '視野', '增幅', '干擾', '防守', '特殊'];

// 實際售價：角色加成可能打折，一律取到 5 的倍數。
export function priceOf(id, mul = 1) {
  return Math.max(5, Math.round((ITEMS[id].price * mul) / 5) * 5);
}
