# 完整范例

两个范例都走完整三步：判断类型 → 分镜表 → 平台提示词。

> 语言说明：下列 H3 范例以英文书写，仅为展示结构、运镜嵌法与音效/配乐的写法。**实际输出一律中文**，只有字段名、运镜短语、时间戳、台词标记与 `<Picture N>` 保留英文。中文写法见文末「中文输出示例」。

---

## 范例一：文戏

输入：深夜便利店，加班的女主遇到前男友，两人都没说话，他放下一瓶水就走了。

### 第一步：类型判断

文戏。核心是“没说的话”，靠视线回避与手部小动作承载；全场无对话，节奏要慢，镜头要克制。

### 第二步：分镜表

| 镜头编号 | 景别 | 运镜方式 | 画面内容 | 人物表演拆解 | 光影氛围 |
|---|---|---|---|---|---|
| S01 | 中景 | 固定 | 深夜便利店冷柜前，货架灯管有一支微微闪烁，地面反着冷白光，收银台方向无人 | 她站定在饮料柜前；视线在矿泉水与咖啡之间摇摆；眉心轻蹙；左手握着手机、指节发白；重心落在右脚，左脚虚点地面 | 顶部冷白日光灯直射，高对比，后景货架形成规则光带 |
| S02 | 过肩（她的肩） | 微推 | 视线方向出现一个男人背影，深灰外套，肩线微垂，停在货架尽头 | 她的肩部突然收紧半拍；呼吸短暂停顿；视线从货架斜移到他手上又立刻垂下；右手拇指在手机边框摩挲 | 前侧光，他的背影压在暗部，冷柜蓝光勾出轮廓边缘 |
| S03 | 近景 | 固定 | 两人侧向站在同一排货架两端，中间隔着三米空通道 | 他侧脸朝向货架、下颌绷紧；她抬眼看他一次、不到一秒就收回；嘴唇开合一次但没有声音；重心从右脚换到左脚 | 两人各被一侧灯管照亮，中间通道留有暗区 |
| S04 | 特写 | 微推 | 他手掌把一瓶矿泉水放在她那一侧的货架边缘，瓶身带冷凝水珠 | 手指离开瓶身前停顿半拍；指腹在瓶盖上轻按一下；视线始终没有抬向她 | 侧逆光，水珠高光点点，暗背景里瓶身是唯一亮点 |
| S05 | 大特写 | 固定 | 她垂在身侧的手，指尖离瓶身两厘米 | 指尖轻微颤动后收回，握成松拳；指甲在掌心留下浅痕 | 极浅景深，背景灯管化为冷白圆斑 |
| S06 | 全景 | 固定（后拉） | 便利店玻璃门滑开，他的背影走出门外，门外是湿的柏油路和远处车灯拉出的光带 | 她保持原站姿不动，只有头部跟随门的方向偏转五度；肩线缓慢塌下 | 店内冷白与店外暖橙车灯形成冷暖对切，玻璃反射叠影 |

总时长约 26 秒，6 镜。

### 第三步：平台提示词

（用户选择 MiniMax H3）

