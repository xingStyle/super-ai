#!/usr/bin/env node
/**
 * 用「位置 + 名字 + 极其明显的外貌/服装特征 + 动作」的公式重写方位声明。
 *
 * 错误写法（我之前用的）：
 *   「苏晚在画面右侧，陆沉在画面左侧，绝不能对调。」
 *   → 模型不知道苏晚是哪一个，只能猜，猜错就左右对调。
 *
 * 正确写法：
 *   「画面右侧是穿浅灰蓝交领练功服、黑色齐下巴短发的年轻女子苏晚，她正……
 *     画面左侧是穿白色短袖T恤、黑色长裤、黑色高帮鞋的短发年轻男子陆沉，他正……
 *     请注意：穿白短袖的陆沉在左，穿浅蓝练功服的苏晚在右。」
 *   → 服装是最强视觉锚点，把特征与位置绑死，模型无从猜错。
 */
"use strict";

const fs = require("fs");
const p = "projects/打戏/00-spec/shots.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));

// 极简身份锚点：只保留"一眼能分辨"的特征，服装为主
const ID = {
  suwan: "穿**浅灰蓝交领练功服**、**黑色齐下巴短发**的年轻女子**苏晚**",
  luchen: "穿**白色短袖T恤**、**黑色长裤**、**黑色高帮鞋**的短发年轻男子**陆沉**",
};

// 每镜：谁在哪侧 + 各自此刻在做什么（动作用短句，不重复帧里的长描述）
const stage = {
  S01: { suwan: "R", luchen: "L", su: "站在旧供桌前方、面朝门口", lu: "从左侧拱门跨进门、身体前倾" },
  S02: { suwan: "R", luchen: "L", su: "在画面中偏右、正面朝向陆沉", lu: "在前景左缘、背对镜头只露肩背，面朝苏晚" },
  S03: { suwan: "R", luchen: "L", su: "在前景右缘、背对镜头只露肩背", lu: "在画面中偏左、靠拱门木框，正面朝向苏晚" },
  S04: { suwan: "R", luchen: "L", su: "在画面右侧、正压低重心", lu: "在画面左侧、正被扫倒" },
  S05: { suwan: "R", luchen: "L", su: "在前景右缘、背对镜头只露肩背", lu: "在画面中偏左、正面朝向苏晚" },
  S06: { suwan: "R", luchen: "L", su: "在画面右侧、靠供桌那一侧站着", lu: "在画面中部偏右、伏向画面右缘的供桌" },
  S07: { suwan: "R", luchen: "L", su: "在画面右侧、正踢出或刚踢完", lu: "在画面左侧、正被踢飞或已撞柱" },
  S08: { suwan: "R", luchen: "L", su: "在画面中景偏右、背对供桌站着", lu: "在画面左下方暗处、坐在地上" },
};

let n = 0;
for (const s of j.shots) {
  const st = stage[s.id];
  if (!st) continue;

  const suPos = st.suwan === "R" ? "画面右侧" : "画面左侧";
  const luPos = st.luchen === "R" ? "画面右侧" : "画面左侧";

  // 通用方位块（每帧都用同一份，只改"正在做什么"）
  const buildBlock = (suAct, luAct) =>
    `【人物与方位——必须严格执行】` +
    `${suPos}是${ID.suwan}，她${suAct}；` +
    `${luPos}是${ID.luchen}，他${luAct}。` +
    `**请注意：穿白色短袖T恤、黑色长裤的是陆沉，他在${luPos === "画面右侧" ? "右" : "左"}；` +
    `穿浅灰蓝交领练功服的是苏晚，她在${suPos === "画面右侧" ? "右" : "左"}。两人的左右位置绝不能对调。**`;

  s.stage_layout = {
    suwan_screen_side: st.suwan,
    luchen_screen_side: st.luchen,
    suwan_identity: "浅灰蓝交领练功服 + 黑色齐下巴短发",
    luchen_identity: "白色短袖T恤 + 黑色长裤 + 黑色高帮鞋 + 短发",
    note: `${suPos}是${ID.suwan}；${luPos}是${ID.luchen}。`,
  };

  for (const b of s.beats || []) {
    let fp = b.frame_prompt || "";
    // 移除旧的方位块
    fp = fp.replace(/【方位】[^【]*/g, "");
    // 用这一帧自己的动作描述作为"正在做什么"（从 name 提炼）
    const act = b.name || "";
    const block = buildBlock(`正处在「${act}」这个动作中`, `正处在「${act}」这个动作中`);
    // 更准确：分别给两人的动作
    const suActMap = {
      S01: "面朝门口站着不动", S02: "正出手", S03: "刚被打退", S04: "正压低重心扫出",
      S05: "正横步拦截", S06: "正盯着他的身体", S07: "正踢出或刚踢完", S08: "背对供桌站着",
    };
    const luActMap = {
      S01: "正跨进门往里看", S02: "正侧身让开", S03: "正靠门框或正送肘", S04: "正被扫倒",
      S05: "正撑地起身冲出", S06: "正扑向供桌", S07: "正被踢飞或已撞柱", S08: "坐在地上喘",
    };
    const realBlock = buildBlock(suActMap[s.id] || "正在动作中", luActMap[s.id] || "正在动作中");

    const idx = fp.indexOf("机位、构图、背景、光位");
    if (idx >= 0) fp = fp.slice(0, idx) + realBlock + " " + fp.slice(idx);
    else fp = fp + " " + realBlock;

    // 视线也补上身份
    fp = fp.replace(/【视线】[^【]*/g, "");
    const eye = s.eyeline || "";
    const eyeBlock = `【视线】**${eye}** 两人必须互相看着对方的方向，不许看镜头、不许看天花板、不许看空处。`;
    const idx2 = fp.indexOf("机位、构图、背景、光位");
    fp = idx2 >= 0 ? fp.slice(0, idx2) + eyeBlock + " " + fp.slice(idx2) : fp + " " + eyeBlock;

    b.frame_prompt = fp;
    n++;
  }
}

fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log(`已重写 ${n} 帧的人物身份锚点`);
console.log("");
const s = j.shots.find((x) => x.id === "S07");
const fp = s.beats[1].frame_prompt;
const i = fp.indexOf("【人物与方位");
console.log("=== S07_b2 改后 ===\n");
console.log(fp.slice(i));
