#!/usr/bin/env node
/**
 * 生成可点击预览的 H3 提示词文档。
 *
 * 与 generate.js 内置的 writeH3Md 的区别：
 *   - 图片用 Markdown 相对链接，在编辑器里点一下就能打开预览
 *   - 每镜列出 beats 分镜帧与时间戳，直接对应 H3 的 <Picture N> 顺序
 *   - 上传清单按顺序编号，照着传不会错
 *
 * 用法:
 *   node make_prompt_doc.js --project projects/打戏
 * 产物:
 *   <项目>/h3_prompts.md
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

function rel(fromDir, file) {
  return path.relative(fromDir, file).split(path.sep).join("/");
}

function buildDoc(projDir) {
  const spec = JSON.parse(fs.readFileSync(path.join(projDir, "00-spec", "shots.json"), "utf8"));
  const outDir = path.join(projDir, "20-frames");
  const beatDir = path.join(outDir, "beats");
  const docDir = projDir;

  const L = [];
  L.push(`# ${spec.story?.title || spec.slug || "分镜"} — H3 逐镜生成清单`);
  L.push("");
  L.push(`> 竖屏 9:16（1152×2048）。每次生成都是**全新、无上下文**的，每镜自带完整场景锚点与多图参考。`);
  L.push(`> **图点一下就能预览**：下面每个文件名都是可点击的链接。`);
  L.push("");

  // 总览表
  L.push("## 总览");
  L.push("");
  L.push("| 镜 | 时长 | 分镜帧 | 内容 | 预览 |");
  L.push("|---|---|---|---|---|");
  let total = 0;
  for (const s of spec.shots) {
    total += s.duration || 0;
    const main = path.join(outDir, s.id + ".png");
    const has = fs.existsSync(main);
    const beats = (s.beats || []).length;
    L.push(
      `| ${s.id} | ${s.duration}s | ${beats} 帧 | ${s.title || ""} | ${
        has ? `[看]( ${rel(docDir, main)} )` : "_未生成_"
      } |`
    );
  }
  L.push(`| **合计** | **${total}s** | | | |`);
  L.push("");

  // 逐镜
  for (const s of spec.shots) {
    L.push("---");
    L.push("");
    L.push(`## ${s.id} ${s.title || ""}`);
    L.push("");
    L.push(`- **时长**：${s.duration} 秒`);
    L.push(`- **景别/机位**：${s.shot_size || "-"}`);
    L.push(`- **本镜要表达**：${s.intent || "-"}`);
    if (s.connect) L.push(`- **与上一镜衔接**：${s.connect}`);
    if (s.timing?.basis) L.push(`- **时长依据**：${s.timing.basis}`);
    L.push("");

    // 分镜帧时间轴
    const beats = s.beats || [];
    if (beats.length) {
      L.push(`### 分镜帧（共 ${beats.length} 帧，按时间排列）`);
      L.push("");
      L.push("| 时间 | 内容 | 帧 | 预览 |");
      L.push("|---|---|---|---|");
      beats.forEach((b, i) => {
        const f = path.join(beatDir, `${s.id}_b${i + 1}.png`);
        const ok = fs.existsSync(f);
        L.push(
          `| ${Number(b.t).toFixed(1)}s | ${b.name || ""} | \`${s.id}_b${i + 1}.png\` | ${
            ok ? `[看]( ${rel(docDir, f)} )` : "_未生成_"
          } |`
        );
      });
      L.push("");
    }

    // 上传清单：参考图在前，分镜帧在后
    L.push("### 上传清单（按此顺序，不能乱）");
    L.push("");
    L.push("| 序号 | 文件 | 用途 | 预览 |");
    L.push("|---|---|---|---|");
    let idx = 0;
    const refs = Array.isArray(s.ref) ? s.ref : s.ref ? [s.ref] : [];
    const uses = s.picture_use || [];
    const findRef = (name) => {
      const bare = path.basename(name);
      for (const c of [
        path.join(projDir, "10-refs", bare),
        path.join(outDir, bare.endsWith(".png") ? bare : bare + ".png"),
        path.join(outDir, bare),
      ]) {
        if (fs.existsSync(c)) return c;
      }
      return null;
    };
    refs.forEach((r, i) => {
      idx++;
      const f = findRef(r);
      L.push(
        `| <Picture ${idx}> | \`${r}\` | ${uses[i] || "-"} | ${f ? `[看]( ${rel(docDir, f)} )` : "_缺失_"} |`
      );
    });
    beats.forEach((b, i) => {
      idx++;
      const f = path.join(beatDir, `${s.id}_b${i + 1}.png`);
      L.push(
        `| <Picture ${idx}> | \`${s.id}_b${i + 1}.png\` | 第 ${Number(b.t).toFixed(1)} 秒「${b.name}」这一帧 | ${
          fs.existsSync(f) ? `[看]( ${rel(docDir, f)} )` : "_未生成_"
        } |`
      );
    });
    L.push("");

    // 主帧参考
    const main = path.join(outDir, s.id + ".png");
    if (fs.existsSync(main)) {
      L.push(`**本镜主帧**：[${s.id}.png]( ${rel(docDir, main)} )`);
      L.push("");
      L.push(`![${s.id}](${rel(docDir, main)})`);
      L.push("");
    }

    // 提示词三段
    const h3 = s.h3 || {};
    L.push("### 提示词");
    L.push("");
    L.push("```text");
    if (h3.integrated_multimodal_description) {
      L.push("integrated_multimodal_description:");
      L.push(h3.integrated_multimodal_description);
      L.push("");
    }
    if (h3.overall_soundscape) {
      L.push("overall_soundscape:");
      L.push(h3.overall_soundscape);
      L.push("");
    }
    if (h3.non_diegetic_music) {
      L.push("non_diegetic_music:");
      L.push(h3.non_diegetic_music);
    }
    L.push("```");
    L.push("");
  }

  return L.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const projArg = get("--project");
  if (!projArg) {
    console.error("用法: node make_prompt_doc.js --project projects/打戏");
    process.exit(1);
  }
  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const doc = buildDoc(projDir);
  const dest = path.join(projDir, "h3_prompts.md");
  fs.writeFileSync(dest, doc, "utf8");
  console.log("已生成 " + path.relative(PROJECT_ROOT, dest));
  console.log("在编辑器里打开即可点击预览各帧。");
}

if (require.main === module) main();
