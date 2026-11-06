const { execFileSync } = require("child_process");
const ffmpeg = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2];
const OUT = process.argv[3] || "out/video-frames";

fs.mkdirSync(OUT, { recursive: true });

function probe(file) {
  try {
    const out = execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1"), [
      "-v", "error",
      "-show_entries", "format=duration,size:stream=width,height,r_frame_rate,nb_frames",
      "-of", "json", file,
    ], { encoding: "utf8" });
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log("ffmpeg:", ffmpeg);
  const info = probe(SRC);
  if (info) {
    const s = info.streams[0] || {};
    console.log("时长:", info.format.duration + "s", "分辨率:", s.width + "x" + s.height, "帧率:", s.r_frame_rate);
  } else {
    // 没有 ffprobe，用 ffmpeg 输出
    try {
      const out = execFileSync(ffmpeg, ["-i", SRC, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      console.log(out);
    } catch (e) {
      console.log((e.stderr || "").split("\n").filter((l) => /Duration|Stream/.test(l)).join("\n"));
    }
  }

  // 每秒抽 2 帧
  execFileSync(ffmpeg, [
    "-y", "-i", SRC,
    "-vf", "fps=2",
    "-q:v", "2",
    path.join(OUT, "f%03d.jpg"),
  ], { stdio: "ignore" });

  const frames = fs.readdirSync(OUT).filter((f) => f.endsWith(".jpg")).sort();
  console.log("已抽帧:", frames.length, "张");
})();
