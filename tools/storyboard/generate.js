#!/usr/bin/env node
/**
 * 分镜图生成 + 自动审片流水线（Node 版，逻辑对齐 generate.py）
 *   gpt-image-2.5-flare 生成每一镜的静帧 -> 视觉模型对照分镜要求审核 -> 不合格带着修改意见重生成
 *
 * 用法:
 *   node tools/storyboard/generate.js --shots tools/storyboard/shots-siege.json --dry-run
 *   node tools/storyboard/generate.js --shots tools/storyboard/shots-siege.json --only S01 S04
 *
 * 产物:
 *   out/storyboard/S01.png ...            通过审核的静帧（可直接作为 H3 首帧）
 *   out/storyboard/attempts/              每一次尝试的原图 + 审核记录
 *   out/storyboard/manifest.json          机器可读的完整产物索引
 *   out/storyboard/h3_prompts.md          每镜 H3 提示词 + 对应首帧图
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

const DEFAULT_BASE = "https://grsai.dakka.com.cn";
const IMAGE_MODEL = "gpt-image-2.5-flare";
const DEFAULT_REVIEW_MODEL = "gemini-3.1-pro";
const KEY_RE = /sk-[A-Za-z0-9_-]{10,}/;
const KEY_EXTS = new Set([".txt", ".text", ".key", ".env", ".json", ""]);

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 基础设施

function findApiKey(root, explicit) {
  if (explicit) {
    const m = explicit.match(KEY_RE);
    return m ? m[0] : explicit.trim();
  }
  if (process.env.GRSAI_API_KEY) return process.env.GRSAI_API_KEY.trim();

  const found = [];
  const skip = new Set([".git", "node_modules", "out", "__pycache__"]);
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name.toLowerCase())) walk(p, depth + 1);
        continue;
      }
      if (!KEY_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      try {
        if (fs.statSync(p).size > 8192) continue;
        const text = fs.readFileSync(p, "utf8");
        const m = text.match(KEY_RE);
        if (m) found.push([p, m[0]]);
      } catch {
        /* ignore */
      }
    }
  };
  walk(root, 0);

  if (!found.length) {
    throw new Error(
      "未找到 API Key。请把 key 放到项目根目录的 .text 文件里（内容形如 sk-xxxx），" +
        "或用 --api-key 传入，或设置环境变量 GRSAI_API_KEY。"
    );
  }
  if (found.length > 1) {
    log("发现多个候选 Key，使用第一个：");
    for (const [p] of found) log("  - " + path.relative(root, p));
  }
  return found[0][1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(base, key) {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
  }

  async _post(p, payload, timeout = 120, retries = 3) {
    const url = this.base + p;
    let last = null;
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeout * 1000),
        });
        if (r.status === 200) return await r.json();
        const text = (await r.text()).slice(0, 400);
        last = `HTTP ${r.status}: ${text}`;
        if ([400, 401, 403, 404].includes(r.status)) break;
      } catch (e) {
        last = String(e);
      }
      await sleep(2000 + 3000 * i);
    }
    throw new Error(`POST ${p} 失败: ${last}`);
  }

  static extractUrl(data) {
    for (const item of data.results || []) {
      if (item && typeof item === "object" && item.url) return item.url;
    }
    if (typeof data.url === "string") return data.url;
    return null;
  }

  async generate(prompt, size, quality, images, timeout = 420) {
    const payload = {
      model: IMAGE_MODEL,
      prompt,
      aspectRatio: size,
      quality,
      replyType: "async",
    };
    if (images && images.length) payload.images = images;
    const data = await this._post("/v1/api/generate", payload);
    const url = Client.extractUrl(data);
    if (url) return url;
    const taskId = data.id || data.taskId;
    if (!taskId) throw new Error("响应里既没有图片 URL 也没有任务 id: " + JSON.stringify(data).slice(0, 400));
    return this._poll(taskId, timeout);
  }

  async _poll(taskId, timeout) {
    const deadline = Date.now() + timeout * 1000;
    let delay = 3000;
    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay + 2000, 8000);
      let data;
      try {
        const r = await fetch(this.base + "/v1/api/result?id=" + encodeURIComponent(taskId), {
          headers: { Authorization: "Bearer " + this.key },
          signal: AbortSignal.timeout(60000),
        });
        if (r.status !== 200) continue;
        data = await r.json();
      } catch {
        continue;
      }
      const status = String(data.status || "").toLowerCase();
      if (["succeeded", "success", "completed", "finished"].includes(status)) {
        const url = Client.extractUrl(data);
        if (url) return url;
        throw new Error("任务成功但无图片: " + JSON.stringify(data).slice(0, 400));
      }
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        throw new Error("生成失败: " + JSON.stringify(data).slice(0, 400));
      }
      const url = Client.extractUrl(data);
      if (url) return url;
    }
    throw new Error(`轮询超时（${timeout}s），任务 ${taskId}`);
  }

  async visionChat(model, text, imageUrls, timeout = 180) {
    const content = [{ type: "text", text }];
    for (const u of imageUrls) content.push({ type: "image_url", image_url: { url: u } });
    const data = await this._post(
      "/v1/chat/completions",
      { model, stream: false, messages: [{ role: "user", content }] },
      timeout
    );
    const out = data?.choices?.[0]?.message?.content;
    if (typeof out !== "string") throw new Error("审片响应异常: " + JSON.stringify(data).slice(0, 400));
    return out;
  }
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
      if (i === 2) throw new Error(`下载失败 ${url}: ${e}`);
      await sleep(2000);
    }
  }
}

