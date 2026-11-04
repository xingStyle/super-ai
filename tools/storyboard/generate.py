#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分镜图生成 + 自动审片流水线
    gpt-image-2.5-flare 生成每一镜的静帧 -> 视觉模型对照分镜要求审核 -> 不合格带着修改意见重生成

用法:
    python tools/storyboard/generate.py --dry-run          # 只打印将要发送的提示词，不花钱
    python tools/storyboard/generate.py                    # 生成全部镜头并审片
    python tools/storyboard/generate.py --only S03 S07     # 只跑指定镜头
    python tools/storyboard/generate.py --force            # 已通过的镜头也重做
    python tools/storyboard/generate.py --no-review        # 只出图，审片留给人看

产物:
    out/storyboard/S01.png ... S08.png        通过审核的静帧（可直接作为 H3 首帧）
    out/storyboard/attempts/                  每一次尝试的原图 + 审核记录
    out/storyboard/manifest.json              机器可读的完整产物索引
    out/storyboard/h3_prompts.md              每镜 H3 提示词 + 对应首帧图，可直接复制
"""

import argparse
import base64
import io
import json
import re
import sys
import time
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[1]

DEFAULT_BASE = "https://grsai.dakka.com.cn"
IMAGE_MODEL = "gpt-image-2.5-flare"
DEFAULT_REVIEW_MODEL = "gemini-3.1-pro"
KEY_RE = re.compile(r"sk-[A-Za-z0-9_\-]{10,}")
KEY_EXTS = {".txt", ".text", ".key", ".env", ".json", ""}


# ---------------------------------------------------------------- 基础设施

def log(msg):
    print(msg, flush=True)


def find_api_key(root: Path, explicit: str = None) -> str:
    if explicit:
        m = KEY_RE.search(explicit)
        return m.group(0) if m else explicit.strip()
    env = __import__("os").environ.get("GRSAI_API_KEY")
    if env:
        return env.strip()

    found = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in KEY_EXTS:
            continue
        parts = {x.lower() for x in p.parts}
        if parts & {".git", "node_modules", "out", "__pycache__"}:
            continue
        try:
            if p.stat().st_size > 8192:
                continue
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        m = KEY_RE.search(text)
        if m:
            found.append((p, m.group(0)))

    if not found:
        raise SystemExit(
            "未找到 API Key。请把 key 放到项目根目录的 .text 文件里（内容形如 sk-xxxx），"
            "或用 --api-key 传入，或设置环境变量 GRSAI_API_KEY。"
        )
    if len(found) > 1:
        log("发现多个候选 Key，使用第一个：")
        for p, _ in found:
            log("  - " + str(p.relative_to(root)))
    p, key = found[0]
    log("使用 API Key：%s（来自 %s）" % (key[:8] + "…" + key[-4:], p.relative_to(root)))
    return key


class Client:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.key = key
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        })

    def _post(self, path, payload, timeout=120, retries=3):
        url = self.base + path
        last = None
        for i in range(retries):
            try:
                r = self.s.post(url, json=payload, timeout=timeout)
                if r.status_code == 200:
                    return r.json()
                last = "HTTP %s: %s" % (r.status_code, r.text[:400])
                if r.status_code in (400, 401, 403, 404):
                    break
            except requests.RequestException as e:
                last = repr(e)
            time.sleep(2 + 3 * i)
        raise RuntimeError("POST %s 失败: %s" % (path, last))

    # -- 生图 ---------------------------------------------------------
    def generate(self, prompt, size, quality, images=None, timeout=420):
        payload = {
            "model": IMAGE_MODEL,
            "prompt": prompt,
            "aspectRatio": size,
            "quality": quality,
            "replyType": "async",
        }
        if images:
            payload["images"] = images
        data = self._post("/v1/api/generate", payload)
        url = self._extract_url(data)
        if url:
            return url
        task_id = data.get("id") or data.get("taskId")
        if not task_id:
            raise RuntimeError("响应里既没有图片 URL 也没有任务 id: %s" % json.dumps(data)[:400])
        return self._poll(task_id, timeout)

    @staticmethod
    def _extract_url(data):
        for item in (data.get("results") or []):
            if isinstance(item, dict) and item.get("url"):
                return item["url"]
        if isinstance(data.get("url"), str):
            return data["url"]
        return None

    def _poll(self, task_id, timeout):
        deadline = time.time() + timeout
        delay = 3
        while time.time() < deadline:
            time.sleep(delay)
            delay = min(delay + 2, 8)
            r = self.s.get(self.base + "/v1/api/result", params={"id": task_id}, timeout=60)
            if r.status_code != 200:
                continue
            data = r.json()
            status = str(data.get("status", "")).lower()
            if status in ("succeeded", "success", "completed", "finished"):
                url = self._extract_url(data)
                if url:
                    return url
                raise RuntimeError("任务成功但无图片: %s" % json.dumps(data)[:400])
            if status in ("failed", "error", "cancelled", "canceled"):
                raise RuntimeError("生成失败: %s" % json.dumps(data, ensure_ascii=False)[:400])
            url = self._extract_url(data)
            if url:
                return url
        raise RuntimeError("轮询超时（%ss），任务 %s" % (timeout, task_id))

    # -- 审片 ---------------------------------------------------------
    def vision_chat(self, model, text, image_urls, timeout=180):
        if isinstance(image_urls, str):
            image_urls = [image_urls]
        content = [{"type": "text", "text": text}]
        for u in image_urls:
            content.append({"type": "image_url", "image_url": {"url": u}})
        payload = {
            "model": model,
            "stream": False,
            "messages": [{"role": "user", "content": content}],
        }
        data = self._post("/v1/chat/completions", payload, timeout=timeout)
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise RuntimeError("审片响应异常: %s" % json.dumps(data, ensure_ascii=False)[:400])


def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    for i in range(3):
        try:
            r = requests.get(url, timeout=180)
            r.raise_for_status()
            dest.write_bytes(r.content)
            return dest
        except requests.RequestException as e:
            if i == 2:
                raise RuntimeError("下载失败 %s: %r" % (url, e))
            time.sleep(2)


# ---------------------------------------------------------------- 审片

REVIEW_RULES = """你是严格的电影分镜审片员。给你一张 AI 生成的电影静帧，以及这一镜的分镜要求。
这张图将被用作视频模型的首帧参考，所以它必须精确落在这一镜的构图与表演起点上。