```text
integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium shot frames a young woman in a rumpled work shirt standing in front of a refrigerated drinks case inside a late-night convenience store, one fluorescent tube in the ceiling flickering softly above her. Her gaze drifts between the mineral water and the canned coffee, her brow tightening faintly, her left hand gripping a phone until the knuckles pale, her weight settled on her right foot with the left toe barely touching the floor. [Shot 2] At 00:04.000, the camera cuts to an over-the-shoulder view from behind her as the camera pushes in with small amplitude at slow speed toward a man in a dark grey coat standing at the far end of the aisle with his shoulders slightly sunken. Her shoulders tighten for half a beat and her breathing stops, her gaze sliding to his hand and dropping away immediately while her right thumb rubs the edge of the phone. [Shot 3] At 00:09.500, the camera cuts to a medium close shot in profile, the two of them standing three meters apart at opposite ends of the same shelf, a pool of shadow between them. His jaw stays clenched as he faces the shelf; she lifts her eyes to him for less than a second and looks away, her lips parting once without a sound, her weight shifting from one foot to the other. [Shot 4] At 00:15.000, the camera cuts to a close shot of his hand setting a bottle of mineral water on the edge of the shelf beside her, condensation beading on the plastic, as the camera pushes in with small amplitude at slow speed; his fingers pause before leaving the bottle and press once on the cap, his eyes never rising toward her. [Shot 5] At 00:19.500, the camera cuts to an extreme close-up of her hand hanging at her side, her fingertips stopping two centimeters from the bottle, trembling once before curling into a loose fist, her nails leaving faint marks on her palm. [Shot 6] At 00:22.000, the camera cuts to a wide shot of the automatic glass doors sliding open as he walks out into a wet asphalt street streaked with distant headlights; she stays exactly where she is, her head turning five degrees toward the door, her shoulders slowly caving in, and the camera pulls out with small amplitude at slow speed as the glass reflects her twice over.

overall_soundscape: A low refrigerator hum runs continuously under the steady buzz of fluorescent tubes, one of them ticking faintly as it flickers. A bottle taps softly against the shelf edge, and the automatic door slides open with a pneumatic hiss, letting in the muffled wash of wet tires on asphalt before the door closes again into quiet.

non_diegetic_music: Sparse single piano notes at a slow tempo with long gaps between them, joined near the end by a sustained low string note that grows slightly louder before cutting off abruptly on the door closing.
```

注意：全部运镜只用了 `pushes in with small amplitude at slow speed`、`pulls out with small amplitude at slow speed`、以及不带运镜的固定机位（由 cut 引出，未额外写镜头运动）。

---

## 范例二：打戏

输入：雨夜巷子里，女主被两人围住，她用一把折叠伞反击脱身。

### 第一步：类型判断

打戏（含开头两秒文戏张力）。核心是空间交代清楚、势能衔接、受击方向明确；伞是唯一武器，必须交代展开与收合两个状态。

### 第二步：分镜表

| 镜头编号 | 景别 | 运镜方式 | 画面内容 | 人物表演拆解 | 光影氛围 |
|---|---|---|---|---|---|
| S01 | 全景 | 横移左（慢） | 雨夜窄巷，两侧墙面贴满剥落广告，地面积水映着远处便利店招牌；两个男人一前一后把她夹在中间 | 她背靠墙、伞收在右手、肘部微屈；视线快速扫过两人脚下距离；重心压低、双脚与肩同宽，前脚掌着地 | 单一钠灯顶光，湿墙高反光，雨水在光锥内可见为斜线 |
| S02 | 中近景 | 固定 | 前方男人抬手抓向她肩 | 她下颌微收、视线锁定他的手而非脸；左肩先向后让开两厘米，右手伞尖下沉蓄力 | 侧逆光，肩部轮廓亮，面部落入半暗 |
| S03 | 近景 | 手持微晃 | 伞尖自下而上击中对方手腕 | 她发力时腰胯先转、手臂跟随；对方手腕外翻、身体向右后方偏；雨水被甩出一片弧线 | 顶光下飞溅水珠形成密集亮点，画面轻微抖动 |
| S04 | 中景 | 跟（快） | 后方男人扑上，她向左侧横移半步并拉开伞面 | 她步幅小而重心稳定、落地脚掌先着地；拇指顶开伞骨，伞面在身前撑开约三分之二；视线已提前转向身后 | 伞面挡住主光源，在她脸上投下条纹状阴影 |
| S05 | 全景 | 环绕（大幅） | 她借伞面遮挡绕到墙侧，两人撞在一起 | 她绕过时上身压低、步态贴墙、肩膀擦过砖面；对方两人因惯性前冲、重心交错、脚步打滑 | 环绕中光源角度持续变化，墙面明暗交替扫过 |
| S06 | 中景 | 后拉 | 她收伞快步跑向巷口，积水被脚步踩开 | 她收伞动作连贯、手臂贴身、步频加快；头部不回头，视线锁定巷口 | 巷口暖光形成出口感，背影渐暗，雨幕在她身后变密 |

总时长约 22 秒，6 镜。

### 第三步：平台提示词

（用户选择可灵）

