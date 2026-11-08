#!/usr/bin/env node
/**
 * 首尾帧配对检查：判断两张静帧是否适合作为视频的首帧/尾帧。
 *
 * 首尾帧能否衔接，取决于两帧之间的「差异是否落在模型能插值的范围内」。
 * 差异过大 → 模型找不到路径，只会做形变（flesh morph）或滑移。
 *
 * 用法:
 *   node pair_check.js <首帧> <尾帧>
 *   node pair_check.js --batch pairs.json
 */
"use strict";

const sharp = require("sharp");
const fs = require("fs");

const W = 512, H = 910; // 统一采样尺寸（9:16）

async function loadGray(p) {
  const { data, info } = await sharp(p)
    .resize({ width: W, height: H, fit: "cover" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { g: data, w: info.width, h: info.height };
}

async function loadRGB(p) {
  const { data, info } = await sharp(p)
    .resize({ width: W, height: H, fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgb: data, ch: info.channels };
}

function stats(arr) {
  let s = 0, s2 = 0;
  for (let i = 0; i < arr.length; i++) { s += arr[i]; s2 += arr[i] * arr[i]; }
  const m = s / arr.length;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / arr.length - m * m)) };
}

/** 只在指定区域统计差异，用于区分「背景动了」和「主体动了」 */
function regionDiff(a, b, x0, y0, x1, y1, thresh = 28) {
  let changed = 0, total = 0, sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > thresh) changed++;
      total++;
    }
  }
  return { changedRatio: changed / total, meanDiff: sum / total };
}

