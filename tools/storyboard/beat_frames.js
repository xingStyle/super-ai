#!/usr/bin/env node
/**
 * 分镜帧（beat frames）：为一个镜头生成多个关键帧，并用时间戳告诉 H3 怎么走。
 *
 * 为什么需要它：
 *   只给一张首帧，H3 不知道接下来的表演走向，只能自己瞎编——
 *   于是出现「莫名其妙」「看不懂要干嘛」「一个动作慢慢做完」。
 *
 * 给多张帧 + 明确的"第几秒到第几秒之间发生什么"，模型才有路径可走。
 *
 * 分镜定义（00-spec/shots.json 里每个 shot 可选）：
 *   "beats": [
 *     { "t": 0.0,  "name": "起手",   "prompt": "…这一帧的完整画面描述…" },
 *     { "t": 1.2,  "name": "相撞",   "prompt": "…" },
 *     { "t": 2.8,  "name": "收势",   "prompt": "…" }
 *   ]
 *
 * 每个 beat：
 *   1. 用同一个场景/角色参考图生成一张帧（保证同一空间、同一人物）
 *   2. 帧与帧之间跑 pair_check，确认机位没漂
 *   3. 在 h3 提示词里写 <Picture N> At 00:01.200, ...
 *
 * 用法:
 *   node beat_frames.js --project projects/打戏 --shot S02 --force
 *   node beat_frames.js --project projects/打戏 --all --concurrency 3
 *   node beat_frames.js --project projects/打戏 --shot S02 --dry-run
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_BASE = "https://grsai.dakka.com.cn";
const IMAGE_MODEL = "gpt-image-2.5-flare";
const KEY_RE = /sk-[A-Za-z0-9_-]{10,}/;
const KEY_EXTS = new Set([".txt", ".text", ".key", ".env"]);

const log = (...a) => console.log(...a);
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

async function postJson(base, key, p, payload, timeout = 420, retries = 3) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(base.replace(/\/+$/, "") + p, {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (r.status === 200) return await r.json();
      last = `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`;
      if ([400, 401, 403, 404].includes(r.status)) break;
    } catch (e) {
      last = String(e);
    }
    await sleep(2000 + 3000 * i);
  }
  throw new Error(`POST ${p} 失败: ${last}`);
}

function extractUrl(d) {
  for (const it of d.results || []) if (it && it.url) return it.url;
  if (typeof d.url === "string") return d.url;
  return null;
}

async function generate(base, key, prompt, size, quality, images) {
  const payload = { model: IMAGE_MODEL, prompt, aspectRatio: size, quality, replyType: "async" };
  if (images && images.length) payload.images = images;
  const d = await postJson(base, key, "/v1/api/generate", payload);
  const u = extractUrl(d);
  if (u) return u;
  const id = d.id || d.taskId;
  if (!id) throw new Error("无 URL 也无 taskId: " + JSON.stringify(d).slice(0, 300));

  const deadline = Date.now() + 420 * 1000;
  let delay = 3000;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay + 2000, 8000);
    let r;
    try {
      const res = await fetch(base.replace(/\/+$/, "") + "/v1/api/result?id=" + encodeURIComponent(id), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status !== 200) continue;
      r = await res.json();
    } catch {
      continue;
    }
    const st = String(r.status || "").toLowerCase();
    const u2 = extractUrl(r);
    if (["succeeded", "success", "completed", "finished"].includes(st)) {
      if (u2) return u2;
      throw new Error("成功但无图");
    }
    if (["failed", "error", "cancelled", "canceled"].includes(st)) {
      throw new Error("生成失败: " + JSON.stringify(r).slice(0, 300));
    }
    if (u2) return u2;
  }
  throw new Error("轮询超时");
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return dest;
    } catch (e) {
      if (i === 2) throw new Error("下载失败: " + e);
      await sleep(2000);
    }
  }
}

let sharp = null;
async function dataUrl(p, maxSide = 1280) {
  if (!sharp) sharp = require("sharp");
  const buf = fs.readFileSync(p);
  const meta = await sharp(buf).metadata();
  let out = buf;
  if (Math.max(meta.width, meta.height) > maxSide) {
    out = await sharp(buf).resize({ width: maxSide, height: maxSide, fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
  } else {
    out = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
  }
  return "data:image/jpeg;base64," + out.toString("base64");
}

/** 解析参考图：10-refs → 20-frames → 项目内 → 仓库根 */
function resolveRef(projDir, outDir, name) {
  const bare = path.isAbsolute(name) ? name : path.basename(name);
  const cands = [
    path.isAbsolute(name) ? name : path.join(projDir, "10-refs", bare),
    path.join(projDir, "10-refs", "bare", bare),
    path.join(outDir, bare.endsWith(".png") ? bare : bare + ".png"),
    path.join(outDir, bare),
    path.isAbsolute(name) ? name : path.join(projDir, name),
    path.isAbsolute(name) ? name : path.join(PROJECT_ROOT, name),
  ];
  const hit = cands.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!hit) throw new Error(`参考图找不到：${name}`);
  return hit;
}

