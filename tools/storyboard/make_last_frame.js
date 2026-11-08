#!/usr/bin/env node
/**
 * 从首帧生成尾帧（打戏/动作镜专用）。
 *
 * 核心原则：尾帧必须以首帧为底图「改」出来，而不是独立生成。
 * 独立生成会导致机位、背景、光位、人物比例全部变化，模型找不到插值路径，
 * 只会把画面形变——这就是「首尾帧衔接不起来」的根本原因。
 *
 * 用法:
 *   node make_last_frame.js --project projects/song --shot S10 \
 *     --change "右手抬到肩高，重心移到后脚"
 *
 * 产物:
 *   projects/<项目>/10-refs/last-<shotid>.png
 *   生成后会立刻跑配对检查，不合格会打印原因。
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
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
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
      } catch { /* ignore */ }
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
    } catch (e) { last = String(e); }
    await sleep(2000 + 3000 * i);
  }
  throw new Error(`POST ${p} 失败: ${last}`);
}

function extractUrl(d) {
  for (const it of d.results || []) if (it && it.url) return it.url;
  if (typeof d.url === "string") return d.url;
  return null;
}

async function generate(base, key, prompt, size, images) {
  const payload = {
    model: IMAGE_MODEL,
    prompt,
    aspectRatio: size,
    quality: "high",
    replyType: "async",
  };
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
    } catch { continue; }
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
 * 视觉复核：像素指标只能判断「稳不稳」，判断不了「动作对不对」。
 * 首尾帧最常见的失败不是差异太大，而是差异全是披风火焰在动、人物姿态根本没变。
 * 这一步直接问视觉模型：要求的那种姿态改变，画面里到底出现了没有。
 */
const MOTION_CHECK_MODEL = "gemini-3.1-pro";

async function verifyMotion(base, key, firstFrame, lastFrame, change) {
  const text =
    "你是一位严格的动画监督。第一张图是一个镜头的首帧，第二张图是同一个镜头的尾帧。\n" +
    "这两帧之间，人物应当完成下面这个姿态变化：\n" +
    `「${change}」\n\n` +
    "请判断：第二张图里，人物的姿态是否**真的变成了**上面描述的样子？\n\n" +
    "判定时请注意区分：\n" +
    "- 披风飘动、火焰跳动、衣角、光斑、胶片颗粒的变化，**不算姿态改变**。\n" +
    "- 只有头、肩、躯干、四肢、重心、视线方向、身体朝向发生了可辨认的改变，才算。\n" +
    "- 如果只是「稍微动了一点」，没有达到描述里那个明确的姿态，判 changed=false。\n\n" +
    "关于元素漂移（drift），判定标准很严格，不要误报：\n" +
    "- 同一个部件因为**视角改变**而露出原本被挡住的部分（例如从背面转到侧面后看到了头盔侧面的装饰、\n" +
    "  看到了原本被肩膀挡住的肩甲），这是**正确的透视**，不是漂移，不要报 drift。\n" +
    "- 只有部件**被添加、被删除、被替换成别的东西**，或者形状/数量明显改变，才算 drift。\n" +
    "- 例如：头盔本来有翼形装饰，转过来后仍能看到同样的翼 → 不算漂移；\n" +
    "  头盔本来有马尾，转过来后马尾消失 → 算漂移。\n\n" +
    "只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：\n" +
    '{"changed": true 或 false, "achieved": "实际达到的姿态，一句话", "missing": ["没做到的改变，中文，逐条"], "drift": true 或 false, "drift_detail": "具体哪个部位变了", "issues": ["其它问题"]}';

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
            { type: "image_url", image_url: { url: await dataUrl(firstFrame) } },
            { type: "image_url", image_url: { url: await dataUrl(lastFrame) } },
          ],
        },
      ],
    },
    240
  );
  const raw = d?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new Error("视觉复核响应异常");
  const body = raw.replace(/^```(?:json)?|```$/gm, "").trim();
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("视觉复核返回的不是 JSON：" + body.slice(0, 200));
  }
}

let sharp = null;
async function dataUrl(p, maxSide = 1280) {
  if (!sharp) sharp = require("sharp");
  const buf = fs.readFileSync(p);
  const meta = await sharp(buf).metadata();
  let out = buf;
  if (Math.max(meta.width, meta.height) > maxSide) {
    out = await sharp(buf)
      .resize({ width: maxSide, height: maxSide, fit: "inside" })
      .jpeg({ quality: 92 })
      .toBuffer();
  } else {
    out = await sharp(buf).jpeg({ quality: 92 }).toBuffer();
  }
  return "data:image/jpeg;base64," + out.toString("base64");
}

