# AI 视频生产流水线

把剧情变成可交付的 AI 视频片段：角色定妆照 → 场景全景图 → 逐镜首帧 → 逐镜提示词 → 视频生成。

## 目录

```
.cursor/rules/ai-video-production.mdc   通用生产规则（与题材无关，先读这个）
tools/storyboard/                       流水线脚本
projects/<项目名>/                      一个项目一棵树，所有资料都在这里
```

## 新材料放哪里

**所有素材都进项目目录，不要放仓库根目录。** 一个项目的所有资料必须能随这个目录整体搬走。

| 材料 | 放这里 | 命名 |
|---|---|---|
| 角色定妆照（四视图） | `projects/<项目>/10-refs/` | `char-<角色>.png` |
| 角色头部特写（长相锁定） | `projects/<项目>/10-refs/` | `char-<角色>-head.png` |
| 场景全景图（每场一张，空间基准） | `projects/<项目>/10-refs/` | `scene-<场景>.png` |
| 角色视角背景（切正脸要用） | `projects/<项目>/10-refs/` | `bg-<角色>-<朝向>.png` |
| 原始素材（照片、材质、扫描件） | `projects/<项目>/00-source/` | 保留原文件名 |
| 剧情、人物、时代设定 | `projects/<项目>/00-spec/` | `story.md` |
| 分镜定义（唯一数据源） | `projects/<项目>/00-spec/` | `shots.json` |

**命名是最重要的一环**：`shots.json` 里写 `ref: ["char-general.png"]` 时只写文件名，
脚本按 `10-refs/` → `20-frames/` 顺序去找。名字对不上会直接报错终止——这是故意的，
以前静默跳过导致过整批参考图失效却没人发现。

原始素材不要直接当参考图用：先用 `character_sheet.js` 生成四视图定妆照，
再拿定妆照当参考图。直接拿照片喂给模型，长相会每镜漂移。

## 规则文档

**开工前必读** `.cursor/rules/ai-video-production.mdc`。九章：

1. 镜头必要性（成本纪律、反注水红线、时长推算）
2. 运镜（按需推进，默认固定）
3. 镜头语言与剪辑（谁说话给谁、正反打、空间预设计、画面与台词自洽）
4. 打戏规则（因果对应、力量可视化、轴线、节奏）
5. 多图参考（用途声明、镜内多分镜、场景全景图）
6. 无上下文的衔接
7. 出图工程规则
8. 真实感（皮肤与材质、AI 味成因）
9. 目录结构与交付物清单

项目专属设定写在 `projects/<项目名>/00-spec/story.md`，**不要写进规则文件**。

## 快速开始

```bash
cd tools/storyboard
npm install

# 生成角色四视图定妆照（每角色一张，横向四视图卡）
node character_sheet.js --project projects/song

# 生成逐镜首帧（自动审片 + 失败重试 + 并发）
node generate.js --project projects/song --concurrency 4

# 只重跑指定镜头
node generate.js --project projects/song --only S02A --force

# 时长审计（按每镜标注的语速复算，检查注水）
node timing_audit.js projects/song/00-spec/shots.json

# 生成预览拼版
node sheet.js projects/song/20-frames

# 分析成片：抽帧
node video_frames.js <视频路径> projects/song/30-video/frames
```

## 项目内部结构

```
projects/song/
├── 00-spec/
│   ├── story.md             剧情、人物、时代与服化道、空间方位
│   └── shots.json           分镜定义（唯一数据源）
├── 10-refs/                 人工资产：定妆照、背景图、场景全景图
├── 20-frames/               每镜首帧 + attempts/ 每次尝试
├── 30-video/                视频片段
├── 40-out/                  成片、校色版
├── h3_prompts.md            逐镜提示词 + 上传清单（自动生成）
├── manifest.json            产物索引
└── state.json               已通过镜头记录（避免整片重跑）
```

## 什么进版本库

| 提交 | 不提交 |
|---|---|
| `.cursor/rules/`、`tools/`（脚本与 package.json、package-lock.json） | `node_modules/` |
| `projects/*/00-spec/`（剧情、分镜） | `out/`（旧版生成产物，241 MB） |
| `projects/*/10-refs/`（定妆照、背景图） | `projects/*/20-frames`、`30-video`、`40-out` |
| `projects/*/00-source/`（原始素材） | 日志 `*.log`、密钥文件 |
| `README.md`、`.gitignore` | `10-refs/_scratch/`（调试对比图） |

**密钥绝不提交。** `.gitignore` 已覆盖 `apikey.txt`、`*.text`、`*.key`、`.env*`。

## 密钥

放在仓库根目录，文件名随意（`apikey.txt` 等），内容形如 `sk-xxxx`。
脚本会自动识别；也可用环境变量 `GRSAI_API_KEY`。
