const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));
const G = (id) => spec.shots.find((x) => x.id === id);

// ── 特写帧：加「头肩在画外 / 占满画面」的构图锁定 ──
const CROP = {
  S02: [
    `【构图锁定】**只拍她的右前臂与右掌。画面被这条手臂和掌前的空处占满。**她的头和肩都在画面左上角之外，切在肘部稍上方。`,
    1,
  ],
  S03: [
    `【构图锁定】**只拍他的脚与门框下缘。画面被这半只鞋和一段木棱占满。**他的腿只露出小腿下段，膝盖以上全部在画面之外。`,
    1,
  ],
  S05: [
    `【构图锁定】**只拍他撑地的那只手与手下的一小片干土。画面被这只手占满。**他的手腕以上在画面右上角之外；画面右上角只能看到**一小截裤腿与膝盖的边缘**，不允许出现上半身。`,
    0,
  ],
  S06: [
    `【构图锁定】**只拍指尖、供桌边缘与木匣的一角。画面被这三样东西占满。**他的手臂从画面左侧伸入，手腕以上全部在画面外，没有脸、没有肩、没有身体。`,
    3,
  ],
};

for (const sid of Object.keys(CROP)) {
  const [text, idx] = CROP[sid];
  const b = G(sid).beats[idx];
  if (!b.frame_prompt.includes("【构图锁定】")) {
    b.frame_prompt = b.frame_prompt.replace(/\n\n【/, `\n\n${text}\n\n【`);
  }
}

// ── 接触帧：加「留一道缝、不贴死」 ──
const GAP =
  `【避免穿模的关键】**接触处不要画成粘连融合。**两个物体之间要有清晰的边界：` +
  `接触面上能看出"一边压下去、另一边被压出凹面"，但**交界的轮廓线必须清楚可辨**，` +
  `不许出现皮肤与布料融成一块、肢体边界消失、多出一块肉或一段肢体。`;

const CONTACT = [
  ["S03", 2], // 肘撞肩
  ["S04", 3], // 撑地（手与土）
  ["S07", 2], // 撞柱
];
for (const [sid, idx] of CONTACT) {
  const b = G(sid).beats[idx];
  if (!b.frame_prompt.includes("避免穿模的关键")) {
    b.frame_prompt = b.frame_prompt.replace(/\n\n【硬约束】/, `\n\n${GAP}\n\n【硬约束】`);
  } else {
    b.frame_prompt += "\n\n" + GAP;
  }
}

// ── S05_b2：抽象词换几何 ──
{
  const b = G("S05").beats[1];
  b.frame_prompt = b.frame_prompt.replace(
    "**他的起跑是低位的**：**上身前倾、几乎与地面成锐角**，**两条腿大步交替、后腿蹬直、前腿高抬**；**重心压得很低，人向前扑而不是向前跑**。",
    `**他的起跑是低位的，必须画成这个样子：**
- **上身前倾到几乎与地面平行**（不是"前倾"，是**折下去**），**头在身体的最前端、比髋部更低**。
- **两条腿大步交替：后腿完全蹬直、脚尖还点在地上；前腿高抬、膝盖提到腰的高度、小腿折回。**
- **他的髋部位置很低，比站立时低一截**；**从侧面看整个人是一条前倾的斜线，重心线指向斜前方，不是垂直的。**
- **两只脚不可能同时全掌着地**——一只蹬地、一只在空中。`
  );
}

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
console.log("已修正构图锁定 / 防穿模 / 几何姿态");
