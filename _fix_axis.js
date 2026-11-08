#!/usr/bin/env node
/**
 * 检查「视线关联」与「左右方位连续性」。
 *
 * 用户指出的两个真实错误（实测）：
 *   ① 同一镜的不同帧里，人物左右位置翻转了 —— 因果断裂，观众看不懂谁打谁
 *      实例：S07_b2 她在左他在右被踢飞；S07_b3 他在左撞柱她在右
 *   ② 两人视线各看各的 —— 打戏里双方本该互相盯着，结果一个看天花板一个看地面
 *      实例：S07_b2 她看正前方、他看天花板
 */
"use strict";

const fs = require("fs");
const p = "projects/打戏/00-spec/shots.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));

// 每镜的「左右方位声明」：谁在画面哪一侧，全程不许变
const layout = {
  S01: { suwan: "R", luchen: "L", note: "陆沉从左门进，苏晚守在右侧供桌前。全镜不变。" },
  S02: { suwan: "R", luchen: "L", note: "过肩拍苏晚。苏晚在画面中偏右，陆沉在前景左缘只露肩背。" },
  S03: { suwan: "R", luchen: "L", note: "过肩拍陆沉。陆沉在画面中偏左靠门框，苏晚在前景右缘只露肩背。方位与 S02 一致，只是机位翻到另一侧。" },
  S04: { suwan: "R", luchen: "L", note: "低角度双人。苏晚在右、陆沉在左。全镜不变。" },
  S05: { suwan: "R", luchen: "L", note: "过肩拍陆沉。陆沉在画面中偏左，苏晚在前景右缘。" },
  S06: { suwan: "R", luchen: "L", note: "供桌在右缘。陆沉在画面中部偏右伏向供桌，苏晚在他靠供桌那一侧（右）。" },
  S07: { suwan: "R", luchen: "L", note: "苏晚在右，陆沉被踢向画面左侧（远离供桌）撞柱。立柱在中偏左。全镜不变。" },
  S08: { suwan: "R", luchen: "L", note: "供桌与匣子在右缘前景，苏晚在中景偏右背对，陆沉在左下方暗处。" },
};

// 每镜的「视线声明」：双方眼睛在看哪里
const eyeline = {
  S01: "陆沉的视线依次是：地面 → 木匣 → 苏晚的脸。苏晚全程盯着陆沉。最后一帧两人对视。",
  S02: "苏晚盯着陆沉的上半身（她出手的方向）。陆沉盯着苏晚的手臂。两人视线互相落在对方身上，绝不看镜头、不看天花板、不看地面。",
  S03: "陆沉盯着苏晚的肩膀（他肘击的目标）。苏晚在被撞前盯着陆沉，被撞后头随冲击甩向一侧。两人视线互相落在对方身上。",
  S04: "苏晚低头盯着陆沉的腿部（她扫击的目标）。陆沉在被扫前盯着苏晚，倒下后抬头看她。",
  S05: "陆沉盯着苏晚身后的供桌方向（他要冲过去的目标），但余光在她身上。苏晚盯着陆沉的肩膀。",
  S06: "陆沉的视线：假退时瞥向木匣，折返后盯着木匣，伸手时盯着自己的手与匣子。苏晚全程盯着陆沉的身体，绝不看地面。",
  S07: "苏晚盯着陆沉的腰肋（她踢的目标）。陆沉在被踢前盯着苏晚，被踢后头随冲击甩开、撞柱后视线散乱。任何一帧都不许有人盯着天花板。",
  S08: "苏晚背对供桌、视线落在画面左下方地上那个人影。那个人影抬头看她。",
};

let n = 0;
for (const s of j.shots) {
  const L = layout[s.id];
  const E = eyeline[s.id];
  if (!L) continue;

  s.stage_layout = {
    suwan_screen_side: L.suwan,
    luchen_screen_side: L.luchen,
    note: L.note,
  };
  s.eyeline = E;

  for (const b of s.beats || []) {
    let fp = b.frame_prompt || "";
    if (/【方位】/.test(fp)) continue;

    const add =
      ` 【方位】**苏晚在画面${L.suwan === "R" ? "右侧" : "左侧"}，陆沉在画面${L.luchen === "R" ? "右侧" : "左侧"}，这一镜所有帧的左右位置完全一致，不许对调。**` +
      ` 【视线】**${E}**`;

    const idx = fp.indexOf("机位、构图、背景、光位");
    if (idx >= 0) {
      fp = fp.slice(0, idx) + add + " " + fp.slice(idx);
    } else {
      fp = fp + add;
    }
    b.frame_prompt = fp;
    n++;
  }
}

fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log(`已为 ${n} 帧补充方位与视线声明`);
console.log("");
for (const s of j.shots) {
  console.log(
    s.id,
    `苏晚在${s.stage_layout.suwan_screen_side === "R" ? "右" : "左"}`,
    `陆沉在${s.stage_layout.luchen_screen_side === "R" ? "右" : "左"}`
  );
}
