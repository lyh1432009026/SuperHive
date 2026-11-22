// 分镜：每个镜头用哪段录屏、从第几秒到第几秒、加速多少、配什么字幕。
// 字幕的 at / to 是这一段成片里的秒数（加速之后）；to 省略就到段尾前 0.2 秒。
// 改这里只需要重跑合成（make.mjs --skip-record），不用重录。

export const MAIN = [
  {
    clip: "hero",
    from: 0.3,
    to: 5.6,
    captions: [{ chapter: "SuperHive", text: "把人和 Agent，带进<b>同一间工作室</b>", at: 1.2 }],
  },
  {
    clip: "solo",
    from: 0.4,
    to: 8.4,
    captions: [
      { chapter: "单人", text: "手机上派活，一支 Agent 队伍<b>自己拆分、委派、交回</b>", at: 0.6 },
    ],
  },
  {
    clip: "team",
    from: 0.4,
    to: 7.6,
    captions: [
      { chapter: "多人", text: "每个人带着自己的 Agent，在<b>同一个房间</b>里协作", at: 0.6 },
    ],
  },
  {
    clip: "overview",
    from: 0.3,
    to: 6.6,
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
    speed: 2,
    captions: [
      { chapter: "派活", text: "在房间里 <b>@claude-1</b>，把结算页改版交给它", at: 0.3, to: 3.4 },
      {
        chapter: "委派",
        text: "它拆成三路，<b>委派</b>给 codex-1、copilot-1、opencode-1",
        at: 3.6,
        to: 6.8,
      },
      { chapter: "回执", text: "子任务做完<b>自动回执</b>，claude-1 汇总给你", at: 7.0 },
    ],
  },
  {
    clip: "progress",
    from: 0.3,
    to: 6.4,
    captions: [{ chapter: "进展", text: "等你处理、在做、最近完成，<b>一眼看清</b>", at: 0.4 }],
  },
  {
    clip: "designs",
    from: 0.3,
    speed: 2.4,
    captions: [
      { chapter: "附件", text: "回复里直接带<b>设计稿图片</b>，点开就能看", at: 0.3, to: 6.0 },
      { chapter: "等你决定", text: "要你拍板时，<b>点一下选项</b>就行", at: 6.2, to: 8.8 },
      { chapter: "接着做", text: "选完 Agent <b>立刻接着干</b>，白板同步更新", at: 9.0 },
    ],
  },
  {
    clip: "artifacts",
    from: 0.3,
    speed: 1.7,
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
      {
        chapter: "代码",
        text: "改动、diff 和<b>每个 Agent 的任务线分支</b>，房间里直接看",
        at: 0.4,
      },
    ],
  },
  {
    clip: "schedules",
    to: 6.6,
    from: 0.3,
    captions: [{ chapter: "定时", text: "定时任务：<b>到点自动叫醒 Agent</b>", at: 0.4 }],
  },
  {
    clip: "invite",
    from: 0.3,
    speed: 1.25,
    captions: [{ chapter: "邀请", text: "<b>一条链接</b>邀请同事进房间", at: 0.3 }],
  },
  {
    clip: "agent",
    from: 0.3,
    speed: 1.8,
    captions: [
      { chapter: "接入", text: "选好 CLI 和权限，<b>一键在本机启动</b>新的 Agent", at: 0.3 },
    ],
  },
  {
    clip: "im",
    from: 0.3,
    speed: 1.9,
    captions: [{ chapter: "飞书", text: "<b>扫码连接飞书</b>，手机上也能派活、回答问题", at: 0.4 }],
  },
  { clip: "outro", from: 0.2, to: 5.2, captions: [] },
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
    speed: 3,
    captions: [
      { chapter: "委派", text: "@ 一个 Agent，它再<b>委派</b>给其他 Agent，结果自动汇总", at: 0.3 },
    ],
  },
  {
    clip: "designs",
    from: 15.0,
    speed: 2.2,
    captions: [{ chapter: "等你决定", text: "要你拍板时，<b>点一下</b>就行", at: 0.3 }],
  },
  {
    clip: "im",
    from: 1.0,
    speed: 2,
    captions: [{ chapter: "飞书", text: "<b>扫码连接飞书</b>，手机上也能指挥", at: 0.3 }],
  },
  { clip: "outro", from: 0.2, to: 5.0, captions: [] },
];
