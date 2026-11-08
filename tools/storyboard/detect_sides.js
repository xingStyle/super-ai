#!/usr/bin/env node
/**
 * 从实际图片检测「谁在画面哪一侧」，而不是凭想象声明。
 *
 * 教训：S07 的底图里苏晚本来就在左边，我却在提示词里写「苏晚在右侧」，
 * 模型照我的指令把人换了位置，我却判它「左右对调」——错的是声明。
 *
 * 所以方位必须**从图里读出来**，不能写。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_BASE = "https://grsak.dakka.com.cn";
const KEY_RE = /sk-[A-Za-z0-9_-]{10,}/;
const KEY_EXTS = new Set([".txt", ".text", ".key", ".env"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findApiKey(root) {
  if (process.env.GRSAI_API_KEY) return process.env.GRSAI_API_KEY.trim();
  const skip = new Set([".git", "node_modules", "out", "__pycache__"]);
  const walk = (dir, depth) => {
    if (depth > 4) return null;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name.toLowerCase())) continue;
        const r = walk(p, depth + 1);
        if (r) return r;
        continue;
      }
      if (!KEY_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      try {
        if (fs.statSync(p).size > 8192) continue;
        const m = fs.readFileSync(p, "utf8").match(KEY_RE);
        if (m) return m[0];
      } catch {
        /* ignore */
      }
    }
    return null;
  };
  return walk(root, 0);
}

async function postJson(base, key, p, payload, timeout = 180) {
  const r = await fetch(base.replace(/\/+$/, "") + p, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function dataUrl(p, maxSide = 1100) {
  const buf = fs.readFileSync(p);
  const meta = await sharp(buf).metadata();
  let out;
  if (Math.max(meta.width, meta.height) > maxSide) {
    out = await sharp(buf).resize({ width: maxSide, height: maxSide, fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
  } else {
    out = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
  }
  return "data:image/jpeg;base64," + out.toString("base64");
}

async function detect(base, key, img) {
  const text =
    "这是一张双人打斗画面的截图。画面里有两个人：\n" +
    "A = 穿浅灰蓝交领练功服、黑色齐下巴短发的年轻女子\n" +
    "B = 穿白色短袖T恤、黑色长裤、黑色高帮鞋的短发年轻男子\n\n" +
    "请判断他们各自在画面的哪一侧。只输出 JSON，不要解释：\n" +
    '{"left":"A 或 B 或 无","right":"A 或 B 或 无","both_visible":true 或 false,"note":"一句话"}';

  const d = await postJson(base, key, "/v1/chat/completions", {
    model: "gemini-3.1-pro",
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: await dataUrl(img) } },
        ],
      },
    ],
  });
  const raw = d?.choices?.[0]?.message?.content || "";
  const body = String(raw).replace(/^```(?:json)?|```$/gm, "").trim();
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("非法返回：" + body.slice(0, 120));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const projArg = get("--project") || "projects/打戏";
  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const j = JSON.parse(fs.readFileSync(path.join(projDir, "00-spec", "shots.json"), "utf8"));
  const key = findApiKey(PROJECT_ROOT);
  const base = "https://grsai.dakka.com.cn";
  const beatsDir = path.join(projDir, "20-frames", "beats");

  console.log("镜/帧          左      右     判定");
  console.log("-".repeat(56));
  const truth = {};

  for (const s of j.shots) {
    for (let i = 1; i <= s.beats.length; i++) {
      const f = path.join(beatsDir, `${s.id}_b${i}.png`);
      if (!fs.existsSync(f)) continue;
      try {
        const r = await detect(base, key, f);
        const L = r.left === "A" ? "苏晚" : r.left === "B" ? "陆沉" : "-";
        const R = r.right === "A" ? "苏晚" : r.right === "B" ? "陆沉" : "-";
        if (!truth[s.id]) truth[s.id] = [];
        truth[s.id].push({ frame: i, left: L, right: R });
        console.log(`${s.id}_b${i}`.padEnd(14), L.padEnd(7), R.padEnd(6), r.both_visible ? "" : "（未双人同框）");
      } catch (e) {
        console.log(`${s.id}_b${i}`.padEnd(14), "检测失败", e.message.slice(0, 30));
      }
      await sleep(300);
    }
    console.log("");
  }

  // 汇总每镜是否一致
  console.log("=".repeat(56));
  console.log("每镜实际方位（多数帧）");
  for (const [id, frames] of Object.entries(truth)) {
    const l = frames.map((x) => x.left).filter((x) => x !== "-");
    const r = frames.map((x) => x.right).filter((x) => x !== "-");
    const count = (arr, v) => arr.filter((x) => x === v).length;
    const L = count(l, "苏晚") >= count(l, "陆沉") ? "苏晚" : "陆沉";
    const R = L === "苏晚" ? "陆沉" : "苏晚";
    const consistent = frames.every((x) => x.left === "-" || x.left === L);
    console.log(`${id}  左=${L}  右=${R}  ${consistent ? "全镜一致" : "★ 镜内不一致"}`);
  }

  fs.writeFileSync(
    path.join(projDir, "20-frames", "beats", "_truth_sides.json"),
    JSON.stringify(truth, null, 2)
  );
  console.log("\n已写入 _truth_sides.json");
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
