#!/usr/bin/env node
/**
 * 生成场景全景图（规则 5.5）。
 *
 * 每场戏必须先有一张场景全景图，作为该场所有镜头的空间基准。
 * 它要能看清整个空间的四至关系：场地走向、出入口位置、主要陈设在哪、光源分布。
 *
 * 没有这张图，切到任何人的正脸，背后景物都是模型现编的，每镜一套。
 *
 * 用法:
 *   node scene_sheet.js --project projects/打戏 --id citang
 *   node scene_sheet.js --project projects/打戏 --id citang --force
 *
 * 场景描述写在 00-spec/shots.json 的 scenes[] 里：
 *   "scenes": [
 *     { "id": "citang", "name": "废弃老祠堂",
 *       "desc": "抬梁式木构，四根立柱，屋顶破洞，青砖地半干" }
 *   ]
 *
 * 产物: projects/<项目>/10-refs/scene-<id>.png
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

async function generate(base, key, prompt, size, quality) {
  const payload = { model: IMAGE_MODEL, prompt, aspectRatio: size, quality, replyType: "async" };
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

/**
 * 场景全景图提示词。
 * 关键：这不是"好看的气氛图"，而是空间说明书。必须能回答四件事——
 * 出入口在哪、主要陈设在哪、光源在哪、各方向通向哪里。
 *
 * 关于"地面总是湿的"（实测踩过多次）：
 *   模型的训练先验里，"废弃室内 + 一束光 + 电影感"几乎必然配湿地面。
 *   只写中文"干燥"无效；只加英文负面词也常常无效。
 *   真正有效的组合是三件事同时做：
 *     ① 英文正面词明确要什么（dry ground, dusty pavement）
 *     ② 英文负面词明确不要什么（wet, puddle, water reflection, glossy floor）
 *     ③ **光位改成不落地**——亮斑是光造成的，光不落地就没有反光可加
 *   第三件最关键：只改地面材质是治不了的。
 */
function buildPrompt(scene, styleLock) {
  return (
    `【本图用途】场景全景图，用于给后续所有镜头提供统一的空间锚点。` +
    `**不是剧照，不追求气氛与构图美感，要求是空间关系清楚可读。**\n` +
    `一个空旷的室内空间，**无人或只有极简的人形剪影作为尺度参照**（不出现清晰人脸、不出现主角）。\n` +
    `视角：斜俯视（约四十五度向下），从空间一角看向对角，能同时看到地面、两面墙与部分屋顶，` +
    `让观众一眼看懂这是一个什么形状的空间、有多深多宽。\n` +
    `必须清楚交代下面四件事，缺一不可：\n` +
    `① **出入口**：门或通道在哪个位置、朝哪个方向开；\n` +
    `② **主要陈设**：每件重要物件在哪、彼此相距多远、与出入口是什么相对位置；\n` +
    `③ **光源**：光从哪个方向来、落在哪个位置、亮区与暗区怎么分；\n` +
    `④ **地面与材质**：地面是什么材质、是什么状态；墙面与结构是什么材料。\n` +
    `**地面必须是干燥的，地面上没有任何反光和水渍。**\n` +
    `地面质感：干燥的、哑光的、粗糙的表面，覆着干浮尘与干草之类吸光的材质。\n` +
    `**光线不许打在地面上**：主光只照亮主要陈设与墙面、立柱，地面整片处于阴影里，地面上没有任何被照亮的亮斑、光带或高光点。\n` +
    `Positive: dry ground, dusty pavement, dry packed earth, scattered dry straw, matte textured floor, no wet surface, no reflections on the floor, ground in shadow, evenly dark floor, flat diffuse lighting on ground.\n` +
    `Negative (must avoid): wet, puddle, water reflection, glossy floor, damp floor, rain-soaked, slick surface, shimmering floor, wet sheen, specular highlight on ground, reflective tiles, bright spots on floor, light pool on ground, illuminated patch on floor, glow on floor, highlights on ground, wet patches, glistening.\n` +
    `空间描述：${scene.desc}\n` +
    `统一视觉基调：${styleLock}\n` +
    `整体为实拍质感，空间纵深清楚，物体边缘清晰可辨，暗部保留细节不要死黑。\n` +
    `Negative for the whole image: wet, puddle, water, water reflection, wet reflection, glossy surface, damp floor, rain, shimmering, glossy floor, bright spot on floor, light pool on ground, specular highlight.\n` +
    `**画面内绝对不得出现任何文字、标注、箭头、尺寸线、平面图符号、水印、logo、分屏。**`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

  const projArg = get("--project");
  const only = get("--id") ? get("--id").split(",") : null;
  const size = get("--size") || "2048x1152";
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");

  if (!projArg) {
    console.error(
      "用法: node scene_sheet.js --project projects/打戏 --id citang [--force] [--dry-run]"
    );
    process.exit(1);
  }

  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const specPath = path.join(projDir, "00-spec", "shots.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const scenes = (spec.scenes || []).filter((s) => !only || only.includes(s.id));
  if (!scenes.length) {
    throw new Error(
      "shots.json 里没有匹配的 scenes[]. 请先加：\n" +
        '  "scenes": [{ "id": "citang", "name": "...", "desc": "..." }]'
    );
  }

  const outDir = path.join(projDir, "10-refs");

  if (dryRun) {
    for (const s of scenes) {
      log("=".repeat(70));
      log(`${s.id}  ${s.name || ""}`);
      log("-".repeat(70));
      log(buildPrompt(s, spec.style_lock || ""));
    }
    return;
  }

  const key = findApiKey(PROJECT_ROOT);
  const base = DEFAULT_BASE;

  for (const s of scenes) {
    const dest = path.join(outDir, `scene-${s.id}.png`);
    if (fs.existsSync(dest) && !force) {
      log(`[${s.id}] 已存在，跳过：${path.relative(PROJECT_ROOT, dest)}（--force 可重做）`);
      continue;
    }
    log(`[${s.id}] 生成场景全景图…`);
    const prompt = buildPrompt(s, spec.style_lock || "");
    const url = await generate(base, key, prompt, size, "high");
    await download(url, dest);
    log(`[${s.id}] 已保存 ${path.relative(PROJECT_ROOT, dest)}`);
  }
  log("完成。");
}

module.exports = { buildPrompt };

if (require.main === module) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}
