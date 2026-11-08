#!/usr/bin/env node
/**
 * 分镜自检：在花钱生成之前，把「物理上不可能满足」和「数据自相矛盾」的问题挑出来。
 *
 * 这些错误交给审片是抓不到的——审片只判画面，不判你的描述本身有没有写错。
 * 而写错的描述会让模型反复产出废图，每轮都是真金白银。
 *
 * 用法:
 *   node lint_shots.js --project projects/song
 *   node lint_shots.js --project projects/song --json
 *
 * 退出码：0 = 通过，1 = 有 ERROR
 */
"use strict";

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, "..", "..");

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * 转身方向自洽：相机在人物背后时，可见脸颊与鼻尖朝向必定相反。
 * 写成同向 = 物理不可能，模型只会随机转一边。
 */
function checkTurn(text) {
  const out = [];
  // 先剔除否定语境：「左脸被遮住看不见」不是在要求露左脸
  let s = String(text).replace(/(左|右)脸(颊)?[^，。；]*?(被遮住|看不见|不可见|不露|挡住|遮)/g, "");
  // 再剔除「初始状态」的描述：「第 0 秒时他头朝画面左侧的城外」说的是起点，不是终点
  s = s
    .split(/(?<=[。；\n])/)
    .filter((line) => !/第\s*0\s*秒|起初|原本|一开始|开始时|起点|之前/.test(line))
    .join("");

  const leftFace = /左脸|左侧脸|左脸颊|左耳/.test(s);
  const rightFace = /右脸|右侧脸|右脸颊|右耳/.test(s);
  const noseLeft = /(鼻尖|鼻子|脸)[^。；，]{0,12}朝[^。；，]{0,6}(左方|左侧|左)/.test(s) || /朝画面左/.test(s);
  const noseRight = /(鼻尖|鼻子|脸)[^。；，]{0,12}朝[^。；，]{0,6}(右方|右侧|右)/.test(s) || /朝画面右/.test(s);

  if (leftFace && rightFace) {
    out.push(["ERROR", "同时要求露出左脸和右脸；四分之三侧只能看到一侧"]);
  }
  if (leftFace && noseRight) {
    out.push(["ERROR", "要求露左脸，却要求鼻尖/脸朝画面右；相机在背后时这两者矛盾"]);
  }
  if (rightFace && noseLeft) {
    out.push(["ERROR", "要求露右脸，却要求鼻尖/脸朝画面左；相机在背后时这两者矛盾"]);
  }
  return out;
}

/** <Picture N> 引用数必须与实际上传张数一致 */
function checkPictureRefs(shot) {
  const out = [];
  const text = shot.h3?.integrated_multimodal_description || "";
  const refs = Array.isArray(shot.ref) ? shot.ref.length : shot.ref ? 1 : 0;
  // 分镜帧会在运行时追加到上传列表末尾，必须算进总数
  const beatCount = Array.isArray(shot.beats) ? shot.beats.length : 0;
  const expected = refs + beatCount + (shot.last_frame ? 1 : 0);
  const used = new Set((text.match(/<Picture (\d+)>/g) || []));
  const nums = [...used].map((m) => Number(m.match(/\d+/)[0])).sort((a, b) => a - b);

  if (nums.length && Math.max(...nums) > expected) {
    out.push([
      "ERROR",
      `提示词引用了 <Picture ${Math.max(...nums)}>，但实际只上传 ${expected} 张（ref ${refs}${
        beatCount ? ` + 分镜帧 ${beatCount}` : ""
      }${shot.last_frame ? " + 尾帧 1" : ""}）`,
    ]);
  }
  if (nums.length < expected) {
    const missing = [];
    for (let i = 1; i <= expected; i++) if (!nums.includes(i)) missing.push(i);
    if (missing.length) {
      out.push(["WARN", `第 ${missing.join("、")} 张图没有被任何 <Picture N> 声明用途`]);
    }
  }
  return out;
}

