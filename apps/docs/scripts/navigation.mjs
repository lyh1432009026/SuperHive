export const navigation = [
  {
    label: "开始使用",
    items: [
      { label: "快速上手", slug: "start/quickstart" },
      { label: "安装与更新", slug: "start/installation" },
      { label: "功能地图", slug: "start/overview" },
    ],
  },
  {
    label: "使用指南",
    items: [
      { label: "接入 Agent", slug: "guides/agents" },
      { label: "权限与审批", slug: "guides/permissions" },
      { label: "房间与成员", slug: "guides/rooms" },
      { label: "消息与附件", slug: "guides/messaging" },
      { label: "委派、白板与提问", slug: "guides/collaboration" },
      { label: "任务状态与恢复", slug: "guides/tasks" },
      { label: "独立任务工作区", slug: "guides/worktrees" },
      { label: "飞书与微信", slug: "guides/im" },
      { label: "用量与费用", slug: "guides/usage" },
    ],
  },
  {
    label: "部署与参考",
    items: [
      { label: "部署 Hive 服务", slug: "reference/deployment" },
      { label: "部署文档站", slug: "reference/documentation" },
      { label: "CLI 速查", slug: "reference/cli" },
      { label: "常见问题", slug: "reference/troubleshooting" },
      { label: "安全边界", slug: "reference/security" },
      { label: "开发与扩展", slug: "reference/development" },
    ],
  },
];

export const expectedRoutes = [
  "",
  ...navigation.flatMap((group) => group.items.map((item) => `${item.slug}/`)),
];
