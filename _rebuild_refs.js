const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));

/** 按 ref 张数 + beats 张数，重建整个 <Picture N> 用途声明头 */
function rebuildHead(s) {
  const refUse = s.picture_use || [];
  const beatStart = refUse.length + 1;
  const parts = [];
  refUse.forEach((u, i) => {
    parts.push(`<Picture ${i + 1}> 只用于${u}，不要照搬它的构图`);
  });
  (s.beats || []).forEach((b, i) => {
    const n = beatStart + i;
    parts.push(
      `<Picture ${n}> 对应第 ${(Number(b.t) || 0).toFixed(1)} 秒「${b.name}」这一帧，只用于锁定该帧的姿态与取景，不要照搬它的构图`
    );
  });

  const h3 = s.h3.integrated_multimodal_description;
  const firstBlank = h3.indexOf("\n\n");
  const body = firstBlank >= 0 ? h3.slice(firstBlank) : "\n\n" + h3;
  s.h3.integrated_multimodal_description = parts.join("；") + "。" + body;
  return parts.length;
}

for (const s of spec.shots) {
  if (!s.beats || !s.beats.length || !s.h3) continue;
  const n = rebuildHead(s);
  console.log(s.id, "→ 声明", n, "张（ref", (s.ref || []).length, "+ beat", s.beats.length, "）");
}

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
