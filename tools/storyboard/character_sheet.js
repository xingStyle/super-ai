#!/usr/bin/env node
/**
 * 生成角色定妆照（四视图卡：正面全身 / 侧面全身 / 背面全身 / 头部特写）
 * 用法: node tools/storyboard/character_sheet.js --spec tools/storyboard/shots-song.json
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

async function postJson(base, key, p, payload, timeout = 120, retries = 3) {
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

async function generate(base, key, prompt, size, quality, timeout) {
  const d = await postJson(base, key, "/v1/api/generate", {
    model: IMAGE_MODEL,
    prompt,
    aspectRatio: size,
    quality,
    replyType: "async",
  });
  const u = extractUrl(d);
  if (u) return u;
  const id = d.id || d.taskId;
  if (!id) throw new Error("无 URL 也无 taskId: " + JSON.stringify(d).slice(0, 300));

  const deadline = Date.now() + timeout * 1000;
  let delay = 3000;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay + 2000, 8000);
    let r;
    try {
      const res = await fetch(base.replace(/\/+$/, "") + "/v1/api/result?id=" + encodeURIComponent(id), {
        headers: { Authorization: "Bearer " + key },
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
      throw new Error("成功但无图: " + JSON.stringify(r).slice(0, 300));
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

function buildPrompt(char, styleLock) {
  return (
    `角色定妆照四视图参考卡，横向画幅，中性浅灰背景，无场景、无道具、无文字。` +
    `画面从左到右均匀排列四个等高的同一人物视图，四者必须严格是同一个人、同一套服装、同一发型、同一光线：` +
    `① 正面全身站姿（双手自然垂放，双脚与肩同宽）；` +
    `② 右侧面全身站姿（正侧脸，能看清鼻梁与下颌轮廓）；` +
    `③ 背面全身站姿（能看清后脑、披风与甲胄背面结构）；` +
    `④ 头部正面特写（胸口以上，五官、胡须、发型、头盔细节清晰）。` +
    `人物设定：${char.name}——${char.desc}，${styleLock}` +
    `四个视图之间留均匀白色间隔，人物比例与身高在四个视图中完全一致，像文物摄影棚里的标准图录照。` +
    `整体为实拍质感，柔和均匀的摄影棚光，无戏剧性阴影，便于作为角色参考。` +
    `画面内不得出现任何文字、标注、箭头、水印、logo。`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const projArg = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : "projects/song";
  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const specPath = argv.includes("--spec")
    ? path.resolve(argv[argv.indexOf("--spec") + 1])
    : path.join(projDir, "00-spec", "shots.json");
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
  const size = argv.includes("--size") ? argv[argv.indexOf("--size") + 1] : "2048x1152";
  const concurrency = argv.includes("--concurrency") ? Number(argv[argv.indexOf("--concurrency") + 1]) : 3;

  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const chars = (spec.characters || []).filter((c) => !only || only.includes(c.id));
  if (!chars.length) throw new Error("没有角色");

  const key = findApiKey(PROJECT_ROOT);
  const base = DEFAULT_BASE;
  const outDir = path.join(projDir, "10-refs");
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= chars.length) return;
      const c = chars[i];
      const dest = path.join(outDir, c.sheet || `char-${c.id}.png`);
      if (fs.existsSync(dest) && !argv.includes("--force")) {
        log(`[${c.id}] 已存在，跳过：${path.relative(PROJECT_ROOT, dest)}`);
        results[i] = { id: c.id, file: dest, skipped: true };
        continue;
      }
      const prompt = buildPrompt(c, spec.style_lock);
      log(`[${c.id}] 生成定妆照…`);
      const url = await generate(base, key, prompt, size, "high", 420);
      await download(url, dest);
      log(`[${c.id}] 已保存 ${path.relative(PROJECT_ROOT, dest)}`);
      results[i] = { id: c.id, file: dest, url };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chars.length) }, worker));

  log("");
  log("完成：");
  for (const r of results) if (r) log(`  ${r.id} -> ${path.relative(PROJECT_ROOT, r.file)}`);
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