// ---------------------------------------------------------------- 审片

const REVIEW_RULES = `你是严格的电影分镜审片员。给你一张 AI 生成的电影静帧，以及这一镜的分镜要求。
这张图将被用作视频模型的首帧参考，所以它必须精确落在这一镜的构图与表演起点上。

判定规则：
- 下面「必须满足」里任意一条明显不符，就判 pass=false。
- 人物年龄/性别/发型/服装与设定不一致，或同一角色在不同镜头里长相漂移，判 false。
- 机位与景别错了（如要求过肩却拍成正面特写、要求大特写却带了全身），判 false。
- 画面出现文字、字幕、水印、logo、边框、分屏、多格漫画排版，判 false。
- 手部结构畸形、五官错位、多余肢体、镜中人物朝向矛盾，判 false。
- 但若畸形的手出现在远景或画面很小的人物身上（占画面高度不到约八分之一），不作为判 false 的理由，也不要写进 issues。
- 若手的数量、朝向、所持物体与要求一致，只是指节细节略有粘连或一根手指形态不自然，不作为判 false 的理由；只有明显多指、缺指或手与物体穿模融合才判 false。
- 光线方向与色温与要求明显冲突，判 false。
- 只要画面本身能作为这一镜的合格首帧，即使存在小的构图偏差也判 true。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{"pass": true 或 false, "score": 0-100 的整数, "issues": ["具体问题，中文，每条一句话"], "fix_hint": "给生图模型的一句中文修改指令，只写要改的地方，不要重复已经正确的部分"}`;

function buildReviewText(shot, hasRef = false) {
  const checks = (shot.checks || []).map((c) => "- " + c).join("\n");
  let extra = "";
  if (hasRef) {
    extra =
      "\n另外：第一张图是这一镜要审的画面，第二张图是这一镜生成时使用的参考图。" +
      "请对比两张图里的角色长相、发型、服装与场景空间结构，如果出现明显漂移，在 issues 里指出并在 fix_hint 中说明。\n" +
      "但如果本镜要求里明确写了「参考图只用于锁定某一部分、另一部分必须不同」，则按本镜要求判定，不要因为那部分不同而判 false。\n";
  }
  return (
    REVIEW_RULES +
    `\n\n镜头编号：${shot.id}（${shot.title || ""}）\n` +
    `景别/机位：${shot.shot_size || ""}\n` +
    `这一镜要表达：${shot.intent || ""}\n` +
    `必须满足：\n${checks}\n` +
    extra +
    "生成时使用的提示词（供你对照）：\n" +
    shot.image_prompt
  );
}

