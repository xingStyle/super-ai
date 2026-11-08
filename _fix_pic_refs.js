const fs = require("fs");
const P = "projects/打戏/00-spec/shots.json";
const spec = JSON.parse(fs.readFileSync(P, "utf8"));
const s = spec.shots.find((x) => x.id === "S07");
const old = s.h3.integrated_multimodal_description;

const head = `\u003cPicture 1\u003e 只用于锁定立柱与供桌的相对位置，不要照搬它的构图；\u003cPicture 2\u003e 只用于锁定女主的长相、体型与服装，不要照搬它的构图；\u003cPicture 3\u003e 只用于锁定男主的长相、体型与服装，不要照搬它的构图；\u003cPicture 4\u003e 对应第 0.0 秒的撞击特写，只用于锁定接触部位与受击变形，不要照搬它的构图；\u003cPicture 5\u003e 对应第 1.0 秒他飞在半空的反弓姿态，只用于锁定姿态，不要照搬它的构图；\u003cPicture 6\u003e 对应第 2.0 秒后背撞柱的瞬间，只用于锁定姿态，不要照搬它的构图；\u003cPicture 7\u003e 对应第 3.0 秒滑到柱脚坐下的姿势，只用于锁定姿态，不要照搬它的构图。`;

const idx = old.indexOf("<Picture 1> 锁定空间");
if (idx < 0) throw new Error("找不到分段起点");
s.h3.integrated_multimodal_description = head + old.slice(idx + "<Picture 1> 锁定空间".length);

fs.writeFileSync(P, JSON.stringify(spec, null, 2), "utf8");
console.log("已补全 Picture 4-7 声明");