async function check(p1, p2, opts = {}) {
  const A = await loadGray(p1);
  const B = await loadGray(p2);
  const rgbA = await loadRGB(p1);
  const rgbB = await loadRGB(p2);
  const { g: a } = A, { g: b } = B;

  // 1) 全画面差异
  const all = regionDiff(a, b, 0, 0, W, H);

  // 2) 边框差异（背景/机位是否变了）
  const top = regionDiff(a, b, 0, 0, W, Math.round(H * 0.18));
  const bottom = regionDiff(a, b, 0, Math.round(H * 0.82), W, H);
  const left = regionDiff(a, b, 0, 0, Math.round(W * 0.12), H);
  const right = regionDiff(a, b, Math.round(W * 0.88), 0, W, H);
  const borderChange = Math.max(top.changedRatio, bottom.changedRatio, left.changedRatio, right.changedRatio);

  // 3) 中心区域变化（主体运动）
  const center = regionDiff(a, b, Math.round(W * 0.2), Math.round(H * 0.2), Math.round(W * 0.8), Math.round(H * 0.8));

  // 4) 变化区域的包围盒与质心（主体位移量）
  //    用块级密度过滤散点噪声：单像素差 >28 多半是胶片颗粒重绘或火焰微动，
  //    只有整块（8×8）里超过 35% 像素都在变，才算「真的变了」。
  const BLK = 8, DENSE = 0.35, PIX = 28;
  let minX = W, minY = H, maxX = 0, maxY = 0, denseBlocks = 0, totalBlocks = 0, bcx = 0, bcy = 0;
  for (let by = 0; by + BLK <= H; by += BLK) {
    for (let bx = 0; bx + BLK <= W; bx += BLK) {
      totalBlocks++;
      let hit = 0;
      for (let y = by; y < by + BLK; y++) {
        for (let x = bx; x < bx + BLK; x++) {
          if (Math.abs(a[y * W + x] - b[y * W + x]) > PIX) hit++;
        }
      }
      if (hit / (BLK * BLK) < DENSE) continue;
      denseBlocks++;
      const mx = bx + BLK / 2, my = by + BLK / 2;
      bcx += mx; bcy += my;
      if (bx < minX) minX = bx; if (bx > maxX) maxX = bx + BLK;
      if (by < minY) minY = by; if (by > maxY) maxY = by + BLK;
    }
  }
  const bbox = denseBlocks
    ? { w: (maxX - minX) / W, h: (maxY - minY) / H, cx: bcx / denseBlocks / W, cy: bcy / denseBlocks / H }
    : null;
  // 「实质性变化」= 密度达标的块占比。这才是动作发生的真实比例。
  const motionRatio = denseBlocks / totalBlocks;

  // 5) 全局亮度与色温
  const sa = stats(a), sb = stats(b);
  const lumDelta = Math.abs(sa.mean - sb.mean);
  const lumStdDelta = Math.abs(sa.std - sb.std);

  const meanRGB = (o) => {
    let r = 0, g2 = 0, bb = 0, n = 0;
    for (let i = 0; i < o.rgb.length; i += o.ch) { r += o.rgb[i]; g2 += o.rgb[i + 1]; bb += o.rgb[i + 2]; n++; }
    return { r: r / n, g: g2 / n, b: bb / n };
  };
  const mA = meanRGB(rgbA), mB = meanRGB(rgbB);
  const tempDelta = Math.abs((mA.r - mA.b) - (mB.r - mB.b));

  // ---- 判定 ----
  const issues = [];
  let score = 100;

  if (borderChange > 0.10) {
    issues.push(`边框区域变化 ${(borderChange * 100).toFixed(1)}% —— 背景或机位变了，模型会把背景一起形变`);
    score -= 40;
  } else if (borderChange > 0.05) {
    issues.push(`边框区域轻微变化 ${(borderChange * 100).toFixed(1)}% —— 建议确认机位是否完全一致`);
    score -= 15;
  }

  if (all.changedRatio > 0.45) {
    issues.push(`全画面变化 ${(all.changedRatio * 100).toFixed(1)}% —— 两帧差异过大，模型无法插值，只会做形变`);
    score -= 40;
  } else if (all.changedRatio > 0.28) {
    issues.push(`全画面变化 ${(all.changedRatio * 100).toFixed(1)}% —— 偏大，建议缩小动作幅度或插入中间帧`);
    score -= 20;
  }

  // 动作是否真的发生：这是比「差异过大」更常见的失败。
  // 要求动作的镜，若实质变化占比过低，说明模型被「保持不变」约束吓住了，尾帧等于首帧。
  const isActionShot = opts.expectMotion !== false;
  if (isActionShot) {
    if (motionRatio < 0.012) {
      issues.push(
        `实质变化仅 ${(motionRatio * 100).toFixed(1)}% —— 动作几乎没有发生，尾帧等于首帧，视频里会变成静止画面`
      );
      score -= 35;
    } else if (motionRatio < 0.03) {
      issues.push(`实质变化 ${(motionRatio * 100).toFixed(1)}% —— 幅度偏小，确认动作是否足以看清`);
      score -= 12;
    }
  }

  if (bbox && bbox.w > 0.75 && bbox.h > 0.75 && motionRatio > 0.25) {
    issues.push(
      `变化区域占画面 ${(bbox.w * 100).toFixed(0)}%×${(bbox.h * 100).toFixed(0)}% 且实质变化 ${(motionRatio * 100).toFixed(0)}% —— 主体整体位移过大，不是局部动作`
    );
    score -= 20;
  }

  if (lumDelta > 18) {
    issues.push(`亮度均值差 ${lumDelta.toFixed(1)} —— 曝光不一致，画面会整体闪变`);
    score -= 20;
  } else if (lumDelta > 10) {
    issues.push(`亮度均值差 ${lumDelta.toFixed(1)} —— 偏大，建议统一曝光`);
    score -= 8;
  }

  if (lumStdDelta > 12) {
    issues.push(`对比度差 ${lumStdDelta.toFixed(1)} —— 两帧的明暗反差不同，插值时会"呼吸"`);
    score -= 12;
  }

  if (tempDelta > 14) {
    issues.push(`色温差 ${tempDelta.toFixed(1)} —— 白平衡不一致，画面会偏色漂移`);
    score -= 15;
  }

  score = Math.max(0, Math.min(100, score));

  let verdict;
  if (score >= 80) verdict = "适合作为首尾帧";
  else if (score >= 55) verdict = "勉强可用，建议修一处再试";
  else verdict = "不适合，模型大概率会形变/滑移";

  return {
    files: [p1, p2],
    metrics: {
      totalChange: +(all.changedRatio * 100).toFixed(1),
      borderChange: +(borderChange * 100).toFixed(1),
      centerChange: +(center.changedRatio * 100).toFixed(1),
      motionRatio: +(motionRatio * 100).toFixed(1),
      meanDiff: +all.meanDiff.toFixed(1),
      bbox: bbox ? { w: +(bbox.w * 100).toFixed(0), h: +(bbox.h * 100).toFixed(0), cx: +bbox.cx.toFixed(2), cy: +bbox.cy.toFixed(2) } : null,
      lumDelta: +lumDelta.toFixed(1),
      lumStdDelta: +lumStdDelta.toFixed(1),
      tempDelta: +tempDelta.toFixed(1),
    },
    score,
    verdict,
    issues,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--batch") {
    const pairs = JSON.parse(fs.readFileSync(args[1], "utf8"));
    const out = [];
    for (const [a, b] of pairs) {
      const r = await check(a, b);
      out.push(r);
      console.log("=".repeat(72));
      print(r);
    }
    const dest = args[2] || "pair_check.json";
    fs.writeFileSync(dest, JSON.stringify(out, null, 2), "utf8");
    console.log("\n结果已写入 " + dest);
    return;
  }

  if (args.length < 2) {
    console.error("用法: node pair_check.js <首帧> <尾帧>");
    process.exit(1);
  }

  const r = await check(args[0], args[1]);
  print(r);
}

// 供其他模块调用（不触发 CLI）
module.exports = { checkPair: check };

if (require.main === module) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}

function print(r) {
  console.log("首帧: " + r.files[0]);
  console.log("尾帧: " + r.files[1]);
  console.log("");
  const m = r.metrics;
  console.log("  全画面变化率   " + String(m.totalChange).padStart(5) + "%   （>28% 偏大，>45% 不可用）");
  console.log("  边框变化率     " + String(m.borderChange).padStart(5) + "%   （>5% 机位可能变了）");
  console.log("  实质变化率     " + String(m.motionRatio).padStart(5) + "%   （<1.2% 动作没发生，<3% 幅度偏小）");
  console.log("  中心变化率     " + String(m.centerChange).padStart(5) + "%");
  console.log("  变化区包围盒   " + (m.bbox ? m.bbox.w + "% × " + m.bbox.h + "%" : "无变化"));
  console.log("  亮度差         " + String(m.lumDelta).padStart(5) + "     （>10 偏大）");
  console.log("  对比度差       " + String(m.lumStdDelta).padStart(5));
  console.log("  色温差         " + String(m.tempDelta).padStart(5));
  console.log("");
  console.log("  评分 " + r.score + "/100 → " + r.verdict);
  if (r.issues.length) {
    console.log("");
    for (const it of r.issues) console.log("  · " + it);
  }
}