/**
 * 转身方向自洽校验（复用 lint_shots.js 的同一份判定，避免两处规则漂移）。
 * 「看到哪一侧脸颊」与「鼻尖朝画面哪一侧」在相机位于人物背后时必定相反，
 * 写成同向就物理不可能实现，模型只会随机转一个方向，然后被判"转反了"。
 */
function checkTurnConsistency(change) {
  const { checkTurn } = require("./lint_shots.js");
  return checkTurn(String(change)).map(([, msg]) => msg);
}

/** 尾帧提示词：强调「只改动作，一切不动」 */
function buildLastFramePrompt(change, keep, hasRefs) {
  const refBlock = hasRefs
    ? "【关于附带的参考图】\n" +
      "除第一张底图外，还附带了角色与场景的参考图。当动作转到原底图看不到的部位（例如从背面转到侧脸、正脸）时，**必须严格按照参考图里这个人物的长相、头饰、发型、甲胄形制来绘制**，不能凭空发挥，也不能省略头盔、冠、发带等任何头饰。\n\n"
    : "【关于看不到的部位】\n" +
      "当动作转到原底图看不到的部位时，**保持原底图中已有的头饰、发型、甲胄不变**，不要摘掉头盔或改变头饰，不要凭空发明原图中没有的细节。\n\n";

  return (
    "这是一张已经拍好的画面。请**在完全保留原图场景的前提下**，把人物替换成同一动作结束时的姿态，生成这一镜的最后一帧。\n\n" +
    "【必须完全不变的部分】\n" +
    `- ${keep}\n` +
    "- 画面构图、取景范围、画幅比例与边缘裁切位置\n" +
    "- 背景的一切细节：材质、位置、形状、数量、远近关系\n" +
    "- 光位与光强：主光方向、色温、明暗对比、投影方向与长度\n" +
    "- 人物服装、甲胄、配饰、发型、**头饰（头盔必须还在头上，不允许摘下或消失）**、面部特征\n" +
    "- 整体曝光与色调\n\n" +
    "【这一帧的最终姿态——必须明确画成这个样子】\n" +
    `${change}\n\n` +
    "注意：不是「稍微转一点」，而是要清楚地画出上面描述的最终姿态，让观众一眼能看出和起始帧是不同的姿势。\n\n" +
    refBlock +
    "【硬性要求】\n" +
    "- 除人物姿态外，任何像素都不应位移或缩放；画面边缘必须与原图逐像素对齐\n" +
    "- 人物的身高、体量、与镜头的距离感保持不变，不允许放大或缩小\n" +
    "- 不要重新设计场景，不要更换机位，不要改变光线\n" +
    "- 画面内不得出现任何文字、水印、分镜边框"
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

  const projArg = get("--project");
  const shotId = get("--shot");
  const change = get("--change");
  const keep = get("--keep") || "人物在画面中的位置与所占画面的比例、人物与周围道具的相对关系";
  const refArgs = get("--refs") ? get("--refs").split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (!projArg || !shotId || !change) {
    console.error(
      "用法: node make_last_frame.js --project projects/song --shot S10 \\\n" +
        '        --change "右手抬到肩高，重心移到后脚" \\\n' +
        '        [--keep "人物位置与比例不变"] \\\n' +
        '        [--refs "char-veteran.png,char-veteran-head.png"]'
    );
    process.exit(1);
  }

  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const framesDir = path.join(projDir, "20-frames");
  const refsDir = path.join(projDir, "10-refs");
  const firstFrame = path.join(framesDir, shotId + ".png");
  if (!fs.existsSync(firstFrame)) {
    throw new Error("找不到首帧：" + path.relative(PROJECT_ROOT, firstFrame));
  }

  const dest = path.join(refsDir, "last-" + shotId + ".png");

  // 生成前先检查转身方向是否自相矛盾——这一步能省掉一整轮废图
  const turnWarns = checkTurnConsistency(change);
  if (turnWarns.length) {
    log("⚠ 转身方向可能不自洽：");
    for (const w of turnWarns) log("  · " + w);
    log("  （相机在人物背后时，可见脸颊与鼻尖朝向必定相反）");
    log("");
  }

  // 解析角色/场景参考图
  const refPaths = [];
  for (const r of refArgs) {
    const cands = [
      path.isAbsolute(r) ? r : path.join(refsDir, r),
      path.isAbsolute(r) ? r : path.join(refsDir, "bare", r),
    ];
    const hit = cands.find((c) => fs.existsSync(c));
    if (!hit) throw new Error("找不到参考图：" + r);
    refPaths.push(hit);
  }

  const prompt = buildLastFramePrompt(change, keep, refPaths.length > 0);

  log("首帧：" + path.relative(PROJECT_ROOT, firstFrame));
  log("尾帧将保存到：" + path.relative(PROJECT_ROOT, dest));
  if (refPaths.length) {
    log("附带参考图：");
    for (const p of refPaths) log("  · " + path.relative(PROJECT_ROOT, p));
  }
  log("");
  log("提示词：");
  log(prompt);
  log("");

  const key = findApiKey(PROJECT_ROOT);
  log("生成尾帧（以首帧为底图）…");
  const imgs = [await dataUrl(firstFrame)];
  for (const p of refPaths) imgs.push(await dataUrl(p));
  const url = await generate(DEFAULT_BASE, key, prompt, "1152x2048", imgs);
  await download(url, dest);
  log("已保存 " + path.relative(PROJECT_ROOT, dest));

  // 立刻做配对检查
  log("");
  log("配对检查（像素级：稳不稳）：");
  const { checkPair } = require("./pair_check.js");
  const r = await checkPair(firstFrame, dest);
  log(`  评分 ${r.score}/100 → ${r.verdict}`);
  log(`  边框变化 ${r.metrics.borderChange}%  全画面变化 ${r.metrics.totalChange}%  实质变化 ${r.metrics.motionRatio}%`);
  if (r.issues.length) {
    log("  问题：");
    for (const it of r.issues) log("    · " + it);
  }

  // 视觉复核：动作到底有没有发生
  log("");
  log("动作复核（视觉级：对不对）：");
  let mv = null;
  try {
    mv = await verifyMotion(DEFAULT_BASE, key, firstFrame, dest, change);
    log("  实际达到：" + (mv.achieved || "—"));
    log("  姿态已改变：" + (mv.changed ? "是" : "否"));
    if (mv.drift) log("  元素漂移：是 —— " + (mv.drift_detail || ""));
    if (Array.isArray(mv.missing) && mv.missing.length) {
      log("  没做到的改变：");
      for (const it of mv.missing) log("    · " + it);
    }
    if (Array.isArray(mv.issues) && mv.issues.length) {
      log("  其它问题：");
      for (const it of mv.issues) log("    · " + it);
    }
  } catch (e) {
    log("  复核失败：" + e.message + "（跳过，请自行确认姿态）");
  }

  log("");
  const stable = r.score >= 80;
  const moved = mv ? mv.changed === true : null;
  const clean = mv ? mv.drift !== true : true;

  if (stable && moved && clean) {
    log("可用。在 shots.json 里把这一镜加上：");
    log(`  "last_frame": "last-${shotId}.png"`);
  } else if (stable && moved === false) {
    log("不可用：画面很稳，但要求的姿态没有出现（尾帧≈首帧），视频会变成静止画面。");
    log("改法：把 --change 写得更具体到可见的形体（哪块骨头转到哪、视线落在哪），");
    log("或换一个「动作终点姿态本身就在底图里可见」的角度。");
  } else if (moved && clean === false) {
    log("不可用：姿态改了，但人物元素漂移（头饰/甲胄/发型改变），视频里会出现跳变。");
    log("改法：补 --refs 传角色定妆照与头部特写，并在 --keep 里显式点名头饰必须保留。");
  } else if (stable && moved === null) {
    log("像素检查通过，但动作未复核。请人工确认姿态是否到位再使用。");
  } else {
    log("不可用：两帧不够稳，模型会靠形变交差。");
    log("建议：确认尾帧是从首帧改出来的，或缩小动作幅度、拆成两镜。");
  }
}

module.exports = { verifyMotion, buildLastFramePrompt, checkTurnConsistency };

if (require.main === module) {
  main().catch((e) => {
    console.error("错误：" + e.message);
    process.exit(1);
  });
}
