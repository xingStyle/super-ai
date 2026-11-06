#!/usr/bin/env node
/**
 * 时长审计：按每镜自己标注的语速（timing.cps）复算，不再用全局固定值。
 * 逐镜检查「标注时长」是否与「台词+停顿+余量」相符，并检查语速是否与情境标签自洽。
 * 用法: node tools/storyboard/timing_audit.js tools/storyboard/shots-song.json
 */
"use strict";

const fs = require("fs");
const path = require("path");

const specPath = process.argv[2] || path.resolve(__dirname, "shots-song.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

function dialogueOf(shot) {
  const out = [];
  const text = (shot.h3 && shot.h3.integrated_multimodal_description) || "";
  const re = /<d>\[Chinese\]\s*([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

function charCount(s) {
  return s.replace(/[，。…、！？：；\s—－-]/g, "").length;
}

// 语速区间：只用来提示「这个语速与常见情境是否偏离」，不做硬性判定
const BANDS = [
  { max: 3.0, label: "极慢（临终/力竭/刻意压低）" },
  { max: 3.5, label: "慢（沉重陈述）" },
  { max: 4.5, label: "常规对话" },
  { max: 5.5, label: "快（急报/催促）" },
  { max: 99, label: "极快（失控/抢字）" },
];

console.log("镜头  标注  复算  语速      台词字数  情境");
console.log("-".repeat(82));

let warn = 0;
for (const s of spec.shots) {
  const t = s.timing || {};
  const lines = dialogueOf(s);
  const chars = lines.reduce((a, x) => a + charCount(x), 0);

  let calc, note;
  if (!chars) {
    calc = s.duration;
    note = "无台词，按动作/氛围标注";
  } else {
    if (!t.cps) {
      console.log(`${s.id}  ${String(s.duration).padStart(3)}s   ---   【缺语速标注】台词 ${chars} 字`);
      warn++;
      continue;
    }
    const speech = chars / t.cps;
    calc = speech + (t.pause_sec || 0) + (t.margin_sec || 0);
    const band = BANDS.find((b) => t.cps <= b.max);
    note = band.label;
  }

  const diff = Math.abs(s.duration - calc);
  const flag = chars && diff > 1.2 ? "  ← 与复算差 >1.2 秒" : "";
  if (flag) warn++;

  console.log(
    `${s.id}  ${String(s.duration).padStart(3)}s  ${calc.toFixed(1).padStart(4)}  ` +
      `${(t.cps ? t.cps + "字/秒" : "—").padEnd(9)}  ${String(chars).padStart(6)}     ${note}${flag}`
  );
}

console.log("-".repeat(82));
console.log(
  warn
    ? `共 ${warn} 处需要复核（时长与台词不符，或缺少语速标注）`
    : "全部自洽：标注时长与台词量、停顿、余量相符"
);