/** 画面与台词的逻辑自洽 */
function checkNarrative(shot) {
  const out = [];
  const text = shot.h3?.integrated_multimodal_description || "";
  const speechMatch = text.match(/<d>\[[^\]]*\]([\s\S]*?)<\/d>/);
  const speech = speechMatch ? speechMatch[1] : "";
  const prompt = shot.image_prompt || "";

  // 台词要求某物出现，首帧画面里却已经有了 → 动作失去意义
  if (speech && /搬上来|拿来|取来|递过来|送上/.test(speech)) {
    const objs = ["箭捆", "箭", "弓", "刀", "盾", "旗"];
    for (const o of objs) {
      if (speech.includes(o) && new RegExp(`抱着?${o}|${o}已在|已有${o}`).test(prompt)) {
        out.push([
          "ERROR",
          `台词要求「${o}」被搬来，但首帧画面里人物已经拿着${o}；动作与台词冲突，观众会觉得莫名其妙`,
        ]);
      }
    }
  }

  // 命令与执行同镜：人还没等命令说完就已经在动 → 因果倒置
  if (speech) {
    const orderRe = /传令|把.+搬|快去|速去|取来|拿来|上城|列阵|备马|开城/;
    // 先剔掉否定语境与负面约束：「没有任何人开始奔跑」「士兵提前抱起箭捆」都不是在描述有人跑
    const affirmative = text
      .replace(/负面约束[\s\S]*$/g, "")
      .replace(/必须避免[\s\S]*$/g, "")
      .replace(/没有任何人[^。；]*/g, "")
      .replace(/没有[^。；，]{0,8}(跑|动|迈|起身|移)/g, "")
      .replace(/全程站着不动/g, "")
      .replace(/脚一动都没动/g, "");
    const actionRe = /正(在)?(跑|奔|冲|迈步|起身|转身跑)|已经在跑|已经跑|空手转身跑|抱起|抱着箭/;
    if (orderRe.test(speech) && actionRe.test(affirmative)) {
      out.push([
        "ERROR",
        "同一镜里既有命令又有人在执行，会出现「命令还没说完人已经在跑」的因果倒置。应拆成两镜：先下令（人不动），再执行（起跑）。",
      ]);
    }
  }

  // 命令镜里，要检查 checks 是否明确要求「听到命令的人不动」
  if (speech && /传令|把.+搬/.test(speech)) {
    const saysStill = /全程站着不动|没有移动|站着没动|脚一动都没动|还没有迈出去|没有任何人开始奔跑/.test(text);
    const checksStill = (shot.checks || []).some((c) => /站着|没有移动|脚一动|没有迈|未移动|静止/.test(c));
    if (!saysStill && !checksStill) {
      out.push([
        "WARN",
        "这是命令镜，但没有明确写「听令的人在这一镜里不动」；模型很可能让人当场跑起来。",
      ]);
    }
  }
  return out;
}

/** 首尾帧镜头：动作是否落在 img2img 能力范围内 */
function checkLastFrameScope(shot) {
  const out = [];
  if (!shot.last_frame) return out;

  const move = String(shot.what_moves || "");
  const fullBody = /全身|整个身体|转身|换向|走位|迈步|跑|扑|跪下|起身|重心转移/;
  const upperOnly = /头|视线|表情|肩|眼/;

  if (fullBody.test(move) && !upperOnly.test(move.replace(fullBody, ""))) {
    out.push([
      "ERROR",
      "what_moves 描述的是全身/位移动作，img2img 做不出来（躯干会被锁死，只转脖子）。应拆成两镜。",
    ]);
  } else if (fullBody.test(move)) {
    out.push([
      "WARN",
      "what_moves 里同时出现了全身动作与头肩动作，确认是不是把全身动作写进去了",
    ]);
  }
  return out;
}

