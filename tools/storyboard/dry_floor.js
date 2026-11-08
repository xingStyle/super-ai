#!/usr/bin/env node
/**
 * 去湿地：把画面下半部（地面）的高光压掉，让湿润反光的砖面变成哑光干砖。
 *
 * 为什么需要它：
 *   文生图模型有个极强的默认倾向——只要场景是"破旧室内 + 一束光"，
 *   它就会自动给地面加湿润反光，因为这是它训练数据里最常见的"电影感"套路。
 *   在提示词里写多少遍"干燥、无水渍"都压不住，实测连试三次全是湿的。
 *
 *   所以改用后处理：直接压掉地面上被光照亮的那层镜面高光。
 *   人眼判断"湿"靠的就是这层高光，压掉它，干湿感立刻反过来。
 *
 * 用法:
 *   node dry_floor.js <图片> [--ratio 0.55] [--strength 0.85] [--out 输出路径]
 *
 *   --ratio     从画面高度的百分之几开始算地面（默认 0.55）
 *   --strength  高光压制强度 0-1（默认 0.85）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const log = (...a) => console.log(...a);

async function dryFloor(src, dest, { ratio = 0.55, strength = 1.0 } = {}) {
  const meta = await sharp(src).metadata();
  const W = meta.width;
  const H = meta.height;
  const y0 = Math.round(H * ratio);

  // 先算地面区的平均亮度，作为"压平"的目标基准
  const ground = await sharp(src)
    .extract({ left: 0, top: y0, width: W, height: H - y0 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const v of ground.data) sum += v;
  const meanLum = sum / ground.data.length;

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  // 「湿」的真正成因（实测）：
  //   地面亮度并不高（最高只到 79），但砖块之间与反光带之间的**局部对比过强**，
  //   加上过渡过于平滑、没有颗粒，眼睛就读成"像水面/油面"。
  // 所以要点不是压暗，而是：① 压掉局部高对比（把亮斑往均值拉）
  //                     ② 补颗粒打断平滑过渡  ③ 去冷调（水面偏蓝）
  for (let y = y0; y < H; y++) {
    const depth = (y - y0) / Math.max(1, H - y0);
    const k = strength * (1 - depth * 0.25);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      let r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      // 高于地面均值的部分，按强度往均值收（削掉反光斑）
      let nl = lum;
      if (lum > meanLum) {
        nl = meanLum + (lum - meanLum) * (1 - k * 0.72);
      }
      const s = lum > 0 ? nl / lum : 1;

      // 去冷调：蓝通道单独再压一点，湿润反光的冷蓝是"湿"最强的信号
      const blueCut = 1 - k * 0.28 * Math.max(0, (lum - meanLum * 0.8) / Math.max(1, meanLum));

      r *= s; g *= s; b *= s * blueCut;

      // 补颗粒：打断平滑渐变，让砖面"糙"起来
      const noise = (Math.random() - 0.5) * 15 * k;
      r += noise; g += noise; b += noise * 0.7;

      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  await sharp(data, { raw: { width: W, height: H, channels: ch } })
    .toColourspace("srgb")
    .png()
    .toFile(dest);

  return { dest, meanLum: +meanLum.toFixed(1) };
}

/** 量化"湿感"：地面区域的高光占比 */
async function wetness(src, ratio = 0.55) {
  const meta = await sharp(src).metadata();
  const { data } = await sharp(src)
    .extract({
      left: 0,
      top: Math.round(meta.height * ratio),
      width: meta.width,
      height: meta.height - Math.round(meta.height * ratio),
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hot = 0;
  for (const v of data) if (v > 150) hot++;
  return +((hot / data.length) * 100).toFixed(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const src = argv.find((a) => !a.startsWith("--") && a !== get("--ratio") && a !== get("--strength") && a !== get("--out"));

  if (!src) {
    console.error("用法: node dry_floor.js <图片> [--ratio 0.55] [--strength 0.85] [--out 输出]");
    process.exit(1);
  }
  const dest = get("--out") || src.replace(/\.png$/i, "") + ".dry.png";
  const before = await wetness(src, Number(get("--ratio") || 0.55));

  await dryFloor(src, dest, {
    ratio: Number(get("--ratio") || 0.55),
    strength: Number(get("--strength") || 0.85),
  });

  const after = await wetness(dest, Number(get("--ratio") || 0.55));
  log(`原图地面高光占比 ${before}%`);
  log(`处理后 ${after}%`);
  log(`已保存 ${dest}`);
}

module.exports = { dryFloor, wetness };

if (require.main === module) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}
