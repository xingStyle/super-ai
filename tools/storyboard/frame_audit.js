#!/usr/bin/env node
/**
 * 生成后「我自己看」的必查清单 + 常见失效模式自动筛查。
 *
 * 用户的质问：「我都不知道你是怎么判断这张图是对的」
 * 答案是：之前没有判断，审片说通过就当通过了。
 *
 * 审片（vision 模型）只能对照 checks 逐条判，判不了「这张图作为打戏像不像」。
 * 所以必须有这一层：把已知的失效模式写成可检索的特征，逐帧扫一遍。
 *
 *   node frame_audit.js --project projects/打戏
 */
"use strict";

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const get = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};

const project = get("--project") || "projects/打戏";
const specPath = path.join(project, "00-spec", "shots.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

/**
 * 已知失效模式。每条都是实测踩过的。
 */
const PATTERNS = [
  {
    id: "STATIC_ACTION",
    desc: "帧里有动作词，但没有任何「形变/位移」描述——会被画成站着",
    // 动作词
    act: /踢|拳|肘|掌|撞|扫|扑|冲|退|让|挡|截/,
    // 必须至少有一个
    motion: /离地|悬空|凹陷|内凹|压进|甩开|甩出|滑出|滑开|倾斜|前倾|后仰|反弓|折叠|塌|偏位|放射|绷紧|掀起|扬起|炸开|四散|拖后|抬起|超过|越过|低于|高于/,
  },
  {
    id: "STANCE_ADJECTIVE",
    desc: "只写了抽象的「重心/微屈」，没有可验证的几何——模型会画成标准架势",
    vague: /重心压|重心在|微微屈|微屈|稍屈|略屈|略微前倾|略前倾/,
    // 需要有具体数值或明确形体
    geo: /度|一半|三分之二|四十五|四十五度|三十度|几乎竖直|完全展开|越过|超过|低于|高于|一道.?(缝|痕|褶)|能看见|看得见间|可见空隙/,
  },
  {
    id: "DUAL_STANDING",
    desc: "双人帧但没有写明「两人都在动」，另一个必然被画成站着",
    // 明确的双人同框标志（不能只凭「画面左侧」这类单方位描述判双人）
    hasTwo: /两人同框|双人同框|画面左侧是|画面右侧是|两人之间|两人都/,
    // 单人帧的排除信号
    soloSignal: /单人镜|只有苏晚|只有陆沉|画面里没有人|出画|不出现/,
    bothMoving: /两人都在|都在动|两人都|两人都在运动中/,
  },
  {
    id: "CONTACT_FUSION",
    desc: "写了直接接触但没有「留一道缝/不贴死」，必然穿模",
    contact: /顶在|压进|砸在|撞在|正中|顶住/,
    gap: /细缝|缝隙|留着一道|还没贴死|不贴死|没有完全贴|空隙/,
  },
  {
    id: "NO_FACE_CLOSEUP",
    desc: "要求特写但没说「头肩在画外」，构图会失控变成全身",
    wantsCloseup: /特写/,
    cropDeclared: /头.{0,4}(不在|出画|之外|切)|肩.{0,4}(不在|出画|之外|切)|不出现.{0,6}脸|看不到.{0,6}脸|占满|填满|横贯/,
  },
  {
    id: "MUSCULAR",
    desc: "缺清瘦体型约束",
    need: /纤细|清瘦/,
  },
  {
    id: "SKIN_MATTE",
    desc: "缺哑光/油光约束",
    need: /哑光/,
    need2: /油光/,
  },
];

function auditText(text) {
  const hits = [];
  for (const p of PATTERNS) {
    if (p.id === "STATIC_ACTION") {
      if (p.act.test(text) && !p.motion.test(text)) hits.push(p);
    } else if (p.id === "STANCE_ADJECTIVE") {
      if (p.vague.test(text) && !p.geo.test(text)) hits.push(p);
    } else if (p.id === "DUAL_STANDING") {
      const isSolo = p.soloSignal && p.soloSignal.test(text);
      if (!isSolo && p.hasTwo.test(text) && !p.bothMoving.test(text)) hits.push(p);
    } else if (p.id === "CONTACT_FUSION") {
      if (p.contact.test(text) && !p.gap.test(text)) hits.push(p);
    } else if (p.id === "NO_FACE_CLOSEUP") {
      // 空镜（画面里没有人）不需要「头肩在画外」约束
      const noPerson = /画面里没有人|无人物|空镜/.test(text);
      if (!noPerson && p.wantsCloseup.test(text) && !p.cropDeclared.test(text)) hits.push(p);
    } else if (p.id === "MUSCULAR") {
      if (!p.need.test(text)) hits.push(p);
    } else if (p.id === "SKIN_MATTE") {
      if (!p.need.test(text) || !p.need2.test(text)) hits.push(p);
    }
  }
  return hits;
}

let total = 0;
let bad = 0;
const report = [];

for (const s of spec.shots) {
  for (let i = 0; i < (s.beats || []).length; i++) {
    const b = s.beats[i];
    total++;
    const hits = auditText(b.frame_prompt || "");
    if (hits.length) {
      bad++;
      report.push({ id: s.id, beat: i + 1, name: b.name, hits });
    }
  }
}

console.log(`\n检查 ${total} 帧，${bad} 帧命中已知失效模式\n`);
for (const r of report) {
  console.log(`${r.id}_b${r.beat}  ${r.name}`);
  for (const h of r.hits) console.log(`   ${h.id}: ${h.desc}`);
}
if (!bad) console.log("未命中任何已知失效模式。");

// 帧数与镜头类型分布
console.log("\n镜头类型分布（每镜应有 2 种以上）：");
for (const s of spec.shots) {
  const cams = (s.beats || []).map((b) => b.camera || "未标");
  console.log(`  ${s.id}  ${cams.length} 帧  ${cams.join(" / ")}`);
}
