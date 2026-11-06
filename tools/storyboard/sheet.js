const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const dir = process.argv[2] || "out/song";
const ids = (process.argv[3] || "S01,S02,S03,S04,S05,S06,S07,S08").split(",");

(async () => {
  const imgs = [];
  for (const id of ids) {
    const p = path.join(dir, id + ".png");
    if (!fs.existsSync(p)) continue;
    const buf = await sharp(p).resize({ height: 520 }).jpeg({ quality: 92 }).toBuffer();
    const m = await sharp(buf).metadata();
    imgs.push([id, buf, m.width, m.height]);
  }
  if (!imgs.length) throw new Error("没有图片");

  const cols = 4, gap = 14, labelH = 30;
  const cw = Math.max(...imgs.map((i) => i[2]));
  const ch = Math.max(...imgs.map((i) => i[3])) + labelH;
  const rows = Math.ceil(imgs.length / cols);
  const W = cols * cw + (cols + 1) * gap;
  const H = rows * ch + (rows + 1) * gap;

  const comps = [];
  imgs.forEach(([id, buf, w, h], i) => {
    const r = Math.floor(i / cols), c = i % cols;
    comps.push({ input: buf, top: gap + r * (ch + gap), left: gap + c * (cw + gap) });
  });

  const texts = imgs
    .map(([id, , w, h], i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = gap + c * (cw + gap) + 4;
      const y = gap + r * (ch + gap) + h + 22;
      return `<text x="${x}" y="${y}" fill="#dddddd" font-size="20" font-family="sans-serif">${id}</text>`;
    })
    .join("");
  comps.push({ input: Buffer.from(`<svg width="${W}" height="${H}">${texts}</svg>`), top: 0, left: 0 });

  await sharp({ create: { width: W, height: H, channels: 3, background: "#121214" } })
    .composite(comps)
    .jpeg({ quality: 90 })
    .toFile(path.join(dir, "contact_sheet.jpg"));

  console.log("ok", W + "x" + H);
})();