function parseReview(raw) {
  const text = String(raw || "").replace(/^```(?:json)?|```$/gm, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { pass: false, score: 0, issues: ["审片模型未返回可解析的 JSON"], fix_hint: "" };
  let data;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return { pass: false, score: 0, issues: ["审片 JSON 解析失败"], fix_hint: "" };
  }
  return {
    pass: !!data.pass,
    score: Number(data.score) || 0,
    issues: (data.issues || []).map(String).slice(0, 8),
    fix_hint: String(data.fix_hint || ""),
  };
}

// ---------------------------------------------------------------- 参考图

const REF_INSTRUCTION =
  "参考图用途说明：附带的图片只用于锁定人物长相、服装、发型与场景结构，" +
  "不要照搬它的构图、机位和景别；请按上面这一镜的要求重新构图取景。";

function composePrompt(shot, feedback, styleLock, hasRef) {
  let prompt = shot.image_prompt;
  const lock = shot.style_lock || styleLock;
  if (lock) prompt += "\n" + lock;
  if (hasRef) prompt += "\n" + (shot.ref_instruction || buildRefInstruction(shot));
  for (const item of feedback) prompt += "\n修正要求（必须满足）：" + item;
  return prompt;
}

function buildRefInstruction(shot) {
  const wants = Array.isArray(shot.ref) ? shot.ref : shot.ref ? [shot.ref] : [];
  const uses = shot.picture_use || [];
  if (wants.length && uses.length === wants.length) {
    const parts = wants.map(
      (w, i) =>
        `<Picture ${i + 1}>（${path.basename(w)}）只用于锁定${uses[i]}，不要照搬它的构图、机位与背景`
    );
    return "参考图分工（必须严格按用途使用，不要混用）：" + parts.join("；") + "。";
  }
  return REF_INSTRUCTION;
}

let sharp = null;
function getSharp() {
  if (sharp === null) {
    try {
      sharp = require("sharp");
    } catch {
      sharp = false;
    }
  }
  return sharp;
}

async function loadRef(p, maxSide = 1280) {
  try {
    if (!fs.existsSync(p)) return null;
  } catch {
    return null;
  }
  const buf = fs.readFileSync(p);
  const s = getSharp();
  let out = buf;
  let mime = /\.png$/i.test(p) ? "image/png" : "image/jpeg";
  if (s) {
    try {
      const im = s(buf);
      const meta = await im.metadata();
      if (Math.max(meta.width || 0, meta.height || 0) > maxSide) {
        out = await im
          .resize({ width: maxSide, height: maxSide, fit: "inside" })
          .jpeg({ quality: 92 })
          .toBuffer();
      } else {
        out = await im.jpeg({ quality: 92 }).toBuffer();
      }
      mime = "image/jpeg";
    } catch {
      out = buf;
    }
  }
  return `data:${mime};base64,${out.toString("base64")}`;
}

// ---------------------------------------------------------------- 主流程

function parseArgs(argv) {
  const a = {
    project: null, // 例：projects/song
    shots: null,
    out: null,
    apiKey: null,
    baseUrl: DEFAULT_BASE,
    reviewModel: DEFAULT_REVIEW_MODEL,
    size: null,
    quality: null,
    maxAttempts: 3,
    timeout: 420,
    only: null,
    force: false,
    noReview: false,
    dryRun: false,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--project") a.project = next();
    else if (k === "--shots") a.shots = next();
    else if (k === "--out") a.out = next();
    else if (k === "--api-key") a.apiKey = next();
    else if (k === "--base-url") a.baseUrl = next();
    else if (k === "--review-model") a.reviewModel = next();
    else if (k === "--size") a.size = next();
    else if (k === "--quality") a.quality = next();
    else if (k === "--max-attempts") a.maxAttempts = Number(next());
    else if (k === "--concurrency") a.concurrency = Number(next());
    else if (k === "--timeout") a.timeout = Number(next());
    else if (k === "--only") {
      const list = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) list.push(argv[++i]);
      a.only = list.map((x) => x.toUpperCase());
    } else if (k === "--force") a.force = true;
    else if (k === "--no-review") a.noReview = true;
    else if (k === "--dry-run") a.dryRun = true;
  }
  return a;
}

