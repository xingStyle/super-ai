#!/usr/bin/env node
/**
 * 多分镜帧的 img2img 链路验证。
 *
 * 问题：独立文生图生成 30 帧，实测每帧的机位、背景、人物大小全变，
 * 边框变化 20–74%（可用阈值是 5%）。H3 拿到的是 30 个不同的房间。
 *
 * 本脚本验证另一条路：以首帧为底图，逐帧 img2img，只改姿态。
 * 判定标准（两层，缺一层就会放行烂帧）：
 *   像素层：边框变化 < 5%，实质变化 > 1.2%
 *   视觉层：姿态真的变了没有、头身有没有漂
 *
 * 用法:
 *   node beat_img2img.js --project projects/打戏 --shot S07
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_BASE = "https://grsai.dakka.com.cn";
const IMAGE_MODEL = "gpt-image-2.5-flare";
const MOTION_CHECK_MODEL = "gemini-3.1-pro";
const KEY_RE = /sk-[A-Za-z0-9_-]{10,}/;
const KEY_EXTS = new Set([".txt", ".text", ".key", ".env"]);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findApiKey(root) {
  if (process.env.GRSAI_API_KEY) return process.env.GRSAI_API_KEY.trim();
  const skip = new Set([".git", "node_modules", "out", "20-frames", "__pycache__"]);
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

/**
 * img2img 的尾帧提示词。
 * 三条必须同时写，缺一条就会失败：
 *   ① 不变清单（机位、背景、光位、服装、人物比例、左右方位）
 *   ② 这一帧必须画成的姿态（不是"稍微变一点"，而是明确画成）
 *   ③ 视线（双方各自在看哪里）
 */
function buildPrompt(shot, beat, base) {
  const L = shot.stage_layout || {};
  const su = L.suwan_screen_side === "R" ? "右侧" : "左侧";
  const lu = L.luchen_screen_side === "R" ? "右侧" : "左侧";

  return (
    `这是一张已经拍好的画面，是同一镜头的第 ${base} 帧。请**在完全保留原图场景的前提下**，` +
    `把人物替换成该动作推进到下一瞬间的姿态，生成这一镜的下一帧。\n\n` +
    `【必须完全不变的部分】\n` +
    `- 机位、取景范围、画幅比例与边缘裁切位置，画面边缘必须与原图逐像素对齐\n` +
    `- 背景的一切细节：木立柱、供桌、墙面、地面干草的位置与形状\n` +
    `- 光位与光强：月光的方向、亮区与暗区的位置\n` +
    `- 人物服装、发型、体型比例、与镜头的距离感\n` +
    `- **左右方位：苏晚在画面${su}，陆沉在画面${lu}，绝不能对调**\n\n` +
    `【这一帧必须画成的姿态（不是稍微变一点，而是明确画成这个样子）】\n` +
    `${beat.frame_prompt}\n\n` +
    `【硬性要求】\n` +
    `- 除人物姿态外任何像素都不应位移或缩放\n` +
    `- 不允许淡入淡出、不允许叠化、不允许直接跳帧\n` +
    `- 画面内不得出现任何文字、时间码、水印`
  );
}

