// 英文界面截图（screens --locale en）用：演示 Server 里的中文演示数据，截图时在页面上换成英文。
// 演示 Server 本身不动；界面文字由网页自己的英文版负责，这里只管人名、消息、白板这些演示内容。
// 匹配按长度从长到短在文字节点里替换；一段 Markdown 被加粗、代码拆开时，按拆开后的片段各写一条。

/** 整个文字节点等于它时才换（头像里的单字） */
export const EXACT = {
  林: "L",
  周: "Z",
  陈: "C",
  // 规范里的短标题、表头和被加粗、代码拆开的片段，单独成段时才换，免得误伤长句
  分: "cents",
  显示: "Display",
  场景: "Case",
  示例: "Example",
  写法: "How",
  免费: "Free",
  舍入: "Rounding",
  "。": ".",
  里的: "in",
};

export const TEXT = {
  // 人和 Agent 简介
  林夏: "Lin",
  周屿: "Zhou",
  陈默: "Chen",
  "架构设计与代码 review": "Architecture and code review",
  "写代码、修 bug、补测试": "Code, bug fixes and tests",
  运维脚本与环境巡检: "Ops scripts and environment checks",
  文档与小改动: "Docs and small changes",
  演示仓库: "Demo repository",

  // #design 交付的规范（Markdown 预览）
  结算页金额显示规范: "Checkout price display guidelines",
  "金额显示规范.md": "price-display-guidelines.md",
  存储与计算: "Storage and calculation",
  金额一律按: "Store every amount in ",
  "存成整数，计算过程中不出现小数。": " as an integer; no decimals during calculation.",
  "只在显示时格式化，接口返回的也是分。": "Format only for display; APIs also return cents.",
  普通金额: "Regular amount",
  "优惠、退款": "Discount, refund",
  负号放在货币符号前: "Minus sign before the currency symbol",
  "不写成「免费」，避免和活动文案混淆": "Don't write “Free”, to avoid confusion with promo copy",
  千分位和货币符号统一用: "Use ",
  "移动端和 PC 端共用": "Mobile and desktop share ",
  "，不各自手拼。": "; don't hand-build strings.",
  "优惠分摊到每件商品时按分四舍五入，差额记到最后一件，合计和订单服务一致。":
    "When spreading a discount across items, round to the cent and put the remainder on the last item, matching the order service.",
  现在有出入的地方: "Current mismatches",
  "移动端结算页手拼「¥」+": "Mobile checkout hand-builds “¥” + ",
  "，没有千分位。": " with no thousands separators.",
  "订单详情页的优惠显示成「- ¥20」，少了小数位。":
    "Order details shows discounts as “- ¥20”, missing decimals.",

  // 白板
  "结算页舍入口径等林夏三选一，确认后 30 分钟内可提测":
    "Checkout rounding rule waiting for Lin to pick one of three; ready for QA 30 min after",
  "移动端结算页金额格式对齐 PC：千分位加货币符号":
    "Mobile checkout price format matches desktop: separators and currency symbol",
  "登录接口限流做完了，等 review": "Login rate limiting done, awaiting review",
  "首页埋点迁移到新 SDK": "Move home page analytics to the new SDK",
  优惠券叠加后金额变负的问题修好了: "Fixed negative totals when coupons stack",
  "v2.3 发布检查清单过完了，预发环境巡检正常":
    "v2.3 release checklist done; staging checks healthy",
  "结算接口契约定稿，前后端按 v2 字段联调":
    "Checkout API contract final; frontend and backend integrate on v2 fields",
  "fix: 优惠券叠加后金额不再变负": "fix: totals no longer go negative when coupons stack",

  // 故障
  "codex · Bridge 报告这一轮已结束，Server 还在等它的结果":
    "codex · Bridge reported the turn finished, but the Server is still waiting for its result",
  "Bridge 报告这一轮已结束，Server 还在等它的结果；超过 10 分钟没有新进展，已标为卡住":
    "Bridge reported the turn finished, but the Server is still waiting for its result; marked stuck after 10 minutes without progress",
  "调用超时，没交修复": "Invocation timed out; no fix delivered",
  修复合入后同一种错误又出现: "The same error came back after the fix was merged",
  "omp · 上游模型服务出错：503 Service Unavailable":
    "omp · Upstream model service error: 503 Service Unavailable",
  "上游模型服务出错：503 Service Unavailable（已自动重试 3 次）":
    "Upstream model service error: 503 Service Unavailable (retried 3 times automatically)",
  "改动 WebSocket 事件的格式前，先跑 protocol 和 web 的全量测试":
    "Before changing the WebSocket event format, run the full protocol and web test suites",
  "上次只跑了 server 测试，网页收到新事件后报协议校验失败":
    "Last time only the server tests ran, and the web app failed protocol validation on the new event",

  // 对话
  "登录接口加个限流，同一个手机号 1 分钟最多 5 次。":
    "Add rate limiting to the login API: at most 5 attempts per phone number per minute.",
  "限流加好了：按手机号计数，1 分钟 5 次，超出返回 429 和剩余秒数；补了 6 个用例。分支 ":
    "Rate limiting is in: counted per phone number, 5 per minute, over the limit returns 429 with the seconds left; added 6 test cases. Branch ",
  "，等 review。": ", awaiting review.",
  "结算页和订单详情页的金额对不上，帮我查一下两边的舍入。":
    "checkout and order details show different totals — can you check the rounding on both?",
  "结算页舍入口径用哪一种？两个页面不一致：结算页用 toFixed(2)，有浮点误差；订单详情页先换算成分再四舍五入。我已在 worktree feat/codex-price-rounding 写好复现测试。":
    "Which rounding rule should checkout use? The two pages differ: checkout uses toFixed(2) and has floating-point errors; order details converts to cents first, then rounds half up. I've written a repro test in worktree feat/codex-price-rounding.",
  "结算页舍入口径用哪一种？两个页面不一致：结算页用 toFixed(2)，有浮点误差；订单详情页先换算成分再四舍五入。我已在 worktree ":
    "Which rounding rule should checkout use? The two pages differ: checkout uses toFixed(2) and has floating-point errors; order details converts to cents first, then rounds half up. I've written a repro test in worktree ",
  " 写好复现测试。": ".",
  "写好复现测试。": ".",
  结算页舍入口径用哪一种: "Which rounding rule should checkout use",
  "？": "?",
  "统一按分四舍五入（与订单服务一致）":
    "Round half up in cents everywhere (matches the order service)",
  "统一用银行家舍入（四舍六入五成双）": "Use banker's rounding everywhere (round half to even)",
  "前端不舍入，直接显示后端金额": "No rounding on the frontend; show backend amounts as is",
  "等林夏定舍入口径的时候，先帮我看下移动端结算页的金额格式：千分位和货币符号跟 PC 端对齐。":
    "while Lin decides on rounding, look at the mobile checkout price format: match desktop's thousands separators and currency symbol.",
  先找两端格式化金额的地方: "Find where both sides format prices",
  "先看移动端结算页现在怎么格式化金额，再和 PC 端对齐。":
    "First check how mobile checkout formats prices now, then match desktop.",
  "PC 端用 Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })；移动端手拼「¥」+ toFixed(2)，没有千分位。改成共用 formatPrice。":
    "Desktop uses Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }); mobile hand-builds “¥” + toFixed(2) with no separators. Switching both to the shared formatPrice.",
  "重启预发环境的订单队列 worker，确认积压清空后告诉我。":
    "restart the order queue worker on staging and tell me once the backlog is cleared.",
  "把结算页金额的显示规则整理成一页规范，前端和设计都按它来。":
    "write up the checkout price display rules as a one-page guideline for frontend and design.",
  "整理好了，见附件：金额统一按分存、显示时才格式化；千分位和货币符号用 Intl.NumberFormat，负数和优惠的写法也列了。有出入的地方在最后一节。":
    "Done, see the attachment: store amounts in cents and format only for display; use Intl.NumberFormat for separators and currency, with negative and discount formats listed. Mismatches are in the last section.",
  "// 结算页和订单详情页的舍入要一致": "// checkout and order details must round the same way",
  "test: 复现结算页舍入误差": "test: reproduce checkout rounding error",
  "// 待定：舍入口径": "// TODO: rounding rule",
};
