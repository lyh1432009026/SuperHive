// 分镜：每个镜头用哪段录屏、从第几秒到第几秒、加速多少、配什么字幕。
// 字幕的 at / to 是这一段成片里的秒数（加速之后）；to 省略就到段尾前 0.2 秒。
// 每句字幕至少留 2.5 秒阅读时间。
// 改这里只需要重跑合成（make.mjs --skip-record），不用重录。

export const MAIN = [
  {
    clip: "hero",
    from: 0.3,
    to: 6.3,
    captions: [{ chapter: "SuperHive", text: "把人和 Agent，带进<b>同一间工作室</b>", at: 1.0 }],
  },
  {
    clip: "solo",
    from: 0.4,
    to: 12.4,
    captions: [
      { chapter: "单人", text: "手机上派活，一支 Agent 队伍<b>自己拆分、委派、交回</b>", at: 0.6 },
    ],
  },
  {
    clip: "team",
    from: 0.4,
    to: 10.9,
    captions: [
      { chapter: "多人", text: "每个人带着自己的 Agent，在<b>同一个房间</b>里协作", at: 0.6 },
    ],
  },
  {
    clip: "overview",
    from: 0.3,
    to: 8.3,
    captions: [
      {
        chapter: "工作台",
        text: "8 个房间、12 个 Agent：claude、codex、copilot、omp、opencode <b>同场干活</b>",
        at: 0.4,
      },
    ],
  },
  {
    clip: "delegate",
    from: 0.3,
    speed: 1.4,
    captions: [
      { chapter: "派活", text: "在房间里 <b>@claude-1</b>，把结算页改版交给它", at: 0.3, to: 4.4 },
      {
        chapter: "委派",
        text: "它拆成三路，<b>委派</b>给 codex-1、copilot-1、opencode-1",
        at: 4.6,
        to: 8.6,
      },
      { chapter: "并行", text: "三个 Agent <b>同时开工</b>，执行过程实时可见", at: 8.8, to: 13.2 },
      { chapter: "回执", text: "子任务做完<b>自动回执</b>，claude-1 汇总给你", at: 13.4 },
    ],
  },
  {
    clip: "live",
    from: 0.3,
    speed: 1.3,
    captions: [
      {
        chapter: "执行过程",
        text: "搜索、读文件、改代码、跑测试，<b>每一步都看得见</b>",
        at: 0.3,
        to: 10.6,
      },
      { chapter: "白板", text: "Agent 自己在白板登记，<b>进展里的状态自动更新</b>", at: 10.8 },
    ],
  },
  {
    clip: "progress",
    from: 0.3,
    to: 8.3,
    captions: [{ chapter: "进展", text: "等你处理、在做、最近完成，<b>一眼看清</b>", at: 0.4 }],
  },
  {
    clip: "designs",
    from: 0.3,
    speed: 1.9,
    captions: [
      { chapter: "附件", text: "回复里直接带<b>设计稿图片</b>，点开就能看", at: 0.3, to: 9.4 },
      { chapter: "等你决定", text: "要你拍板时，<b>点一下选项</b>就行", at: 9.6, to: 12.6 },
      { chapter: "接着做", text: "选完 Agent <b>立刻接着干</b>，白板同步更新", at: 12.8 },
    ],
  },
  {
    clip: "artifacts",
    from: 0.3,
    speed: 1.6,
    captions: [
      {
        chapter: "产物",
        text: "文档、图片、代码集中一处，<b>停靠右侧栏</b>，用本机应用打开",
        at: 0.4,
      },
    ],
  },
  {
    clip: "code",
    from: 0.3,
    speed: 1.6,
    captions: [
      { chapter: "代码", text: "改了哪些文件、<b>diff</b> 怎么改，房间里直接看", at: 0.4, to: 5.6 },
      { chapter: "任务线", text: "每个 Agent 一条<b>任务线分支</b>，互不干扰", at: 5.8 },
    ],
  },
  {
    clip: "schedules",
    from: 0.3,
    to: 6.8,
    captions: [{ chapter: "定时", text: "定时任务：<b>到点自动叫醒 Agent</b>", at: 0.4 }],
  },
  {
    clip: "invite",
    from: 0.3,
    speed: 1.45,
    captions: [
      { chapter: "邀请", text: "<b>一条链接</b>邀请同事进房间", at: 0.3, to: 5.0 },
      { chapter: "接入", text: "选好 CLI 和权限，<b>一键在本机启动</b>新的 Agent", at: 5.2 },
    ],
  },
  {
    clip: "i18n",
    from: 0.3,
    speed: 2,
    captions: [{ chapter: "中 / EN", text: "界面<b>中英文随时切换</b>，只影响你自己", at: 0.3 }],
  },
  {
    clip: "im",
    from: 0.3,
    speed: 1.7,
    captions: [{ chapter: "飞书", text: "<b>扫码连接飞书</b>，手机上也能派活、回答问题", at: 0.4 }],
  },
  { clip: "outro", from: 0.2, to: 5.8, captions: [] },
];

/** 约 30 秒的精简版：开场、单人流转、派活委派、点选、飞书、结尾 */
export const SHORT = [
  {
    clip: "hero",
    from: 0.3,
    to: 4.2,
    captions: [{ chapter: "SuperHive", text: "把人和 Agent，带进<b>同一间工作室</b>", at: 0.8 }],
  },
  {
    clip: "solo",
    from: 2.2,
    to: 7.4,
    captions: [{ chapter: "单人", text: "一支 Agent 队伍<b>自己拆分、委派、交回</b>", at: 0.3 }],
  },
  {
    clip: "delegate",
    from: 3.0,
    speed: 3.6,
    captions: [
      { chapter: "委派", text: "@ 一个 Agent，它再<b>委派</b>给其他 Agent，结果自动汇总", at: 0.3 },
    ],
  },
  {
    clip: "designs",
    from: 17.0,
    speed: 2.6,
    captions: [{ chapter: "等你决定", text: "要你拍板时，<b>点一下</b>就行", at: 0.3 }],
  },
  {
    clip: "im",
    from: 1.0,
    speed: 2.4,
    captions: [{ chapter: "飞书", text: "<b>扫码连接飞书</b>，手机上也能指挥", at: 0.3 }],
  },
  { clip: "outro", from: 0.2, to: 5.0, captions: [] },
];