/** 注水检查：短台词配超长镜、余量超过台词 */
function checkInflation(shot) {
  const out = [];
  const t = shot.timing;
  const duration = Number(shot.duration) || 0;
  const text = shot.h3?.integrated_multimodal_description || "";
  const m = text.match(/<d>\[[^\]]*\]([\s\S]*?)<\/d>/);
  const speech = m ? m[1].replace(/[\s，。、…—！？,.!?]/g, "") : "";
  const speechSec = t?.speech_sec || 0;

  if (!speech) {
    // 无台词镜：动作数量要能撑起时长。约 1.2–1.5 秒/动作。
    const moves = (text.match(/；|。/g) || []).length;
    if (duration >= 7) {
      out.push(["WARN", `无台词镜却给了 ${duration}s，确认不是空等`]);
    }
    return out;
  }

  // 台词极短却给了长镜
  if (speech.length <= 3 && duration >= 6) {
    out.push([
      "ERROR",
      `${speech.length} 个字（「${speech}」）却给了 ${duration}s 的镜头；短台词必须配短镜，说完即切`,
    ]);
  }

  // 余量超过台词本身
  // 「余量」指说完之后的空等；但如果这镜本来就是动作先于台词（或动作与台词并列），
  // 那部分是承载内容的表演，不该算余量。只有当余量既超过台词、又没写明它承载什么动作时才报错。
  const margin = t?.margin_sec || 0;
  const marginHasContent = /(退|垂|抬头|低头|起身|转|走|跑|迈|抬手|放下|按压|压|握|松|睁|闭|呼|吸)/.test(
    t?.margin_reason || ""
  );
  if (speechSec > 0 && margin > speechSec * 1.5 && margin > 2 && !marginHasContent) {
    out.push([
      "ERROR",
      `余量 ${margin}s 超过台词时长 ${speechSec}s 的 1.5 倍，且没写明这段余量承载什么动作；空等必须砍掉`,
    ]);
  }

  // 台词按语速推出来的秒数，与实际声明差太多
  if (t?.cps && speechSec > 0) {
    const est = speech.length / t.cps;
    if (Math.abs(est - speechSec) > 0.6) {
      out.push([
        "WARN",
        `${speech.length} 字 ÷ ${t.cps} 字/秒 ≈ ${est.toFixed(1)}s，但 speech_sec 写的是 ${speechSec}s`,
      ]);
    }
  }
  return out;
}

/** 必填字段：缺了会在生成时静默退化成 undefined，白白浪费一轮 */
function checkRequired(shot) {
  const out = [];
  const REQUIRED = ["id", "title", "shot_size", "intent", "duration", "connect", "size", "quality", "timing"];
  const missing = REQUIRED.filter((k) => shot[k] == null || shot[k] === "");
  if (missing.length) {
    out.push(["ERROR", `缺少必填字段：${missing.join("、")}`]);
  }
  if (!shot.h3?.integrated_multimodal_description) {
    out.push(["ERROR", "缺少 h3.integrated_multimodal_description"]);
  }
  if (!shot.image_prompt) {
    out.push(["ERROR", "缺少 image_prompt"]);
  }
  if (!Array.isArray(shot.checks) || !shot.checks.length) {
    out.push(["WARN", "缺少 checks，审片时没有判定依据"]);
  }
  return out;
}

/** 体型与头发：这两项是模型默认会搞砸的，必须逐镜显式写进正文 */
function checkBodyAndHair(shot) {
  const out = [];
  const text = shot.h3?.integrated_multimodal_description || "";
  if (!text) return out;

  // 皮肤：所有镜头都要查，与打斗无关
  const hasMatte = /哑光/.test(text);
  const hasOil = /油光|反光|镜面高光/.test(text);
  if (!hasMatte || !hasOil) {
    out.push(["ERROR", "提示词正文缺「哑光」或「油光」约束；皮肤会被渲染成油亮（style_lock 不进 H3 提示词）"]);
  }

  // 体型与头发：用显式声明，不靠词义猜测。
  // 「甲片碰撞」「扫过」这类词会把普通镜头误判成打斗，所以要求分镜自己声明。
  if (!shot.appearance_lock) return out;

  const hairDry = /干燥|蓬松/.test(text);
  const hairBan = /发胶|湿发|油亮发丝|不结块/.test(text);
  if (shot.appearance_lock === "hair" || shot.appearance_lock === "full") {
    if (!hairDry || !hairBan) {
      out.push([
        "ERROR",
        "appearance_lock 要求控发型，但正文没写「干燥/蓬松」与「禁发胶/湿发」；模型会画成油头",
      ]);
    }
  }

  if (shot.appearance_lock === "body" || shot.appearance_lock === "full") {
    const hasLean = /纤细|清瘦|肩窄|四肢细|没有.{0,8}肌肉|不显.{0,4}肌肉/.test(text);
    const hasMuscleBan = /肌肉男|健美|粗壮手臂|暴突血管|胸肌轮廓|不被.{0,6}撑起|没有.{0,6}撑起/.test(text);
    if (!hasLean || !hasMuscleBan) {
      out.push([
        "ERROR",
        "appearance_lock 要求控体型，但正文没同时写「纤细清瘦」与「禁肌肉男/不被肌肉撑起」；模型会生成肌肉男",
      ]);
    }
  }
  return out;
}