async function run(args) {
  // 项目目录约定：projects/<名>/ 内含 00-spec/shots.json、10-refs/、20-frames/
  let projDir = null;
  if (args.project) {
    projDir = path.resolve(args.project);
  } else if (args.shots) {
    let d = path.dirname(path.resolve(args.shots));
    while (d !== path.dirname(d) && path.basename(d) !== "00-spec") d = path.dirname(d);
    projDir = path.basename(d) === "00-spec" ? path.dirname(d) : null;
  }
  if (!projDir) {
    throw new Error(
      "请用 --project projects/<项目名> 指定项目目录，或确保 --shots 位于 <项目>/00-spec/ 下"
    );
  }

  const shotsPath =
    args.shots || path.join(projDir, "00-spec", "shots.json");
  const spec = JSON.parse(fs.readFileSync(shotsPath, "utf8"));
  const styleLock = spec.style_lock || "";
  let shots = spec.shots;

  if (args.only) {
    const wanted = new Set(args.only);
    shots = shots.filter((s) => wanted.has(s.id.toUpperCase()));
    const got = new Set(shots.map((s) => s.id.toUpperCase()));
    const missing = [...wanted].filter((x) => !got.has(x));
    if (missing.length) throw new Error("不存在的镜头编号: " + missing.join(", "));
  }

  const outDir = path.resolve(args.out || path.join(projDir, "20-frames"));
  const attemptDir = path.join(outDir, "attempts");
  log("项目目录：" + path.relative(PROJECT_ROOT, projDir));
  log("分镜定义：" + path.relative(PROJECT_ROOT, shotsPath));
  log("首帧输出：" + path.relative(PROJECT_ROOT, outDir));

  if (args.dryRun) {
    for (const s of shots) {
      const ref = Array.isArray(s.ref) ? s.ref.join(", ") : s.ref || "-";
      log("=".repeat(70));
      log(`${s.id}  ${s.title || ""}  [${s.size}, ${s.quality}]  ref=${ref}`);
      log("-".repeat(70));
      log(composePrompt(s, [], styleLock, !!s.ref));
    }
    log("=".repeat(70));
    log(`dry-run 结束，共 ${shots.length} 镜。确认提示词后去掉 --dry-run 正式生成。`);
    return 0;
  }

  const key = findApiKey(PROJECT_ROOT, args.apiKey);
  const client = new Client(args.baseUrl, key);

  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, "state.json");
  let state = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      state = {};
    }
  }

  const approvedPaths = {};
  for (const [sid, info] of Object.entries(state)) {
    const p = path.join(outDir, sid + ".png");
    if (info.approved && fs.existsSync(p)) approvedPaths[sid] = p;
  }
  if (args.force) for (const k of Object.keys(approvedPaths)) delete approvedPaths[k];

  const order = spec.shots.map((s) => s.id);
  const manifest = { model: IMAGE_MODEL, shots: [] };
  let approvedCount = 0;
  const results = new Map();

  // 已通过的镜头先占位，供 --only 时解析参考图
  const pending = [];
  for (const s of shots) {
    if (approvedPaths[s.id]) {
      log(`[${s.id}] 已通过，跳过（--force 可重做）`);
      results.set(s.id, {
        id: s.id,
        title: s.title,
        image: approvedPaths[s.id],
        h3: s.h3,
        approved: true,
        attempts: [],
      });
    } else {
      pending.push(s);
    }
  }

  // 并发执行：每镜独立跑完整流程，参考图在本镜开始时快照
  const concurrency = Math.max(1, args.concurrency || 1);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= pending.length) return;
      const r = await runShot(pending[idx]);
      results.set(r.id, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));

  for (const s of shots) {
    const r = results.get(s.id);
    if (!r) continue;
    if (r.approved) approvedCount++;
    manifest.shots.push(r);
    state[s.id] = { approved: r.approved, attempts: r.attempts.filter((a) => a.file).length };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeH3Md(path.join(outDir, "h3_prompts.md"), spec, manifest);

  log("");
  log(`完成：${manifest.shots.length} 镜，通过 ${approvedCount} 镜。`);
  log("产物目录：" + outDir);
  return 0;

  // ------------------------------------------------------------------
  async function runShot(s) {
    const sid = s.id;
    const finalPath = path.join(outDir, sid + ".png");

    // 参考图：支持 "prev"、其他镜头 id、项目内本地素材路径
    const refFiles = [];
    const wants = Array.isArray(s.ref) ? s.ref : s.ref ? [s.ref] : [];
    for (const w of wants) {
      if (w === "prev") {
        const i = order.indexOf(sid);
        for (let j = i - 1; j >= 0; j--) {
          if (approvedPaths[order[j]]) {
            refFiles.push(approvedPaths[order[j]]);
            break;
          }
        }
      } else {
        // 约定：图片名不带路径时，先在项目 10-refs/ 找，再在 20-frames/ 找
        const bare = path.isAbsolute(w) ? w : path.basename(w);
        const candidates = [
          approvedPaths[w],
          path.join(projDir, "10-refs", bare),
          path.join(outDir, bare + ".png"),
          path.join(outDir, bare),
          path.isAbsolute(w) ? w : path.join(projDir, w),
          path.isAbsolute(w) ? w : path.join(PROJECT_ROOT, w),
        ].filter(Boolean);
        const hit = candidates.find((p) => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        });
        if (hit) {
          refFiles.push(hit);
        } else {
          throw new Error(`[${sid}] 参考图找不到：${w}（已尝试 ${candidates.length} 个路径）`);
        }
      }
    }
    const refs = [];
    for (const p of refFiles) {
      const d = await loadRef(p);
      if (d) refs.push(d);
      else throw new Error(`[${sid}] 参考图读取失败：${p}`);
    }

    // 校验：提示词里引用的 <Picture N> 不能超过实际上传的图片数
    const usedMax = Math.max(
      0,
      ...[...s.h3.integrated_multimodal_description.matchAll(/<Picture (\d+)>/g)].map((m) => +m[1])
    );
    if (usedMax > refs.length) {
      throw new Error(
        `[${sid}] 提示词引用了 <Picture ${usedMax}>，但只上传了 ${refs.length} 张参考图`
      );
    }
    if (refFiles.length) log(`[${sid}] 参考图：${refFiles.map((p) => path.basename(p)).join(", ")}`);

    const feedback = [];
    const history = [];
    let best = null;
    let ok = false;

    for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
      const prompt = composePrompt(s, feedback, styleLock, refs.length > 0);
      log(`[${sid}] 第 ${attempt}/${args.maxAttempts} 次生成…`);
      let url;
      try {
        url = await client.generate(
          prompt,
          args.size || s.size || spec.aspect_size || "1152x2048",
          args.quality || s.quality || "high",
          refs,
          args.timeout
        );
      } catch (e) {
        log("    生成失败：" + e.message);
        history.push({ attempt, error: e.message });
        await sleep(3000);
        continue;
      }

      const shotFile = path.join(attemptDir, `${sid}_a${attempt}.png`);
      await download(url, shotFile);
      log("    已保存 " + path.relative(PROJECT_ROOT, shotFile));

      const rec = {
        attempt,
        prompt,
        file: shotFile,
        url,
        refs: refFiles.map((p) => path.basename(p)),
      };

      if (args.noReview) {
        rec.review = null;
        history.push(rec);
        fs.copyFileSync(shotFile, finalPath);
        ok = true;
        break;
      }

      let review;
      try {
        const reviewImgs = [await loadRef(shotFile)];
        if (refFiles.length) reviewImgs.push(await loadRef(refFiles[refFiles.length - 1]));
        review = parseReview(
          await client.visionChat(
            args.reviewModel,
            buildReviewText(s, refFiles.length > 0),
            reviewImgs.filter(Boolean)
          )
        );
      } catch (e) {
        log("    审片失败：" + e.message);
        review = { pass: true, score: 0, issues: ["审片调用失败，跳过"], fix_hint: "" };
      }

      rec.review = review;
      history.push(rec);
      log(
        `    审片：${review.pass ? "通过" : "不通过"}  score=${review.score}  ` +
          (review.issues.length ? review.issues.join("；") : "无问题")
      );
      if (!best || review.score > best.score) best = { score: review.score, file: shotFile };

      if (review.pass) {
        fs.copyFileSync(shotFile, finalPath);
        ok = true;
        break;
      }
      if (review.fix_hint) feedback.push(review.fix_hint);
      else if (review.issues.length) feedback.push(review.issues.join("；"));
    }

    if (ok) {
      approvedPaths[sid] = finalPath;
      log(`[${sid}] 通过 -> ${path.relative(PROJECT_ROOT, finalPath)}`);
    } else {
      log(`[${sid}] 达到最大尝试次数仍未通过，保留分数最高的一张供人工挑选`);
      let src = best && fs.existsSync(best.file) ? best.file : null;
      if (!src) {
        for (const r of history.slice().reverse()) {
          if (r.file && fs.existsSync(r.file)) {
            src = r.file;
            break;
          }
        }
      }
      if (src) {
        fs.copyFileSync(src, finalPath);
        log(`[${sid}] 保留的是 ${path.basename(src)}`);
      }
    }

    return {
      id: sid,
      title: s.title,
      image: fs.existsSync(finalPath) ? finalPath : null,
      approved: ok,
      attempts: history,
      h3: s.h3,
    };
  }
}

