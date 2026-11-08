#!/usr/bin/env node
/**
 * 把 beats 目录下所有分镜帧拼成一张带标签的总览图。
 * 用途：交付前必须自己整片扫一遍——审片只对照 checks，判不了"这张图对不对"。
 *
 *   node overview.js --project projects/打戏
 */
"use strict";

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const get = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};

const project = get("--project") || "projects/打戏";
const dir = path.join(project, "20-frames", "beats");
const outDir = path.join(project, "40-out");
const only = get("--shot");

if (!fs.existsSync(dir)) throw new Error("找不到目录: " + dir);
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  let files = fs
    .readdirSync(dir)
    .filter((f) => /^S\d+_b\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = a.match(/S(\d+)_b(\d+)/);
      const nb = b.match(/S(\d+)_b(\d+)/);
      return Number(na[1]) - Number(nb[1]) || Number(na[2]) - Number(nb[2]);
    });

  if (only) files = files.filter((f) => f.startsWith(only + "_"));
  if (!files.length) throw new Error("没有帧");

  const TW = 260; // 缩略图宽
  const TH = Math.round((TW * 2048) / 1152); // 竖屏比例
  const COLS = 6;
  const GAP = 10;
  const LABEL = 26;

  const rows = Math.ceil(files.length / COLS);
  const W = COLS * TW + (COLS + 1) * GAP;
  const H = rows * (TH + LABEL) + (rows + 1) * GAP;

  const comps = [];
  for (let i = 0; i < files.length; i++) {
    const buf = await sharp(path.join(dir, files[i]))
      .resize(TW, TH, { fit: "cover" })
      .jpeg({ quality: 90 })
      .toBuffer();
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    comps.push({
      input: buf,
      left: GAP + c * (TW + GAP),
      top: GAP + r * (TH + LABEL + GAP),
    });
  }

  const labels = files
    .map((f, i) => {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      const x = GAP + c * (TW + GAP) + 2;
      const y = GAP + r * (TH + LABEL + GAP) + TH + 20;
      const name = f.replace(/\.png$/i, "");
      return `<text x="${x}" y="${y}" fill="#e8e8e8" font-size="18" font-family="Segoe UI, sans-serif">${name}</text>`;
    })
    .join("");

  comps.push({
    input: Buffer.from(`<svg width="${W}" height="${H}">${labels}</svg>`),
    left: 0,
    top: 0,
  });

  const out = path.join(outDir, only ? `overview_${only}.jpg` : "overview_all.jpg");
  await sharp({
    create: { width: W, height: H, channels: 3, background: "#0e0e10" },
  })
    .composite(comps)
    .jpeg({ quality: 88 })
    .toFile(out);

  console.log("帧数:", files.length, "→", out, `${W}x${H}`);
})();