**S01（约 5 秒）**
雨夜窄巷，湿透的墙面上贴着剥落的广告纸，地面积水倒映着远处便利店的暖色招牌。一名穿深色夹克的年轻女性背靠砖墙站着，右手握着一把收起的黑色折叠伞，肘部微屈，双脚与肩同宽，前脚掌着地，重心压得很低，视线快速扫过面前两名男子的脚下。镜头从左向右缓慢横移，把三人之间的距离完整交代出来。头顶一盏钠灯直射而下，雨丝在光锥里清晰可见。

**S02（约 4 秒）**
中近景，雨夜巷内，前景男子的一只手抬起伸向她的肩膀。她下颌微收，视线锁住那只手，没有看他的脸；左肩先向后让开，右手握着的伞尖同时向下沉。镜头保持固定，钠灯从侧后方照来，只有她的肩线和湿发边缘被照亮，面部大半落在阴影里。

**S03（约 3 秒）**
近景手持轻微晃动，伞尖从下方击在男子手腕上。她腰部先转动，手臂跟着甩出；男子手腕向外翻开，上半身向右后方偏斜，积水被脚步踢起一片水花，水珠在灯光下连成一串亮点。镜头随冲击轻微抖动。

**S04（约 4 秒）**
中景跟随，她向左侧横移半步，同时拇指顶开伞骨，黑色伞面在身前撑开大半。她步幅很小但落脚稳定，脚掌先着地；视线已经提前转向身后。镜头快速跟着她平移，伞面挡住头顶钠灯，在她脸上投下几道条纹阴影。

**S05（约 3 秒）**
全景环绕，她借伞面遮住视线，沿墙侧绕行到侧面，两名男子因为向前冲的惯性撞在一起，脚步在积水里打滑。她经过时上身压低，肩膀擦过砖墙。镜头大幅度绕着她走弧线，墙面上的明暗随角度不断扫过。

**S06（约 3 秒）**
中景后拉，她合上伞，手臂贴紧身体，快步跑向巷口，脚下积水被踩开。她始终没有回头，视线一直盯着巷口。镜头慢慢向后拉开，巷口的暖光成为画面里唯一的亮处，她的背影逐渐变暗，身后的雨幕变得更密。

注意：没有出现“激烈”“惊险”“帅气”这类抽象词；每个动作都写了起点、发力方向和落点。

---

## 中文输出示例（正式输出请照此格式）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] 实拍质感、电影感。镜头从夜间行驶的出租车后厢内略微偏侧拍出全景：画面右侧是后座，磨损的皮面在缝线处有明显开裂，门板上是银色把手与儿童锁拨钮，座椅缝隙里卡着一枚硬币。一名二十七八岁的女性穿着深色外套坐在右侧车门边，背部没有靠实椅背，双脚并拢，右手搭在膝上手机的边缘，一根指尖在边框上来回摩挲，下颌微内收。车窗外路灯以均匀节奏掠过，在车厢内扫出宽阔的冷白色横条；仪表盘幽绿色数字显示 01:47，是画面里唯一稳定的光源。The camera holds a static shot. [Shot 2] At 00:06.000，切至她侧脸近景，The camera pushes in with small amplitude at slow speed 朝她脸颊缓缓推进；掠过的路灯在她脸上切出忽明忽暗的光条。她的视线从车窗抬起一次转向画面左上方，眼睑抬起而眉毛不动，呼吸变浅，颈部转动不到一度。

overall_soundscape: 持续的引擎低鸣与轮胎碾过沥青的声响铺在底下，转向灯的滴答声以均匀间隔反复响起。暖风机持续送风，皮革随重心移动发出轻微吱声。接近结尾时，门把手发出一声短促的干涩咔哒，转向灯随之停止。

non_diegetic_music: 一条持续的低频合成器长音以缓慢速度铺底，几乎没有起伏；中段加入一个弓弦大提琴音，以固定慢速脉冲重复，每次略有加重。最后六秒进入一个高而细的音，音高上行后骤然切断。
```

要点：字段名、运镜短语、时间戳、`<Picture N>` 保持英文；画面、音效、配乐全部中文；三段之间空一行。
