#!/bin/sh
# 截图用的中英混排样例：中文、全角标点、emoji、按显示宽度对齐的列
printf '中英混排：SuperHive 桌面端内置终端 terminal（全角标点，。！？：；「」）\n'
printf 'emoji：✅ 通过  🚀 发布  ⚠️ 警告  👍 好  —— 结束\n'
printf '%s\n' '名称        状态    说明' 'rd-claude   在线    通用协作 Agent' '测试机器人  离线    windows 巡检' 'glm2        忙碌    review 中'
printf '%s\n' '|1234567890|' '|一二三四五|' '|ab中文cd12|'
# 长行：中文、全角标点和英文混排，折行后每行都写到右边界（看最右一列有没有被切）
printf '%s%s%s\n' '长行：桌面端内置终端，中英混排「全角标点」（括号）、顿号；SuperHive terminal 写满到右边界。' \
  '接口出现，IPC 逐个校验顶层框架与本机回环来源；sandbox/contextIsolation、禁跳转。' \
  '一二三四五六七八九十，一二三四五六七八九十；abc 一二三四五六七八九十。'
