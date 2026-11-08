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
  // 头发与体型是定妆照最容易翻车的两项，必须写进模板本身，
  // 不能只靠 char.desc——desc 常写得很简略，模型就会退回默认的「油头 + 肌肉男」。
  // 头发：核心矛盾是「要有型（蓬松、有层次、阳光）」vs「不能油」。
  // 关键认识：油光的根源是【发丝结块 + 有光泽】，不是【蓬松有层次】。
  // 所以正面写「蓬松轻盈、有层次、有空气感」，反面只锁「干燥哑光、不结块、不反光」。
  // 早期版本为了压油光把「层次」也删了，结果变成厚重锅盖头——矫枉过正。
  const HAIR =
    `发型：黑色**短碎发（textured crop）**，长度只有三到五厘米，短、整、利落。` +
    `两侧推短、干净不遮耳；顶部保留一点自然长度，头发顺着同一个方向向前自然伏贴；` +
    `前额完全露出，额头与眉毛清晰可见，**没有任何一缕头发遮住额头、眉毛或眼睛**。` +
    `整片头发是一整片连续的短发，贴合头型，不是一块一块的发块、不向上翘、不分缕、不呈锯齿状。` +
    `整体是干净、清爽、有精神的**阳光男生**短发，自然不做作，像刚洗过自然吹干。` +
    `**质地必须是干燥的**：整片头发是哑光表面，完全没有光泽，看不出任何定型产品的痕迹。` +
    `严禁：一缕缕分离的碎发、刺猬头、锯齿状发梢、碎块状发束、向上翘起的发梢、` +
    `遮住额头、遮住眉毛、遮住眼睛、长刘海、厚重齐刘海、锅盖头、` +
    `发胶感、油亮发丝、湿发质感、任何发丝上的高光、贴头皮、平塌、大背头、油头。`;
  const BODY =
    `人物是纤细清瘦的自然体型：肩宽适中、四肢细、胸腹平坦不显轮廓、手臂没有隆起的分块肌肉，` +
    `宽松衣物自然垂坠且没有被肌肉撑起；**脖子长度正常，不得拉长，头肩比例是正常年轻人的比例**；` +
    `严禁肌肉男、健美体型、粗壮手臂、暴突血管、宽厚倒三角躯干、胸肌轮廓、细长如竹竿的病态脖子。`;
  const SKIN =
    `皮肤哑光不反光，不出油光、不出镜面高光、不出汗水；高光只落在衣料与金属上，不落在皮肤上。`;

  return (
    `【本图用途】这是纯用于 AI 参考的角色定妆照，不是剧照、不是场景图。` +
    `下方设定里若出现任何关于场景、场地、光源、时间、天气的描述，**一律不采用**——` +
    `本图只在中性浅灰无缝背景前拍摄，与任何剧情场景无关。` +
    `角色定妆照四视图参考卡，横向画幅，中性浅灰无缝背景，无场景、无道具、无环境结构、无文字。` +
    `画面从左到右均匀排列四个等高的同一人物视图，四者必须严格是同一个人、同一套服装、同一发型、同一光线：` +
    `① 正面全身站姿（双手自然垂放，双脚与肩同宽）；` +
    `② 右侧面全身站姿（正侧脸，能看清鼻梁与下颌轮廓）；` +
    `③ 背面全身站姿（能看清后脑与服装背面结构）；` +
    `④ 头部正面特写（胸口以上，五官、胡须、发型细节清晰）。` +
    `人物设定：${char.name}——${char.desc}。` +
    HAIR +
    BODY +
    SKIN +
    `四个视图之间留均匀白色间隔，人物比例与身高在四个视图中完全一致，像文物摄影棚里的标准图录照。` +
    `**光线必须是大面积柔和均匀的正面漫射光（如柔光箱），从正面偏高处大面积铺开，光比很低、几乎没有阴影；` +
    `绝对不许出现顶光、侧硬光、逆光、轮廓光、聚光灯或任何在头发与皮肤上形成亮斑的光。**` +
    `整体为实拍质感，中性的证件照式布光，便于作为角色参考。` +
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
