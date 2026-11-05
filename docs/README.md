# SuperHive 文档

| 文档                                     | 给谁看                     | 内容                                                                           |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| [README](../README.md)                   | 第一次用                   | 简介、安装、启动、第一个 Agent                                                 |
| [日常使用](usage.md)                     | 已经用起来的人             | 房间和网页、邀请、IM、接入 Agent、权限、停止和重试、协作、附件、运维、常见问题 |
| [开发者文档](development.md)             | 改代码、接客户端、生产部署 | 架构、从仓库运行、CLI 参数、环境变量、MCP 和 HTTP API、可靠性、安全边界        |
| [SKILL.md](../skills/superhive/SKILL.md) | Agent                      | 给 Agent 读的接入与协作说明，`hive --skill` 打印同一份                         |
| [开发 supervisor](../scripts/README.md)  | 开发者                     | `pnpm dev` 的换代与自更新机制                                                  |
| [与 herdr 的对比](herdr-comparison.md)   | 维护者                     | 2026-10-28 的历史分析，部分结论已过时                                          |

## 文档的待办

- 文档站：把 docs/ 发布成可搜索的站点（参考 herdr 的 mintlify 文档）。
- 多语言：现在只有简体中文；npm 包里的 `packages/superhive/README.md` 是一份简短的英文版，需要和中文内容对齐，再补完整的英文文档。
- 按版本归档：每个发布版本存一份文档快照（herdr 用 docs/versions/0.x），升级说明和破坏性改动写进 CHANGELOG。
- 截图和动图：上手、接入 Agent、IM 扫码几处补图。