/**
 * 时长依据里有没有把「并行动作」当串行相加。
 *
 * 这是实测踩过的坑：写「她扫腿 1 秒 + 他抬腿躲 1 秒」，但这两件事是同一瞬间发生的，
 * 相加得 2 秒，实际动作只有 1 秒——剩下的时间是空的，视频里会变成拖慢的动作回放。
 *
 * 判据：basis 里出现了表示同时/即时反应的词，却还在用「+」相加，就要警告。
 */
function checkParallelTiming(shot) {
  const out = [];
  const basis = shot.timing?.basis || "";
  if (!basis) return out;

  const hasParallelWord = /同时|并行|同步|即刻|同一瞬|那一刻|期间/.test(basis);
  const additive = (basis.match(/\+/g) || []).length;

  if (hasParallelWord && !/不另计时|不另计|不能相加|不能与.{0,8}相加|重复计算|同步发生/.test(basis)) {
    out.push([
      "WARN",
      "basis 里提到了同时/并行，但仍在用「+」相加；并行动作不能相加，否则会虚增时长、动作被拖慢",
    ]);
  }
  if (additive >= 4 && !hasParallelWord) {
    out.push([
      "WARN",
      `basis 里有 ${additive} 个加项；确认这些动作是不是真有先后，能并行的不要相加`,
    ]);
  }
  return out;
}

/**
 * 物理成立性：动作在真实身体上做不做得到。
 *
 * 这类错误审片抓不到（画面本身可以很漂亮），但观众一眼就觉得假。
 * 已实测踩过的两类：
 *  1. 空间不可能——人退向门口，却撞上了居中的立柱
 *  2. 体型矛盾——纤细女性压住成年人手臂并把他逼退（这是拼力气，违背人设）
 */
function checkPhysics(shot) {
  const out = [];
  const text = shot.h3?.integrated_multimodal_description || "";
  if (!text) return out;

  // 用力量压制对抗体型：细瘦角色不该靠力气压人
  const leanChar = /纤细|清瘦|骨架小/.test(text);
  const forcePress = /压住.{0,6}手臂|按住.{0,6}肩|把他逼退|逼回|架住|硬推|较力|扳|扛起|抱起/;
  if (leanChar && forcePress.test(text)) {
    out.push([
      "WARN",
      "细瘦角色却在做「压住/逼退/较力」这类靠力气取胜的动作；与体型设定矛盾。改为借力、让位、截断路线，而不是拼力量。",
    ]);
  }

  // 闪避词与命中词同时出现，容易自相矛盾。
  // 必须先剔掉负面约束：「女主轻松躲开」写在禁止项里，不是要求她躲开。
  const affirmativeText = text
    .replace(/负面约束[\s\S]*$/g, "")
    .replace(/必须避免[\s\S]*$/g, "");
  const dodge = /避开|躲开|闪过|让开|卸力|滑过/.test(affirmativeText);
  const hit = /命中|撞中|打实|擦中|正中/.test(affirmativeText);
  if (dodge && hit) {
    out.push([
      "WARN",
      "同一镜里既有「避开/让开」又有「命中/擦中」；确认是不是同一击既躲开又打中，这两者不能同时成立。",
    ]);
  }

  // 起身/落地类动作，前一镜结尾若是倒地姿态，本镜必须有起身
  const endsDown = /撑在.{0,6}地|倒地|滑落|坐地|跪/.test(text);
  return out;
}

