const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));

// ── 1) image_prompt 用第一帧（首帧），并在头部补上完整空间与服装锚点
const COSTUME = `**男主陆沉**穿宽松白色纯棉短袖T恤、黑色宽松长裤、黑色系带高帮鞋（绝不是练功服，绝不穿浅蓝色交领服装）。**女主苏晚**穿浅灰蓝立领交领练功服、藏青几何纹镶边、同色束脚长裤、黑布武术平底鞋（绝不是白色短袖）。`;
const SPACE = `机位、背景与光位：屋顶破洞漏下的冷青白月光**只斜照人物上半身、供桌、立柱与后墙，不落到地面**；地面是夯实的干黄土加散落干草，**整片在阴影里，干燥、哑光、粗糙，没有任何反光、亮斑或水渍**。`;

for (const s of spec.shots) {
  if (!s.beats || !s.beats.length) continue;
  const b1 = s.beats[0];
  // 首帧 = 第一分镜，并把服装与空间锚点补进正文（style_lock 不进 H3 提示词，
  // 所以必须写在正文里；这里同样不能省）
  s.image_prompt = b1.frame_prompt
    .replace(/\n\n【硬约束】[\s\S]*$/, "")
    .trim() + `\n\n${COSTUME}\n${SPACE}`;
}

// ── 2) H3 里补全 Picture 4..N 的用途声明
for (const s of spec.shots) {
  const n = s.beats.length;
  const h3 = s.h3.integrated_multimodal_description;
  if (!h3) continue;

  // 收集已有声明的最大编号
  const used = [...h3.matchAll(/<Picture (\d+)>/g)].map((m) => Number(m[1]));
  const maxUsed = used.length ? Math.max(...used) : 0;
  if (maxUsed >= 3 + n) continue; // 已够

  const camWord = (b, i) =>
    `第 ${(Number(b.t) || 0).toFixed(1)} 秒「${b.name}」`;
  const extra = [];
  for (let i = 0; i < n; i++) {
    const num = 4 + i;
    if (used.includes(num)) continue;
    extra.push(
      `<Picture ${num}> 只用于锁定${camWord(s.beats[i], i)}这一帧的姿态与取景，不要照搬它的构图`
    );
  }
  if (!extra.length) continue;

  // 插到第一段声明末尾（第一个空行之前）
  const firstBlank = h3.indexOf("\n\n");
  const head = h3.slice(0, firstBlank).replace(/。$/, "");
  s.h3.integrated_multimodal_description =
    head + "；" + extra.join("；") + "。" + h3.slice(firstBlank);
}

// ── 3) S03 / S06 补力学（大关节带动、躯干配重、受击变形、环境反馈 / 惯性滞后）
{
  const s = spec.shots.find((x) => x.id === "S03");
  s.beats[3].frame_prompt = s.beats[3].frame_prompt.replace(
    "**两人只有肘与肩这一个接触点，其余部位不接触、不交叠。**",
    `**惯性滞后**：他的肘已经停在她肩上，但她的**头还朝着原来的方向停了半拍才被带得偏过去**；她的**头发因为这一下被甩起、慢于肩膀**。
**环境反馈**：接触点周围**一小圈灰尘被挤开**；她脚边的**干草被带得向一侧滑开**；**她衣袖的袖口被这一下带得甩动**。
**两人只有肘与肩这一个接触点，其余部位不接触、不交叠。**`
  );
  // 强化大关节与配重措辞（确保 lint 能命中，也确保模型读得到）
  s.beats[3].frame_prompt = s.beats[3].frame_prompt.replace(
    "**发力方的力学**：他的肘**从下往上、由内向外送出**；能看到他的**髋与肩一起转送过来**——**肩已经越过自己的前脚**，这说明不是甩胳膊，是整个人转出去的。",
    `**发力方的力学**：**髋先转、躯干带动肩，肩再把手肘送出去**——大关节带小关节，不是甩胳膊。他的肘**从下往上、由内向外送出**；**肩已经越过自己的前脚**，**躯干因为这一转向前压、后腿蹬直**作为配重与推进。`
  );
  // H3 里也补
  s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description.replace(
    "他的髋与肩一起转送，肩已越过自己的前脚。接触点周围灰尘被挤开，脚边干草滑开。",
    `**髋先转、躯干带动肩、肩再把手肘送出去**（大关节带小关节，不是甩胳膊），肩已越过自己的前脚，躯干前压、后腿蹬直。**惯性滞后**：肘停在她肩上时她的头还朝着原方向、慢半拍才被带偏，头发慢于肩膀。**环境反馈**：接触点周围灰尘被挤开，脚边干草向一侧滑开，她的袖口被带得甩动。`
  );
}
{
  const s = spec.shots.find((x) => x.id === "S06");
  s.beats[4].frame_prompt = s.beats[4].frame_prompt.replace(
    "**环境反馈**：接触点周围**细尘被挤开一小圈**；供桌上的**薄灰被气流带得飘起**。",
    `**惯性滞后**：脚已经顶进他腰侧，他的**头还保持着原来的方向、慢了半拍才被带得甩开**；他的**T恤下摆慢于身体、被甩向后方**。
**环境反馈**：接触点周围**细尘被挤开一小圈**；供桌上的**薄灰被气流带得飘起**；**他脚边的干草被震得四散**。`
  );
  s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description.replace(
    "接触点周围细尘被挤开，供桌薄灰被气流带起。",
    `**惯性滞后**：脚已顶进他腰侧，他的头还朝着原方向、慢半拍才被甩开，T恤下摆慢于身体、甩向后方。**环境反馈**：接触点周围细尘被挤开，供桌薄灰被气流带起，他脚边干草震得四散。`
  );
}

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
console.log("已补 image_prompt / Picture 声明 / 力学细节");