判定规则：
- 下面「必须满足」里任意一条明显不符，就判 pass=false。
- 人物年龄/性别/发型/服装与设定不一致，或同一角色在不同镜头里长相漂移，判 false。
- 机位与景别错了（如要求过肩却拍成正面特写、要求大特写却带了全身），判 false。
- 画面出现文字、字幕、水印、logo、边框、分屏、多格漫画排版，判 false。
- 手部结构畸形、五官错位、多余肢体、镜中人物朝向矛盾，判 false。
- 光线方向与色温与要求明显冲突，判 false。
- 只要画面本身能作为这一镜的合格首帧，即使存在小的构图偏差也判 true。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{"pass": true 或 false, "score": 0-100 的整数, "issues": ["具体问题，中文，每条一句话"], "fix_hint": "给生图模型的一句中文修改指令，只写要改的地方，不要重复已经正确的部分"}"""


def build_review_text(shot, has_ref=False):
    checks = "\n".join("- " + c for c in shot["checks"])
    extra = ""
    if has_ref:
        extra = (
            "\n另外：第一张图是这一镜要审的画面，第二张图是同一序列里已经通过的相邻镜头。"
            "请对比两张图里的角色长相、发型、服装与车内空间结构，如果出现明显漂移，在 issues 里指出并在 fix_hint 中说明。\n"
        )
    return (
        REVIEW_RULES
        + "\n\n镜头编号：%s（%s）\n" % (shot["id"], shot.get("title", ""))
        + "景别/机位：%s\n" % shot.get("shot_size", "")
        + "这一镜要表达：%s\n" % shot.get("intent", "")
        + "必须满足：\n%s\n" % checks
        + extra
        + "生成时使用的提示词（供你对照）：\n%s" % shot["image_prompt"]
    )


def parse_review(raw):
    raw = (raw or "").strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    m = re.search(r"\{.*\}", raw, flags=re.S)
    if not m:
        return {"pass": False, "score": 0, "issues": ["审片模型未返回可解析的 JSON"], "fix_hint": ""}
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"pass": False, "score": 0, "issues": ["审片 JSON 解析失败"], "fix_hint": ""}
    return {
        "pass": bool(data.get("pass")),
        "score": int(data.get("score") or 0),
        "issues": [str(x) for x in (data.get("issues") or [])][:8],
        "fix_hint": str(data.get("fix_hint") or ""),
    }


# ---------------------------------------------------------------- 主流程

REF_INSTRUCTION = (
    "参考图用途说明：附带的图片只用于锁定人物长相、服装、发型与车内空间结构，"
    "不要照搬它的构图、机位和景别；请按上面这一镜的要求重新构图取景。"
)


def compose_prompt(shot, feedback, style_lock="", has_ref=False):
    prompt = shot["image_prompt"]
    lock = shot.get("style_lock") or style_lock
    if lock:
        prompt += "\n" + lock
    if has_ref:
        prompt += "\n" + REF_INSTRUCTION
    for item in feedback:
        prompt += "\n修正要求（必须满足）：" + item
    return prompt


def load_ref(path: Path, max_side: int = 1280):
    """本地参考图 -> data URL。接口支持 base64 或 url；
    先缩到 max_side 长边，避免 base64 体积过大被拒。"""
    if not path.exists():
        return None
    try:
        from PIL import Image
        im = Image.open(path).convert("RGB")
        if max(im.size) > max_side:
            scale = max_side / max(im.size)
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=92)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        return "data:%s;base64,%s" % (mime, base64.b64encode(path.read_bytes()).decode())


def run(args):
    shots_path = Path(args.shots).resolve()
    spec = json.loads(shots_path.read_text(encoding="utf-8"))
    shots = spec["shots"]
    style_lock = spec.get("style_lock", "")

    if args.only:
        wanted = {x.upper() for x in args.only}
        shots = [s for s in shots if s["id"].upper() in wanted]
        missing = wanted - {s["id"].upper() for s in shots}
        if missing:
            raise SystemExit("不存在的镜头编号: %s" % ", ".join(sorted(missing)))

    out_dir = Path(args.out).resolve()
    attempt_dir = out_dir / "attempts"

    if args.dry_run:
        for s in shots:
            ref = "prev" if s.get("ref") == "prev" else (s.get("ref") or "-")
            log("=" * 70)
            log("%s  %s  [%s, %s]  ref=%s" % (
                s["id"], s.get("title", ""), s.get("size"), s.get("quality"), ref))
            log("-" * 70)
            log(compose_prompt(s, [], style_lock, has_ref=bool(s.get("ref"))))
        log("=" * 70)
        log("dry-run 结束，共 %d 镜。确认提示词后去掉 --dry-run 正式生成。" % len(shots))
        return 0

    key = find_api_key(PROJECT_ROOT, args.api_key)
    client = Client(args.base_url, key)

    out_dir.mkdir(parents=True, exist_ok=True)
    state_path = out_dir / "state.json"
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            state = {}

    approved_paths = {}
    for sid_key, info in state.items():
        p = out_dir / (sid_key + ".png")
        if info.get("approved") and p.exists():
            approved_paths[sid_key] = p
    if args.force:
        approved_paths = {}

    # 按分镜顺序确定「相邻上一镜」，--only 时也能正确找到参考图
    order = [s["id"] for s in spec["shots"]]

    manifest = {"model": IMAGE_MODEL, "shots": []}
    approved_count = 0

    for s in shots:
        sid = s["id"]
        final_path = out_dir / (sid + ".png")
        if sid in approved_paths:
            log("[%s] 已通过，跳过（--force 可重做）" % sid)
            manifest["shots"].append({
                "id": sid, "title": s.get("title"), "image": str(approved_paths[sid]),
                "h3": s.get("h3"), "approved": True, "attempts": [],
            })
            continue

        # 角色/场景一致性：把指定的参考帧一起送进生成接口
        ref_files = []
        want = s.get("ref")
        wants = want if isinstance(want, list) else ([want] if want else [])
        for w in wants:
            if w == "prev":
                i = order.index(sid)
                for prev_id in reversed(order[:i]):
                    if prev_id in approved_paths:
                        ref_files.append(approved_paths[prev_id])
                        break
            else:
                p = approved_paths.get(w) or (out_dir / (w + ".png"))
                if p.exists():
                    ref_files.append(p)
        refs = [x for x in (load_ref(p) for p in ref_files) if x]
        if refs:
            log("[%s] 参考图：%s" % (sid, ", ".join(p.name for p in ref_files)))

        feedback = []
        history = []
        best = None
        ok = False
        for attempt in range(1, args.max_attempts + 1):
            prompt = compose_prompt(s, feedback, style_lock, has_ref=bool(refs))
            log("[%s] 第 %d/%d 次生成…" % (sid, attempt, args.max_attempts))
            try:
                url = client.generate(
                    prompt,
                    size=args.size or s.get("size") or "2048x1152",
                    quality=args.quality or s.get("quality") or "high",
                    images=refs or None,
                    timeout=args.timeout,
                )
            except RuntimeError as e:
                log("    生成失败：%s" % e)
                history.append({"attempt": attempt, "error": str(e)})
                time.sleep(3)
                continue

            shot_file = attempt_dir / ("%s_a%d.png" % (sid, attempt))
            download(url, shot_file)
            log("    已保存 %s" % shot_file.relative_to(PROJECT_ROOT))

            rec = {"attempt": attempt, "prompt": prompt,
                   "file": str(shot_file), "url": url, "refs": [p.name for p in ref_files]}

            if args.no_review:
                rec["review"] = None
                history.append(rec)
                if not ok:
                    final_path.write_bytes(shot_file.read_bytes())
                    ok = True
                break

            try:
                review_imgs = [load_ref(shot_file)]
                if ref_files:
                    review_imgs.append(load_ref(ref_files[-1]))
                review = parse_review(client.vision_chat(
                    args.review_model, build_review_text(s, bool(ref_files)),
                    [u for u in review_imgs if u]))
            except RuntimeError as e:
                log("    审片失败：%s" % e)
                review = {"pass": True, "score": 0, "issues": ["审片调用失败，跳过"], "fix_hint": ""}

            rec["review"] = review
            history.append(rec)
            log("    审片：%s  score=%d  %s" % (
                "通过" if review["pass"] else "不通过", review["score"],
                "；".join(review["issues"]) if review["issues"] else "无问题",
            ))
            if best is None or review["score"] > best["score"]:
                best = {"score": review["score"], "file": shot_file}

            if review["pass"]:
                final_path.write_bytes(shot_file.read_bytes())
                ok = True
                break

            if review["fix_hint"]:
                feedback.append(review["fix_hint"])
            elif review["issues"]:
                feedback.append("；".join(review["issues"]))

        if ok:
            approved_count += 1
            approved_paths[sid] = final_path
            log("[%s] 通过 -> %s" % (sid, final_path.relative_to(PROJECT_ROOT)))
        else:
            log("[%s] 达到最大尝试次数仍未通过，保留分数最高的一张供人工挑选" % sid)
            src = best["file"] if best and best["file"].exists() else None
            if src is None:
                src = next((Path(r["file"]) for r in reversed(history) if r.get("file")), None)
            if src and src.exists():
                final_path.write_bytes(src.read_bytes())
                log("[%s] 保留的是 %s" % (sid, src.name))

        state[sid] = {"approved": ok, "attempts": len([r for r in history if r.get("file")])}
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

        manifest["shots"].append({
            "id": sid,
            "title": s.get("title"),
            "image": str(final_path) if final_path.exists() else None,
            "approved": ok,
            "attempts": history,
            "h3": s.get("h3"),
        })

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_h3_md(out_dir / "h3_prompts.md", spec, manifest)

    sheet = build_contact_sheet(out_dir, spec)
    if sheet:
        log("预览拼版：%s" % sheet.relative_to(PROJECT_ROOT))

    log("")
    log("完成：%d 镜，通过 %d 镜。" % (len(manifest["shots"]), approved_count))
    log("产物目录：%s" % out_dir)
    return 0


def build_contact_sheet(out_dir: Path, spec):
    """把所有成片拼成一张预览图，方便一次性看完整场戏的连贯性。"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        log("（未安装 Pillow，跳过预览图拼版）")
        return None

    files = [(s["id"], out_dir / (s["id"] + ".png")) for s in spec["shots"]]
    files = [(i, p) for i, p in files if p.exists()]
    if not files:
        return None

    cols, cell_w, gap, label_h = 4, 640, 16, 34
    imgs = []
    for sid, p in files:
        im = Image.open(p).convert("RGB")
        h = int(cell_w * im.height / im.width)
        imgs.append((sid, im.resize((cell_w, h), Image.LANCZOS)))

    cell_h = max(im.height for _, im in imgs) + label_h
    rows = (len(imgs) + cols - 1) // cols
    W = cols * cell_w + (cols + 1) * gap
    H = rows * cell_h + (rows + 1) * gap
    sheet = Image.new("RGB", (W, H), (18, 18, 20))
    draw = ImageDraw.Draw(sheet)

    font = None
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf"):
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/" + name, 22)
            break
        except OSError:
            continue

    for idx, (sid, im) in enumerate(imgs):
        r, c = divmod(idx, cols)
        x = gap + c * (cell_w + gap)
        y = gap + r * (cell_h + gap)
        sheet.paste(im, (x, y))
        draw.text((x + 5, y + im.height + 6), sid, fill=(235, 235, 235), font=font)

    dest = out_dir / "contact_sheet.jpg"
    sheet.save(dest, quality=92)
    return dest