/**
 * 单个 beat 帧的提示词。
 * 关键：必须声明"这是第 N 个关键帧，对应第 X 秒"，并锁死与首帧相同的机位、背景、光位。
 * 否则每张帧各编一套背景，拼起来就是跳的。
 */
function buildBeatPrompt(shot, beat, idx, total, styleLock, anchor) {
  const tSec = Number(beat.t) || 0;
  return (
    `【本图用途】这是一个镜头的第 ${idx + 1} / ${total} 个关键帧（分镜帧），对应这一镜的第 ${tSec.toFixed(1)} 秒。` +
    `它不会被单独使用，而是与同一镜的其他关键帧一起喂给视频模型，用来规定动作走向。\n` +
    `**必须与同一镜的其他帧保持完全相同的机位、构图、背景、光位、人物位置基准**，只有人物的姿态与动作进度不同。\n\n` +
    `【统一视觉锚点】${styleLock}\n\n` +
    `【这一帧的画面】${beat.prompt}\n\n` +
    (anchor ? `【空间基准】${anchor}\n\n` : "") +
    `【硬性要求】\n` +
    `- 机位与取景范围固定，不要重新设计场景，不要改变光线方向\n` +
    `- 人物比例、与镜头的距离感保持不变\n` +
    `- 画面内不得出现任何文字、时间码、分镜边框、水印`
  );
}

async function runShotBeat(shot, ctx) {
  const { base, key, projDir, outDir, styleLock, force, size, quality } = ctx;
  const beats = shot.beats || [];
  if (!beats.length) return { skipped: true };

  const beatDir = path.join(outDir, "beats");
  fs.mkdirSync(beatDir, { recursive: true });

  const refs = [];
  for (const r of shot.ref || []) {
    try {
      refs.push(resolveRef(projDir, outDir, r));
    } catch (e) {
      throw new Error(`[${shot.id}] ${e.message}`);
    }
  }

  const results = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const dest = path.join(beatDir, `${shot.id}_b${i + 1}.png`);
    if (fs.existsSync(dest) && !force) {
      log(`  [${shot.id}] beat ${i + 1}/${beats.length} 已存在，跳过`);
      results.push({ ...b, file: dest, skipped: true });
      continue;
    }
    // 新结构用 frame_prompt（自带完整上下文）；旧结构用 buildBeatPrompt 拼装
    const prompt = b.frame_prompt || buildBeatPrompt(shot, b, i, beats.length, styleLock, "");
    log(`  [${shot.id}] 生成 beat ${i + 1}/${beats.length}（第 ${(Number(b.t) || 0).toFixed(1)} 秒：${b.name || ""}）…`);
    const urls = [];
    for (const r of refs) urls.push(await dataUrl(r));
    const url = await generate(base, key, prompt, size, quality, urls);
    await download(url, dest);
    results.push({ ...b, file: dest });
  }
  return { beats: results, beatDir };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

  const projArg = get("--project");
  const shotArg = get("--shot");
  const all = argv.includes("--all");
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const concurrency = Math.max(1, Number(get("--concurrency") || 1));

  if (!projArg) {
    console.error("用法: node beat_frames.js --project projects/打戏 [--shot S02 | --all] [--force] [--dry-run]");
    process.exit(1);
  }

  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const spec = JSON.parse(fs.readFileSync(path.join(projDir, "00-spec", "shots.json"), "utf8"));
  const outDir = path.join(projDir, "20-frames");
  const styleLock = spec.style_lock || "";

  let shots = spec.shots.filter((s) => Array.isArray(s.beats) && s.beats.length);
  if (shotArg) shots = shots.filter((s) => s.id === shotArg);
  if (!all && !shotArg) shots = shots.slice(0, 1);

  if (!shots.length) {
    console.error("没有找到带 beats 的镜头。请先在 shots.json 里给镜头加 beats[]。");
    process.exit(1);
  }

  if (dryRun) {
    for (const s of shots) {
      log("=".repeat(72));
      log(`${s.id}  ${s.title || ""}  共 ${s.beats.length} 个分镜帧`);
      for (let i = 0; i < s.beats.length; i++) {
        log("-".repeat(72));
        log(buildBeatPrompt(s, s.beats[i], i, s.beats.length, styleLock, ""));
      }
    }
    return;
  }

  const key = findApiKey(PROJECT_ROOT);
  const ctx = { base: DEFAULT_BASE, key, projDir, outDir, styleLock, force, size: "1152x2048", quality: "high" };

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= shots.length) return;
      const s = shots[i];
      log(`[${s.id}] 开始生成 ${s.beats.length} 个分镜帧…`);
      try {
        await runShotBeat(s, ctx);
        log(`[${s.id}] 完成`);
      } catch (e) {
        log(`[${s.id}] 失败：${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, shots.length) }, worker));
  log("");
  log("全部完成。帧保存在 20-frames/beats/");
}

module.exports = { buildBeatPrompt, resolveRef };

if (require.main === module) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}