/**
 * 多角色同框时，每个角色的服装都必须写清楚。
 *
 * 实测踩过的坑：某一镜的 image_prompt 只写了动作，没写任何人穿什么，
 * 模型就从参考图里"借"了一套——结果男主穿上了女主的浅蓝练功服。
 *
 * 审片抓不到这个，因为审片只对照 checks；如果 checks 里也没有服装项，
 * 一张穿帮图就会全票通过。
 */
function checkCostume(shot) {
  const out = [];
  const prompt = shot.image_prompt || "";
  const refs = Array.isArray(shot.ref) ? shot.ref : shot.ref ? [shot.ref] : [];
  const charRefs = refs.filter((r) => /char-/i.test(r));

  // 单角色镜：写了服装即可
  if (charRefs.length <= 1) {
    if (charRefs.length === 1 && !/穿|短袖|T恤|长裤|练功服|甲|袍|衣/.test(prompt)) {
      out.push(["WARN", "画面里有角色，但 image_prompt 没写他穿什么；模型会自己编"]);
    }
    return out;
  }

  // 多角色同框：必须有两套不同的服装描述
  const costumeWords = (prompt.match(/白色[^，。]{0,8}短袖|白T|浅灰蓝|交领练功服|黑色[^，。]{0,8}长裤|同色束脚/g) || []);
  if (costumeWords.length < 2) {
    out.push([
      "ERROR",
      "多角色同框，但 image_prompt 里只写了 " + costumeWords.length + " 套服装；模型会让两人穿成一样（实测会把男主画成女主那身练功服）",
    ]);
  }
  const checks = shot.checks || [];
  if (!checks.some((c) => /服装|白T|白色短袖|练功服/.test(c))) {
    out.push(["ERROR", "多角色同框，但 checks 里没有服装归属项；审片抓不到穿帮"]);
  }
  return out;
}

/**
 * 打戏力学自检（用户实测打回六条之后新增的）
 *
 * 抓的一类最致命的错：写了「姿态」但没写「力学」。
 *   错误：「她右臂推出、手臂伸直」→ 模型画成站立出手的雕塑
 *   正确：「髋先转、重心压前脚、躯干反向倾斜配重」→ 才画得出动作
 *
 * 还抓「一个人打、另一个人站着」：
 *   如果一击命中了，受击方必须有位移/变形/惯性滞后，缺一项就是站桩。
 */
const MECH = {
  // 发力方：重心
  weight: /重心|压到前脚|压在前脚|支撑腿|蹬地|抓地|脚掌踩实|髋部前顶|髋先转|转髋/,
  // 发力方：大关节带动（最重要的特征）
  kineticChain: /髋先|转髋|躯干带动|腰胯|从腰胯|从髋|髋部.{0,6}(展开|启动|发力|顶|转)|大关节|躯干先|肩带动|由髋/,
  // 发力方：躯干配重/倾斜
  counterBalance: /配重|上身后仰|身后压|肩线后|躯干向.{0,4}倾斜|反方向/,
  // 受力方：变形
  deform: /凹陷|内凹|压进|挤压变形|被压平|挤出|起褶|放射状/,
  // 受力方：位移
  displace: /离地|被顶|向后退|后仰|被带得|甩开|飞出|后退|侧移|蹭出/,
  // 受力方：惯性滞后
  lag: /惯性|滞后|慢半拍|来不及|还在原地|才跟上/,
  // 环境
  env: /飞散|炸开|扬起|腾起|震得|震颤|冲开|掀|飘起/,
};

