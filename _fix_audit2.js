const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));
const G = (id) => spec.shots.find((x) => x.id === id);

// ── 接触帧：明确写「留着一道极细的缝」 ──
const GAP =
  `【避免穿模的关键】**两个人（或人与物）之间必须留着一道极细的缝，不能粘连融合。**` +
  `接触面上能看出"一边压下去、另一边被压出凹面"，但**交界的轮廓线清楚可辨、中间有一道能看见的缝隙**；` +
  `不许出现皮肤与布料融成一块、肢体边界消失、多出一块肉或一段肢体。`;

for (const [sid, idx] of [["S03", 2], ["S04", 3], ["S07", 2]]) {
  const b = G(sid).beats[idx];
  // 去掉旧的 GAP 版本，换成带「缝隙」字样的
  b.frame_prompt = b.frame_prompt
    .replace(/【避免穿模的关键】[\s\S]*?(?=\n\n【硬约束】)/, GAP)
    .replace(/【避免穿模的关键】[\s\S]*$/, GAP);
  if (!b.frame_prompt.includes("留着一道极细的缝")) {
    b.frame_prompt = b.frame_prompt.replace(/\n\n【硬约束】/, `\n\n${GAP}\n\n【硬约束】`);
  }
}

// ── S01_b4：过肩对视加不对称 + 明确两人都在动 ──
{
  const b = G("S01").beats[3];
  b.frame_prompt = b.frame_prompt.replace(
    "**两个人都在呼吸，衣服有极轻微的起伏**，不是凝固的雕塑。",
    `**两个人都在动，没有任何一个人是站着的雕塑：**
- **苏晚：重心偏在她的右腿，左腿松着、膝盖微弯；一侧肩膀比另一侧低一点**（**双肩连线是斜的，不是水平的**），头略微歪着。
- **陆沉（前景虚焦）：他的肩膀还在起伏，能看到他在呼吸；头轻微偏着。**
- **两个人都在呼吸，衣服有极轻微的起伏。**这**不是两个立正的人对视**，是一个准备动手的人在看一个挡路的人。`
  );
  b.frame_prompt = b.frame_prompt.replace(
    "**这一帧是过肩镜。",
    "**【双人同框，两人都在动】**这一帧是过肩镜。"
  );
}

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
console.log("已修正");