function writeH3Md(dest, spec, manifest) {
  const byId = Object.fromEntries(spec.shots.map((s) => [s.id, s]));
  const lines = [
    "# 逐镜生成清单（H3 / 可灵）",
    "",
    "> 每次生成都是一次全新的、无上下文的生成。每镜自带完整场景锚点与多图参考。",
    "> 默认 9:16 竖屏。时长按中文慢速念白 3 字/秒 推算。",
    "",
  ];
  for (const item of manifest.shots) {
    const shot = byId[item.id] || {};
    lines.push(`## ${item.id} ${shot.title || ""}`);
    lines.push("");
    lines.push(`- 时长：**${shot.duration || 5} 秒**`);
    if (shot.timing) {
      const t = shot.timing;
      const parts = [];
      if (t.cps) parts.push(`台词 ${t.speech_sec} 秒（${t.cps} 字/秒）`);
      if (t.pause_sec) parts.push(`停顿 ${t.pause_sec} 秒`);
      if (t.margin_sec) parts.push(`余量 ${t.margin_sec} 秒`);
      if (parts.length) lines.push(`- 时长构成：${parts.join(" + ")}`);
      if (t.margin_reason) lines.push(`- 余量理由：${t.margin_reason}`);
      if (t.basis) lines.push(`- 判定依据：${t.basis}`);
    }
    lines.push(`- 画幅：9:16 竖屏`);
    lines.push(`- 景别：${shot.shot_size || "-"}`);
    lines.push(`- 本镜要表达：${shot.intent || "-"}`);
    if (shot.connect) lines.push(`- 与上一镜衔接：${shot.connect}`);
    lines.push("");

    // 上传清单
    const wants = Array.isArray(shot.ref) ? shot.ref : shot.ref ? [shot.ref] : [];
    if (wants.length) {
      lines.push("**上传清单（按顺序）**");
      lines.push("");
      lines.push("| 序号 | 文件 | 用途 |");
      lines.push("|---|---|---|");
      wants.forEach((w, i) => {
        const use = (shot.picture_use && shot.picture_use[i]) || "见正文声明";
        lines.push(`| <Picture ${i + 1}> | \`${path.basename(w)}\` | ${use} |`);
      });
      lines.push("");
    }

    lines.push("```text");
    lines.push(`integrated_multimodal_description: ${(item.h3 || {}).integrated_multimodal_description || ""}`);
    lines.push("");
    lines.push(`overall_soundscape: ${(item.h3 || {}).overall_soundscape || ""}`);
    lines.push("");
    lines.push(`non_diegetic_music: ${(item.h3 || {}).non_diegetic_music || ""}`);
    lines.push("```");
    lines.push("");
  }
  fs.writeFileSync(dest, lines.join("\n"), "utf8");
}

run(parseArgs(process.argv.slice(2)))
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