function checkImpactMechanics(shot) {
  const out = [];
  const text = [
    shot.h3?.integrated_multimodal_description || "",
    ...(shot.beats || []).map((b) => b.frame_prompt || ""),
    shot.image_prompt || "",
  ].join("\n");
  if (!text) return out;

  const isCombat = /踢|拳|肘|掌|撞|击|扫|劈|打中|命中/.test(text);
  if (!isCombat) return out;

  // 必须先剔掉负面约束段：「不许僵直站立」「no reaction to impact」这类禁止项
  // 会被当成"已写到"，从而误判为合格。这里是实测踩过的坑。
  const affirmative = text
    .replace(/负面约束[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/【硬约束】[\s\S]*?(?=\n\n|$)/g, "");

  const hasImpact = /接触点|命中|正中|撞上|顶在|砸在|顶进/.test(affirmative);
  if (!hasImpact) return out;

  const missing = [];
  if (!MECH.weight.test(affirmative)) missing.push("发力方的重心（压在哪条腿、支撑腿是否蹬地）");
  if (!MECH.kineticChain.test(affirmative)) missing.push("大关节带动小关节（髋/躯干先动，而不是只写手臂或腿伸出去）");
  if (!MECH.counterBalance.test(affirmative)) missing.push("躯干配重（真实出招时上身必定向反方向压住）");
  if (!MECH.deform.test(affirmative)) missing.push("受击部位的变形（内凹、压进、布料起放射褶）");
  if (!MECH.displace.test(affirmative)) missing.push("受击方的位移（离地、后退、被顶飞，不能原地不动）");
  if (!MECH.lag.test(affirmative)) missing.push("惯性滞后（头颈与手臂慢半拍，才不像贴纸）");
  if (!MECH.env.test(affirmative)) missing.push("环境反馈（扬尘、草屑、布料被气浪掀）");

  if (missing.length) {
    out.push([
      "ERROR",
      "打戏缺力学要素；只写姿态模型必然画成摆拍。缺：" + missing.join("；"),
    ]);
  }
  return out;
}

/**
 * 镜头多样性自检。
 *
 * 用户实地指出：「打戏分镜不一定每个分镜都要两人在镜头内」，
 * 而且「经常有这种，一人攻击姿势，另一个就完全站着」。
 *
 * 一个多帧镜头如果每一帧都是「两人同框全景」，就是流水账：
 * 看不出力量传导，构图单调，而且必然出现一个人当背景板。
 */
function checkShotVariety(shot) {
  const out = [];
  const beats = shot.beats || [];
  if (beats.length < 3) return out;

  const isCombat = /踢|拳|肘|掌|撞|扫|劈|打|击/.test(
    [shot.title, shot.intent, shot.h3?.integrated_multimodal_description]
      .filter(Boolean)
      .join(" ")
  );
  if (!isCombat) return out;

  const frameCameras = beats.map((b) => (b.camera || "").trim()).filter(Boolean);
  if (frameCameras.length === beats.length) {
    const uniq = new Set(frameCameras);
    if (uniq.size < Math.min(3, beats.length)) {
      out.push([
        "WARN",
        `本镜 ${beats.length} 帧只有 ${uniq.size} 种机位/景别；打戏应至少三种（特写/单人/过肩/全景）`,
      ]);
    }
  }

  // 每一帧都写「与同镜其他帧机位完全一致」＝自我锁死成同一个全景
  const frozen = beats.filter((b) => /与同一镜的其他帧完全一致/.test(b.frame_prompt || ""));
  if (frozen.length >= Math.min(3, beats.length)) {
    out.push([
      "ERROR",
      `${frozen.length} 帧都要求「机位与同镜其他帧完全一致」；这会把整个镜头锁成一个双人全景，` +
        "必然出现「一人出招、另一人站着」。改用撞击特写 / 单人镜 / 环境反应镜。",
    ]);
  }

  // 命中之后还有多帧时，至少有一帧应该只有受击方
  // （用是否出现"单人镜/出画/不出现"判断）
  const soloMarked = beats.filter((b) => /单人镜|出画|不出现|看不到.{0,4}脸|不出现任何脸/.test(b.frame_prompt || ""));
  if (soloMarked.length === 0 && beats.length >= 3) {
    out.push([
      "WARN",
      "本镜所有帧都是双人同框；建议至少一帧是撞击特写或单人反应镜",
    ]);
  }
  return out;
}

/** 时长合理性 */
function checkTiming(shot) {
  const out = [];
  const t = shot.timing;
  const hasSpeech = /<d>\[/.test(shot.h3?.integrated_multimodal_description || "");
  if (!t) {
    out.push(["WARN", "缺少 timing 字段，无法审计时长"]);
    return out;
  }
  // 无台词镜：三项本来就是 0，时长由动作撑，不该拿三项之和去比
  if (!hasSpeech) return out;

  const computed = (t.speech_sec || 0) + (t.pause_sec || 0) + (t.margin_sec || 0);
  const declared = Number(shot.duration) || 0;
  if (Math.abs(computed - declared) > 0.51) {
    out.push([
      "ERROR",
      `timing 三项之和 ${computed.toFixed(1)}s 与 duration ${declared}s 不一致（差 ${(declared - computed).toFixed(1)}s）`,
    ]);
  }
  if (declared > 10) {
    out.push(["WARN", `时长 ${declared}s 偏长，确认不是注水`]);
  }
  return out;
}

/** 参考图用途是否写明 */
function checkRefUsage(shot) {
  const out = [];
  const refs = Array.isArray(shot.ref) ? shot.ref : shot.ref ? [shot.ref] : [];
  const uses = shot.picture_use || [];
  if (refs.length && uses.length !== refs.length) {
    out.push([
      "ERROR",
      `ref 有 ${refs.length} 张，但 picture_use 只写了 ${uses.length} 条；用途必须逐张对应`,
    ]);
  }
  return out;
}

function lint(projDir) {
  const specPath = path.join(projDir, "00-spec", "shots.json");
  const raw = fs.readFileSync(specPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { fatal: `shots.json 不是合法 JSON：${e.message}`, results: [] };
  }
  const shots = data.shots || data;
  const results = [];

  for (const s of shots) {
    const findings = [];
    // 转身方向只检查「动作描述」：image_prompt 写的是首帧静态起点，
    // 里面出现「头朝画面左侧」是正常的，拿来和终点姿态对比只会误报。
    const motionText = [
      s.h3?.integrated_multimodal_description || "",
      s.what_moves || "",
      s.title || "",
      s.intent || "",
    ].join("\n");
    const allText = [
      s.image_prompt || "",
      motionText,
      (s.checks || []).join(" "),
    ].join("\n");

    findings.push(...checkTurn(motionText));
    findings.push(...checkRequired(s));
    findings.push(...checkBodyAndHair(s));
    findings.push(...checkPictureRefs(s));
    findings.push(...checkNarrative(s));
    findings.push(...checkInflation(s));
    findings.push(...checkParallelTiming(s));
    findings.push(...checkPhysics(s));
    findings.push(...checkImpactMechanics(s));
    findings.push(...checkShotVariety(s));
    findings.push(...checkCostume(s));
    findings.push(...checkLastFrameScope(s));
    findings.push(...checkTiming(s));
    findings.push(...checkRefUsage(s));

    if (findings.length) results.push({ id: s.id, title: s.title, findings });
  }
  return { results, total: shots.length };
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const projArg = get("--project");
  const asJson = argv.includes("--json");

  if (!projArg) {
    console.error("用法: node lint_shots.js --project projects/song [--json]");
    process.exit(1);
  }
  const projDir = path.resolve(PROJECT_ROOT, projArg);
  const r = lint(projDir);

  if (r.fatal) {
    console.error(C.red("解析失败：" + r.fatal));
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    if (!r.results.length) {
      console.log(C.bold(`检查 ${r.total} 个镜头，未发现问题。`));
      process.exit(0);
    }
    console.log(C.bold(`检查 ${r.total} 个镜头，${r.results.length} 个有问题：`) + "\n");
    for (const it of r.results) {
      console.log(C.bold(`${it.id}  ${C.dim(it.title || "")}`));
      for (const [level, msg] of it.findings) {
        const tag = level === "ERROR" ? C.red("ERROR") : C.yellow("WARN ");
        console.log(`  ${tag}  ${msg}`);
      }
      console.log("");
    }
  }

  const hasError = r.results.some((it) => it.findings.some(([l]) => l === "ERROR"));
  process.exit(hasError ? 1 : 0);
}

module.exports = { lint, checkTurn };

if (require.main === module) main();