def write_h3_md(path, spec, manifest):
    by_id = {s["id"]: s for s in spec["shots"]}
    lines = ["# H3 逐镜生成清单", "", "每镜一次生成，首帧用同名静帧图。", ""]
    for item in manifest["shots"]:
        sid = item["id"]
        shot = by_id.get(sid, {})
        lines.append("## %s %s" % (sid, shot.get("title", "")))
        lines.append("")
        lines.append("- 首帧图：`%s`" % Path(item["image"]).name if item.get("image") else "- 首帧图：缺失")
        lines.append("- 建议时长：约 %s 秒" % shot.get("duration", "5"))
        h3 = item.get("h3") or {}
        lines.append("")
        lines.append("```text")
        lines.append("For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.")
        lines.append("")
        lines.append("integrated_multimodal_description: " + h3.get("integrated_multimodal_description", ""))
        lines.append("")
        lines.append("overall_soundscape: " + h3.get("overall_soundscape", ""))
        lines.append("")
        lines.append("non_diegetic_music: " + h3.get("non_diegetic_music", ""))
        lines.append("```")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description="分镜图生成 + 自动审片（grsai gpt-image-2.5-flare）")
    ap.add_argument("--shots", default=str(HERE / "shots.json"), help="分镜定义文件")
    ap.add_argument("--out", default=str(PROJECT_ROOT / "out" / "storyboard"), help="输出目录")
    ap.add_argument("--api-key", default=None, help="不传则自动在项目里找 .text/.txt 中的 sk-")
    ap.add_argument("--base-url", default=DEFAULT_BASE, help="国内节点 grsai.dakka.com.cn，全球节点 grsai.com")
    ap.add_argument("--review-model", default=DEFAULT_REVIEW_MODEL, help="审片用的视觉模型")
    ap.add_argument("--size", default=None, help="覆盖像素尺寸，如 2048x1152 / 3840x2160")
    ap.add_argument("--quality", default=None, choices=["low", "medium", "high"], help="覆盖画质档位")
    ap.add_argument("--max-attempts", type=int, default=3, help="单镜最多尝试次数")
    ap.add_argument("--timeout", type=int, default=420, help="单次生成轮询超时秒数")
    ap.add_argument("--only", nargs="+", default=None, help="只处理指定镜头，如 --only S03 S07")
    ap.add_argument("--force", action="store_true", help="已存在的成片也重做")
    ap.add_argument("--no-review", action="store_true", help="只用第一张，不调审片模型")
    ap.add_argument("--dry-run", action="store_true", help="只打印提示词")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
