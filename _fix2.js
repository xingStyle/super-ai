const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));

// S06：去掉重复的 scene-citang.png（我误写了两遍，导致 ref 数与 Picture 编号错位）
{
  const s = spec.shots.find((x) => x.id === "S06");
  s.ref = ["scene-citang.png", "char-suwan.png", "char-luchen.png"];
  s.picture_use = [
    "锁定立柱与供桌的相对位置",
    "锁定女主的长相、体型与服装",
    "锁定男主的长相、体型与服装",
  ];
  // Picture 4 改成「锁定供桌与旧木匣的位置与形制」改为引用 Picture 1（同一张场景图）
  s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description.replace(
    "<Picture 4> 锁定供桌与旧木匣的位置与形制，不要照搬它的构图",
    "<Picture 1> 同时锁定供桌与旧木匣的位置与形制"
  );
  // 重新编号 5..9 → 4..8
  for (let n = 5; n <= 9; n++) {
    s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description
      .split(`<Picture ${n}>`)
      .join(`<Picture ${n - 1}>`);
  }
}

// S08：ref 只有 2 张 + 2 帧 = Picture 1..4，去掉多出来的第 5 条
{
  const s = spec.shots.find((x) => x.id === "S08");
  s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description.replace(
    /；<Picture 5>[^；。]*/g,
    ""
  );
}

// S03：补足「躯干配重」「受击变形」「环境反馈」三个词面
{
  const s = spec.shots.find((x) => x.id === "S03");
  const b = s.beats[3];
  b.frame_prompt = b.frame_prompt
    .replace(
      "**受力方的变形（核心）**：她的肩在接触的那一瞬**向内塌下去、肩头被顶得向后偏位**",
      "**受击部位的变形（核心）**：她的肩在接触的那一瞬**向内凹陷、塌下去、肩头被顶得向后偏位**，接触处**布料被压出放射状的褶**"
    )
    .replace(
      "**躯干因为这一转向前压、后腿蹬直**作为配重与推进。",
      "**躯干前压、上身向反方向压住**作为配重，**后腿蹬直**推进。"
    )
    .replace(
      "**环境反馈**：接触点周围**一小圈灰尘被挤开**；她脚边的**干草被带得向一侧滑开**；**她衣袖的袖口被这一下带得甩动**。",
      "**环境反馈**：接触点周围**一小圈灰尘被挤得四散**；她脚边的**干草被带得向一侧滑开、扬起**；**她衣袖的袖口被这一下带得甩动**。"
    );

  s.h3.integrated_multimodal_description = s.h3.integrated_multimodal_description
    .replace(
      "**她的肩向内塌下、肩头被顶得向后偏位**",
      "**她的肩向内凹陷塌下、肩头被顶得向后偏位**，接触处**布料被压出放射状的褶**"
    )
    .replace(
      "躯干前压、后腿蹬直。",
      "躯干前压、**上身向反方向压住作为配重**，后腿蹬直。"
    )
    .replace(
      "**环境反馈**：接触点周围灰尘被挤开，脚边干草向一侧滑开，她的袖口被带得甩动。",
      "**环境反馈**：接触点周围灰尘被挤得四散，脚边干草向一侧滑开扬起，她的袖口被带得甩动。"
    );
}

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
console.log("已修正 S03 / S06 / S08");