/** 视觉复核：姿态有没有真的变、有没有漂 */
async function verify(base, key, a, b, beatName) {
  const text =
    "你是一位严格的动画监督。第一张图是一个镜头的上一帧，第二张图是下一帧。\n" +
    `这两帧之间，人物应当完成这个姿态变化：「${beatName}」。\n` +
    "请判断：\n" +
    "1. 第二张图里人物的姿态，是否明显不同于第一张？（只是披风飘动、火光跳动、颗粒噪声不算）\n" +
    "2. 机位、背景、左右方位有没有变？（人物左右位置对调、背景换位置，都算变了）\n" +
    "3. 人物有没有漂移？（头饰、发型、服装、体型改掉了算漂移）\n" +
    "只输出 JSON，不要 markdown：\n" +
    '{"pose_changed":true 或 false,"camera_moved":true 或 false,"drift":true 或 false,"note":"一句话说明"}';

  const d = await postJson(
    base,
    key,
    "/v1/chat/completions",
    {
      model: MOTION_CHECK_MODEL,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: await dataUrl(a) } },
            { type: "image_url", image_url: { url: await dataUrl(b) } },
          ],
        },
      ],
    },
    240
  );
  const raw = d?.choices?.[0]?.message?.content;
  const body = String(raw || "").replace(/^```(?:json)?|```$/gm, "").trim();
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("复核返回非法：" + body.slice(0, 150));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const projArg = get("--project");
  const shotId = get("--shot");

  if (!projArg || !shotId) {
    console.error("用法: node beat_img2img.js --project projects/打戏 --shot S07");
    process.exit(1);
  }

  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const spec = JSON.parse(fs.readFileSync(path.join(projDir, "00-spec", "shots.json"), "utf8"));
  const shot = spec.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error("找不到镜头 " + shotId);

  const beatsDir = path.join(projDir, "20-frames", "beats");
  const testDir = path.join(projDir, "20-frames", "beats_img2img");
  fs.mkdirSync(testDir, { recursive: true });

  const key = findApiKey(PROJECT_ROOT);
  const base = DEFAULT_BASE;
  const { checkPair } = require("./pair_check.js");

  // 以现成的 b1 为底图（它已经通过了构图审查）
  const src = path.join(beatsDir, `${shotId}_b1.png`);
  if (!fs.existsSync(src)) throw new Error("找不到底图 " + src);

  log(`底图：${path.relative(PROJECT_ROOT, src)}`);
  log(`本镜共 ${shot.beats.length} 帧，将以 b1 为基准逐帧生成\n`);

  let prev = src;
  const results = [];

  for (let i = 1; i < shot.beats.length; i++) {
    const beat = shot.beats[i];
    const dest = path.join(testDir, `${shotId}_b${i + 1}.png`);
    log(`── 第 ${i + 1} 帧「${beat.name}」（应到 ${beat.t}s）`);

    const prompt = buildPrompt(shot, beat, i);
    const url = await generate(base, key, prompt, "1152x2048", "high", [await dataUrl(src)]);
    await download(url, dest);

    const r = await checkPair(src, dest);
    log(`   像素层：边框 ${r.metrics.borderChange}%  全画面 ${r.metrics.totalChange}%  实质 ${r.metrics.motionRatio}%  评分 ${r.score}`);

    let mv = null;
    try {
      mv = await verify(base, key, prev, dest, beat.name);
      log(`   视觉层：姿态变了=${mv.pose_changed}  机位动了=${mv.camera_moved}  漂移=${mv.drift}`);
      if (mv.note) log(`   备注：${mv.note}`);
    } catch (e) {
      log(`   视觉复核失败：${e.message}`);
    }

    const pass =
      r.metrics.borderChange < 5 &&
      r.metrics.motionRatio > 1.2 &&
      mv &&
      mv.pose_changed === true &&
      mv.camera_moved === false &&
      mv.drift === false;
    log(`   → ${pass ? "✓ 通过" : "✗ 不通过"}\n`);

    results.push({ frame: i + 1, name: beat.name, ...r.metrics, score: r.score, mv, pass });
    prev = dest;
  }

  // 汇总
  log("═".repeat(60));
  const ok = results.filter((x) => x.pass).length;
  log(`结果：${ok}/${results.length} 帧通过`);
  log("");
  for (const x of results) {
    const why = [];
    if (x.borderChange >= 5) why.push(`边框${x.borderChange}%`);
    if (x.motionRatio <= 1.2) why.push(`实质${x.motionRatio}%`);
    if (x.mv?.pose_changed === false) why.push("姿态没变");
    if (x.mv?.camera_moved) why.push("机位动了");
    if (x.mv?.drift) why.push("人物漂移");
    log(`  b${x.frame} ${x.name}  ${x.pass ? "✓" : "✗ " + why.join("/")}`);
  }
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
