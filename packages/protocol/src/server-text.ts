import { z } from "zod";
import { isEnglishSingular } from "./plural.js";

/**
 * 服务端发给人看的文字（错误提示、调用状态说明、代发的系统消息）的唯一来源。
 *
 * 服务端只发 `{ key, params }`，网页、IM 按各自的语言用 renderServerText 渲染；
 * 原有的中文字段（error / detail / content）照旧一起发，给旧客户端和 Agent 看。
 * 占位符写作 {name}；参数值也可以是另一段 ServerText（例如状态名、原因），渲染时按同一语言展开。
 * 用户原文（消息正文、问题、任务说明）只作为参数原样带上，不翻译。
 *
 * 英文用语见 docs/development.md 的「界面用语」：room、agent、owner、guest、task、turn、
 * topic、whiteboard、schedule、approval、steer、lead agent。按钮动词开头，句首大写（sentence case）。
 */
export type ServerLocale = "zh-CN" | "en";

/** 英文单复数：按参数的数量选（one=1 条，other=其余），中文不分 */
export type PluralTemplate = { one: string; other: string };
/**
 * 一条文案。en 可以按数量分单复数，默认看参数 count，plural 指定别的参数（如 turns）。
 * 别逐条写 if：数量相关的英文都写成 { one, other }。
 */
export type ServerTextEntry = { zh: string; en: string | PluralTemplate; plural?: string };
type Entry = ServerTextEntry;

export const serverTexts = {
  /* ---------- 调用（任务）状态说明 ---------- */
  "invocation.delivered": { zh: "已送达，排队中", en: "Delivered, waiting in queue" },
  "invocation.steerRequested": {
    zh: "{name} 请求引导当前任务",
    en: "{name} asked to add this to the current task",
  },
  "invocation.preemptRequested": {
    zh: "{name} 已请求停下当前任务，停下后先做这一条",
    en: "{name} asked to stop the current task and do this one first",
  },
  "invocation.steerSend": {
    zh: "发送并引导：请求引导当前任务",
    en: "Sent as steer: asked to add this to the current task",
  },
  "invocation.steerAuto": {
    zh: "自动引导：请求引导当前任务",
    en: "Auto steer: asked to add this to the current task",
  },
  "invocation.answered": {
    zh: "{name} 已回答（#{seq}），已续到新的调用",
    en: "{name} answered (#{seq}); continued in a new task",
  },
  "invocation.waitingAnswer": {
    zh: "等人回答：{question}",
    en: "Waiting for your answer: {question}",
  },
  "invocation.stoppedNoAnswer": {
    zh: "{name} 不再回答，已停止",
    en: "Stopped: {name} won't answer",
  },
  "invocation.stoppedReason": { zh: "{reason}，已停止", en: "{reason}; stopped" },
  "invocation.stopRequested": {
    zh: "{name} 已请求停止，等待 {agent} 确认",
    en: "{name} asked to stop; waiting for {agent} to confirm",
  },
  "invocation.stopRequestedReason": {
    zh: "{reason}，{name} 已请求停止，等待 {agent} 确认",
    en: "{reason}; {name} asked to stop, waiting for {agent} to confirm",
  },
  "invocation.stopUnconfirmed": {
    zh: "停止请求超过 {minutes} 分钟没有得到确认，结果未知",
    en: "Stop wasn't confirmed within {minutes} min; outcome unknown",
  },
  "invocation.stale": {
    zh: "超过 {minutes} 分钟没有任何进展，结果未知",
    en: "No progress for over {minutes} min; outcome unknown",
  },
  "invocation.unacknowledged": {
    zh: "Agent 在线但没有确认收到（可能是不支持回报状态的旧版 superhive）",
    en: "The agent is online but never confirmed receipt (it may be an older superhive that can't report status)",
  },
  "invocation.blockedHop": {
    zh: "Agent 之间的转交已达 {limit} 跳上限，点「继续」或由人重新 @ 即可续上。",
    en: "Agents have handed this off {limit} times, the limit. Select Continue or @ an agent again to resume.",
  },
  "invocation.blockedTurns": {
    zh: "自上次有人发言以来 Agent 已连续对话 {used} 轮（上限 {limit}），等待人确认后继续。",
    en: "Agents have taken {used} turns in a row since anyone last spoke (limit {limit}). Waiting for someone to continue.",
  },
  "invocation.blockedPair": {
    zh: "{sender} 今天已唤醒 {agent} {limit} 次，达到上限。",
    en: "{sender} has already woken {agent} {limit} times today, the daily limit.",
  },
  "invocation.blockedGuest": {
    zh: "{name} 是访客，@ 房主的 Agent 需要房主批准后才会派发。",
    en: "{name} is a guest. Tasks for the owner's agents start once the owner approves.",
  },
  "invocation.recalledNotRun": { zh: "消息已撤回，未执行", en: "Message unsent; not run" },

  /* ---------- 调用（任务）状态说明：续 ---------- */
  "invocation.receiptUndeliverable": {
    zh: "结果无法回执给 {name}：{reason}",
    en: "Couldn't send the result back to {name}: {reason}",
  },
  "invocation.replyWhileStopping": {
    zh: "停止期间收到回复，仍等待执行结束确认；回复中的 @ 未再派发",
    en: "A reply arrived while stopping; still waiting for the run to confirm it ended. @mentions in the reply weren't dispatched.",
  },
  "invocation.lateResult": { zh: "迟到的结果", en: "Late result" },
  "invocation.stopConfirmed": { zh: "{agent} 已确认停止", en: "{agent} confirmed it stopped" },
  "invocation.endedBeforeStop": {
    zh: "停止请求生效前已结束",
    en: "Finished before the stop took effect",
  },
  "invocation.recalledStopped": { zh: "消息已撤回，已停止", en: "Message unsent; stopped" },
  "invocation.recalledStopUnconfirmed": {
    zh: "消息已撤回，停止未确认：无法确认工具子进程都已停下：{reason}",
    en: "Message unsent; stop not confirmed. Couldn't confirm that all tool processes stopped: {reason}",
  },
  "invocation.stopUnconfirmedTools": {
    zh: "已停止 Agent 这一轮，但无法确认工具子进程都已停下：{reason}",
    en: "Stopped the agent's turn, but couldn't confirm that all tool processes stopped: {reason}",
  },
  "invocation.outcomeUnknown": { zh: "结果未知", en: "Outcome unknown" },
  "invocation.unknownNoReplay": {
    zh: "执行结果未知，无法确认工具已停止；禁止自动重放。",
    en: "Outcome unknown and tools may still be running, so it won't be retried automatically.",
  },
  "invocation.reasonRecalled": { zh: "消息已撤回", en: "Message unsent" },
  "invocation.approved": { zh: "{name} 已批准", en: "Approved by {name}" },
  "invocation.retryRequested": { zh: "{name} 请求重试", en: "{name} asked to retry" },
  "invocation.turnsAdded": {
    plural: "turns",
    zh: "{name} 追加了 {turns} 轮（共 +{total}）",
    en: {
      one: "{name} added {turns} turn (+{total} total)",
      other: "{name} added {turns} turns (+{total} total)",
    },
  },
  "invocation.toolMessageSent": {
    zh: "已发出进行中的消息 #{seq}，仍在执行",
    en: "Sent an in-progress message (#{seq}); still running",
  },
  "invocation.supersededCompleted": {
    zh: "{agent} 之后的任务已正常完成",
    en: "A later task by {agent} completed normally",
  },
  "invocation.supersededTopic": {
    zh: "之后开启了新话题",
    en: "A new topic was started afterwards",
  },
  "error.schedule.alreadyFired": {
    zh: "已经到点发出了；要停止这次执行，请在任务面板里停止对应的调用。",
    en: "This has already run. To stop it, stop the matching task in Agent tasks.",
  },
  "error.schedule.ended": {
    zh: "这个定时任务已经结束，不能再取消。",
    en: "This scheduled task has already ended and can't be cancelled.",
  },
  "error.local.notThisComputer": {
    zh: "请求不是来自 Hive Server 所在的电脑",
    en: "This request didn't come from the computer running Hive Server",
  },
  "error.local.proxied": {
    zh: "经过代理转发的请求不能使用本机 Agent",
    en: "Requests through a proxy can't use local agents",
  },
  "error.local.host": {
    zh: "请用 localhost 或本机 IP 地址打开页面",
    en: "Open the page with localhost or this computer's IP address",
  },
  "error.local.crossSite": {
    zh: "跨站请求不能使用本机 Agent",
    en: "Cross-site requests can't use local agents",
  },
  "error.approval.feishuRequired": {
    zh: "这项操作需要你在飞书里确认一次。",
    en: "Confirm this once in Feishu.",
  },
  "error.approval.localRequired": {
    zh: "这项操作需要在 Hive Server 所在的电脑上确认一次。",
    en: "Confirm this once on the computer running Hive Server.",
  },
  "invocation.approvalWaiting": {
    zh: "等你批准：{summary}",
    en: "Waiting for your approval: {summary}",
  },

  /* ---------- 子任务回执 ---------- */
  "receipt.delegation": {
    zh: "@{requester} 📬 子任务回执（Hive 代 {delegate} 发出）\n状态：{status}\n委派内容：{task}{outcome}\n子任务 ID：{id}",
    en: "@{requester} 📬 Subtask receipt (sent by Hive for {delegate})\nStatus: {status}\nTask: {task}{outcome}\nSubtask ID: {id}",
  },
  "receipt.result": { zh: "\n结果（#{seq}）：\n{result}", en: "\nResult (#{seq}):\n{result}" },
  "receipt.note": { zh: "\n说明：{note}", en: "\nNote: {note}" },
  "receipt.status.completed": { zh: "已完成", en: "Completed" },
  "receipt.status.failed": { zh: "失败", en: "Failed" },
  "receipt.status.cancelled": { zh: "已被停止", en: "Stopped" },
  "receipt.status.timedOut": {
    zh: "结果未知（超时没有进展，不代表失败）",
    en: "Outcome unknown (no progress before the timeout; not necessarily a failure)",
  },

  /* ---------- 定时任务：续 ---------- */
  "schedule.time": { zh: "{time}（{timeZone}）", en: "{time} ({timeZone})" },
  "schedule.trigger": {
    zh: "@{agent} ⏰ 定时任务（{agent} 于 #{originSeq} 设定，计划 {runAt}{recurrence}；Hive 代 {requester} 发出）\n以下是 {agent} 当初自己登记的备忘，不是 {requester} 新发的指令；只做原请求（#{originSeq}）范围内的事：\n{task}\n（服务端到点发出的消息：请现在执行并回复这条消息，结果里附上能证明完成的依据；需要人决定时用 hive_ask_human。{seriesHint}定时任务 ID：{id}）",
    en: "@{agent} ⏰ Scheduled task (set by {agent} in #{originSeq}, due {runAt}{recurrence}; sent by Hive for {requester})\nBelow is the note {agent} wrote when scheduling it. It isn't a new instruction from {requester}; stay within the original request (#{originSeq}):\n{task}\n(Sent by the server on schedule: do it now and reply to this message, with evidence that it's done. Use hive_ask_human if a person needs to decide. {seriesHint}Schedule ID: {id})",
  },
  "schedule.recurrence": {
    zh: "；每 {minutes} 分钟一次，第 {occurrence} 次，到 {until} 为止",
    en: "; every {minutes} min, run {occurrence}, until {until}",
  },
  "schedule.seriesHint": {
    zh: "下一次服务端会自己登记，不用你再建；目标已经达成、后面不用再检查时，用 hive_schedule_list 找到这个周期待执行的那一次，用 hive_schedule_cancel 取消，整个周期就结束了。",
    en: "The server schedules the next run itself, so don't create one. Once the goal is met and no more checks are needed, find this series' pending run with hive_schedule_list and cancel it with hive_schedule_cancel to end the series. ",
  },
  "schedule.report": {
    zh: "@{requester} ⏰ 定时任务没有正常完成（Hive 代 {agent} 发出）\n状态：{status}\n计划时间：{runAt}\n任务：{task}{note}\n定时任务 ID：{id}",
    en: "@{requester} ⏰ A scheduled task didn't finish normally (sent by Hive for {agent})\nStatus: {status}\nDue: {runAt}\nTask: {task}{note}\nSchedule ID: {id}",
  },
  "schedule.status.noReply": {
    zh: "执行结束但没有回复（Agent 回了 NO_REPLY 或没有输出）",
    en: "Finished without a reply (the agent returned NO_REPLY or nothing)",
  },
  "schedule.status.missed": { zh: "已错过", en: "Missed" },
  "schedule.status.failed": { zh: "没能发出", en: "Couldn't be sent" },
  "schedule.cancelledBy": { zh: "{name} 取消了", en: "Cancelled by {name}" },
  "schedule.skippedBusy": {
    zh: "上一次（第 {occurrence} 次）还没做完，跳过这一次",
    en: "Skipped: the previous run (run {occurrence}) is still going",
  },
  "schedule.missedOffline": {
    zh: "到点时 Server 没有运行，晚了 {minutes} 分钟才轮到，已标为错过、没有自动补跑",
    en: "The server wasn't running when this was due and got to it {minutes} min late, so it was marked missed and not run",
  },
  "schedule.missedInFlight": {
    zh: "发出途中 Server 停止，{minutes} 分钟后才恢复，已标为错过、没有自动补跑",
    en: "The server stopped while sending this and was back {minutes} min later, so it was marked missed and not run",
  },
  "schedule.memberGone": {
    zh: "发起人或执行的 Agent 已不在这个房间",
    en: "The requester or the agent is no longer in this room",
  },
  "schedule.requesterExpired": {
    zh: "发起人的访客权限已失效",
    en: "The requester's guest access has expired",
  },
  "schedule.triggerFailed": {
    zh: "触发消息发不出去：{reason}",
    en: "Couldn't send the trigger message: {reason}",
  },

  /* ---------- 提问与权限申请 ---------- */
  "question.ask": {
    zh: "{asker}❓ {question}{choices}\n（{hint}）",
    en: "{asker}❓ {question}{choices}\n({hint})",
  },
  "question.choices": { zh: "\n{mode}\n{options}", en: "\n{mode}\n{options}" },
  "question.single": { zh: "（单选）", en: "(Pick one)" },
  "question.multiple": { zh: "（可多选）", en: "(Pick one or more)" },
  "question.hintOptions": {
    zh: "点选选项、填写「其它」，或直接回复这条消息即可把答案交给 {agent}",
    en: "Pick an option, fill in Other, or reply to this message to send your answer to {agent}",
  },
  "question.hintReply": {
    zh: "回复这条消息即可把答案交给 {agent}",
    en: "Reply to this message to send your answer to {agent}",
  },
  "approval.request": {
    zh: "{asker}🔐 {agent} 申请权限（{tool}）：{summary}{detail}\nA. 允许\nB. 拒绝\n（点选，或回复这条消息「允许 / 拒绝」；{minutes} 分钟内没人批按拒绝处理）",
    en: "{asker}🔐 {agent} is requesting permission ({tool}): {summary}{detail}\nA. Allow\nB. Deny\n(Pick one, or reply Allow / Deny to this message. It's denied if no one decides within {minutes} min.)",
  },
  "approval.allow": { zh: "允许", en: "Allow" },
  "approval.deny": { zh: "拒绝", en: "Deny" },

  /* ---------- 话题与转发 ---------- */
  "topic.cleared": { zh: "{name} 清空了房间", en: "{name} cleared the room" },
  "topic.started": { zh: "{name} 开启了新话题", en: "{name} started a new topic" },
  "roomPost.forwarded": {
    zh: "{content}\n\n（{agent} 从 #{room} 的 #{seq} 转来，发起人 {requester}）",
    en: "{content}\n\n(Forwarded by {agent} from #{seq} in #{room}; requested by {requester})",
  },

  /* ---------- Bridge 上报的调用说明（中文模板与 superhive 的 bridge-text.ts 一致） ---------- */
  "bridge.crashedMidTurn": {
    zh: "Agent 在处理途中意外退出，结果未知；未自动重跑，需先核对原执行与工具进程。",
    en: "The agent exited unexpectedly mid-task, so the outcome is unknown. It wasn't rerun; check what the previous run and its tools did first.",
  },
  "bridge.beyondCatchUp": {
    zh: "Agent 首次加入时这条提及已超出补拉范围，未处理；可手动重试。",
    en: "This mention was older than what the agent fetches when it first joins, so it wasn't handled. Retry it manually.",
  },
  "bridge.reconnectedGone": {
    zh: "Agent 重新连接时这次处理已不在进行，结果未知；需先核对原执行与工具进程。",
    en: "When the agent reconnected, this run was no longer going, so the outcome is unknown. Check what the previous run and its tools did first.",
  },
  "bridge.cancelledBeforeRun": { zh: "任务在执行前被取消", en: "Cancelled before it started" },
  "bridge.notSteeredQueued": {
    zh: "当前没有正在执行、能引导的任务，已排队",
    en: "Nothing is running that this could join, so it's queued",
  },
  "bridge.steerUnsupported": {
    zh: "这个运行时不支持引导，已排队",
    en: "This runtime doesn't support steering, so it's queued",
  },
  "bridge.steering": { zh: "正在引导当前任务", en: "Adding to the current task" },
  "bridge.steerUnconfirmed": {
    zh: "消息已尝试注入但未获确认；禁止退回队列或自动重放。",
    en: "Tried to add the message but got no confirmation. It won't be requeued or retried automatically.",
  },
  "bridge.steerRemoved": {
    zh: "未注入的排队任务已移除",
    en: "Removed the queued task that wasn't added",
  },
  "bridge.steerCancelRace": {
    zh: "取消与注入并发，执行结果需核对",
    en: "Cancel and steer happened at the same time; check the outcome",
  },
  "bridge.steerEndRace": {
    zh: "消息注入与回合结束并发，结果待核实；禁止自动重放。",
    en: "Steer and the end of the turn happened at the same time; outcome unconfirmed. It won't be retried automatically.",
  },
  "bridge.steered": { zh: "已并入当前任务（#{seq}）", en: "Added to the current task (#{seq})" },
  "bridge.steerLate": {
    zh: "没能引导当前任务（这一轮已经收尾），已排队",
    en: "Couldn't join the current task (the turn was wrapping up), so it's queued",
  },
  "bridge.stoppedWhileWaiting": {
    zh: "等待自动继续时被停止",
    en: "Stopped while waiting to continue automatically",
  },
  "bridge.cancelNotPersisted": {
    zh: "无法持久化取消结果，需核对",
    en: "Couldn't save the cancellation; check the outcome",
  },
  "bridge.queuedRemoved": {
    zh: "尚未执行的排队任务已移除",
    en: "Removed the queued task before it ran",
  },
  "bridge.alreadyEnded": {
    zh: "这一轮在 Agent 这边早已结束，没有在跑的回合；当初的结果仍未知，请先核对再决定是否重试。",
    en: "This turn ended on the agent's side long ago and nothing is running. Its outcome is still unknown; check before deciding whether to retry.",
  },
  "bridge.stoppedNoReply": {
    zh: "本轮已结束，已停止的触发消息未发送回复",
    en: "The turn ended; no reply was sent for the stopped message",
  },
  "bridge.noReply": { zh: "无需回复", en: "No reply needed" },
  "bridge.uncertain": {
    zh: "{reason} 已禁止自动重放；请先核对已执行操作再决定是否重试。",
    en: "{reason} It won't be retried automatically; check what was done before deciding whether to retry.",
  },
  "bridge.offline": {
    zh: "Agent 已下线，本轮被中断；可在界面中重试",
    en: "The agent went offline and this turn was interrupted. You can retry it.",
  },
  "bridge.failedRepeatedly": {
    zh: "连续失败 {attempts} 次：{reason}",
    en: "Failed {attempts} times in a row: {reason}",
  },
  "bridge.upstreamFailed": {
    zh: "上游模型服务出错：{reason}。{why}；点「继续」会接着原会话从中断处往下做。",
    en: "The model service had an error: {reason}. {why}. Continue picks up the same session where it stopped.",
  },
  "bridge.upstreamMutated": {
    zh: "这一轮已经做过改动，不自动重跑",
    en: "This turn already made changes, so it won't rerun automatically",
  },
  "bridge.upstreamExhausted": {
    zh: "已自动继续 {count} 次仍未成功",
    en: {
      one: "Still failing after {count} automatic retry",
      other: "Still failing after {count} automatic retries",
    },
  },

  /* ---------- 操作名（嵌进错误提示里） ---------- */
  "action.createRoom": { zh: "新建房间", en: "create rooms" },
  "action.postToRoom": { zh: "到别的房间派活", en: "post tasks to other rooms" },

  /* ---------- 定时任务 ---------- */
  "schedule.roomCleared": { zh: "房间已清空", en: "The room was cleared" },

  /* ---------- 错误提示（HTTP 错误体与 WebSocket error 事件的 text） ---------- */
  "error.agent.askOutsideTask": {
    zh: "只能在处理某条消息的过程中向人提问。",
    en: "You can only ask a person a question while handling a message.",
  },
  "error.answer.duplicateOption": { zh: "选项重复。", en: "You picked the same option twice." },
  "error.answer.empty": {
    zh: "请至少选择一项，或填写「其它」。",
    en: "Pick at least one option, or fill in Other.",
  },
  "error.answer.singleChoice": {
    zh: "单选题只能选一项（或只填写「其它」）。",
    en: "This question takes one answer: pick one option, or fill in Other only.",
  },
  "error.answer.unknownOption": { zh: "没有选项 {option}。", en: "There's no option {option}." },
  "error.approval.forbidden": {
    zh: "只有房主（或带入这个 Agent 的访客）能批这个权限申请。",
    en: "Only the owner (or the guest who brought in this agent) can decide on this permission request.",
  },
  "error.approval.invalidAnswer": {
    zh: "权限申请只能选「允许」或「拒绝」。",
    en: "A permission request can only be answered with Allow or Deny.",
  },
  "error.approval.requestHandled": {
    zh: "这条申请已经处理过或已过期。",
    en: "This request was already handled or has expired.",
  },
  "error.approval.requestNotFound": {
    zh: "没有这条申请，或已经过期。",
    en: "This request doesn't exist or has expired.",
  },
  "error.attachment.expired": {
    zh: "附件上传后太久没有发出，已过期。",
    en: "This attachment was uploaded too long ago without being sent, so it expired.",
  },
  "error.attachment.expiredReupload": {
    zh: "附件上传后太久没有发出，已过期，请重新上传。",
    en: "This attachment was uploaded too long ago without being sent, so it expired. Upload it again.",
  },
  "error.attachment.failed": { zh: "附件处理失败。", en: "Couldn't process the attachment." },
  "error.attachment.fileRequired": { zh: "没有收到文件。", en: "No file was received." },
  "error.attachment.gone": {
    zh: "附件文件已被清理。",
    en: "The attachment file has been cleaned up.",
  },
  "error.attachment.previewUnsupported": {
    zh: "只有 HTML 附件能预览成网页。",
    en: "Only HTML attachments can be previewed as a page.",
  },
  "error.attachment.previewExpired": {
    zh: "预览链接已过期，请重新打开预览。",
    en: "This preview link has expired. Open the preview again.",
  },
  "error.attachment.localOnly": {
    zh: "只提供给本机的房主 Agent。",
    en: "Only available to the owner's agents on this computer.",
  },
  "error.attachment.messageRecalled": {
    zh: "附件所在的消息已撤回。",
    en: "The message with this attachment was unsent.",
  },
  "error.attachment.multipartRequired": {
    zh: "请用 multipart/form-data 上传文件。",
    en: "Upload files as multipart/form-data.",
  },
  "error.attachment.notFound": { zh: "附件不存在。", en: "Attachment not found." },
  "error.attachment.notInRoom": {
    zh: "这个房间里没有这个附件（可能已撤回）。",
    en: "There's no such attachment in this room (it may have been unsent).",
  },
  "error.attachment.pendingNotFound": {
    zh: "没有这个待发附件。",
    en: "There's no such attachment waiting to be sent.",
  },
  "error.attachment.pendingQuota": {
    zh: "待发送的附件太多，请先发出或移除一些。",
    en: "Too many attachments are waiting to be sent. Send or remove some first.",
  },
  "error.attachment.rateLimited": {
    zh: "上传太频繁，请稍后再试。",
    en: "You're uploading too often. Try again in a moment.",
  },
  "error.attachment.roomQuota": {
    zh: "这个房间的附件空间已满，请撤回不需要的附件。",
    en: "This room's attachment storage is full. Unsend attachments you no longer need.",
  },
  "error.attachment.sentElsewhere": {
    zh: "附件已随另一条消息发出，请重新上传。",
    en: "This attachment was already sent with another message. Upload it again.",
  },
  "error.attachment.tooLarge": {
    zh: "单个附件不能超过 20 MiB。",
    en: "Each attachment can be at most 20 MiB.",
  },
  "error.attachment.tooMany": {
    zh: "一条消息最多带 10 个附件。",
    en: "A message can carry at most 10 attachments.",
  },
  "error.attachment.totalTooLarge": {
    zh: "一条消息的附件总量不能超过 50 MiB。",
    en: "A message's attachments can total at most 50 MiB.",
  },
  "error.attachment.unavailable": {
    zh: "附件不存在、已发出或不属于你，请重新上传。",
    en: "This attachment doesn't exist, was already sent, or isn't yours. Upload it again.",
  },
  "error.auth.agentsReportOnly": {
    zh: "只有 Agent 能回报任务进度。",
    en: "Only agents can report task progress.",
  },
  "error.auth.humansAnswer": {
    zh: "只有人能回答 Agent 的提问。",
    en: "Only people can answer an agent's questions.",
  },
  "error.auth.humansManageTasks": { zh: "只有人能管理任务。", en: "Only people can manage tasks." },
  "error.auth.notAllowed": { zh: "不允许。", en: "Not allowed." },
  "error.auth.ownerOnly": { zh: "只有房主可以执行这个操作。", en: "Only the owner can do this." },
  "error.auth.roomForbidden": {
    zh: "这个凭证不能访问该房间。",
    en: "These credentials can't access this room.",
  },
  "error.auth.unauthorized": {
    zh: "未授权，请重新登录或刷新页面。",
    en: "Not authorized. Sign in again or refresh the page.",
  },
  "error.delegation.agentNotFound": {
    zh: "房间里没有名为 {agent} 的 Agent。",
    en: "There's no agent named {agent} in this room.",
  },
  "error.delegation.cycle": {
    zh: "{agent} 正在等待这条委派链的结果，再委派给它会相互等待；请直接在回复里给出结论。",
    en: "{agent} is waiting on this delegation chain, so delegating back to it would deadlock. Give your conclusion in your reply instead.",
  },
  "error.delegation.noInvocation": {
    zh: "委派消息已发出，但没有为对方建立调用记录。",
    en: "The delegation message was sent, but no task was created for the other agent.",
  },
  "error.delegation.self": {
    zh: "不能把子任务委派给自己。",
    en: "You can't delegate a task to yourself.",
  },
  "error.device.localOnly": {
    zh: "这项操作只能在 Hive Server 所在的电脑上进行。",
    en: "This can only be done on the computer running Hive Server.",
  },
  "error.device.manageRequired": {
    zh: "这台设备还没有获准管理 Hive Server 所在的电脑，请先申请。",
    en: "This device isn't approved to manage the computer running Hive Server yet. Request access first.",
  },
  "error.device.notADevice": {
    zh: "只有房主登录的其他设备需要申请。",
    en: "Only other devices the owner signed in on need to request access.",
  },
  "error.device.notFound": {
    zh: "没有这台设备，或已经退出。",
    en: "This device doesn't exist or has already signed out.",
  },
  "error.device.ownerCredential": {
    zh: "缺少或错误的房主凭证，请刷新页面。",
    en: "The owner credential is missing or wrong. Refresh the page.",
  },
  "error.device.sessionInvalid": {
    zh: "这台设备的登录已失效，请重新扫码或在飞书里发 /web。",
    en: "This device's sign-in is no longer valid. Scan again, or send /web in Feishu.",
  },
  "error.device.signedOutByOwner": {
    zh: "这台设备已被房主退出登录。",
    en: "The owner signed this device out.",
  },
  "error.directory.absolute": {
    zh: "目录需要是绝对路径。",
    en: "The directory must be an absolute path.",
  },
  "error.directory.missing": { zh: "找不到目录 {path}。", en: "Directory {path} doesn't exist." },
  "error.directory.notDirectory": { zh: "{path} 不是目录。", en: "{path} isn't a directory." },
  "error.feature.disabled": { zh: "未启用。", en: "Not enabled." },
  "error.guest.agentGuestOnly": {
    zh: "只有访客本人可以为自己带入 Agent。",
    en: "Only the guest can bring in an agent for themselves.",
  },
  "error.guest.agentNotRenewable": {
    zh: "访客带入的 Agent 跟随访客的期限，请为访客续期。",
    en: "Agents brought in by a guest expire with the guest. Renew the guest instead.",
  },
  "error.guest.cancelScheduleOwn": {
    zh: "访客只能取消自己发起的定时任务。",
    en: "Guests can only cancel scheduled tasks they created.",
  },
  "error.guest.dismissOwn": {
    zh: "访客只能忽略自己发起的调用。",
    en: "Guests can only dismiss tasks they started.",
  },
  "error.guest.expired": {
    zh: "你的访问期限已到，请联系房主续期或重新邀请。",
    en: "Your access has expired. Ask the owner to extend it or invite you again.",
  },
  "error.guest.manageOwn": {
    zh: "访客只能重试或停止自己发起、且无需房主批准的调用。",
    en: "Guests can only retry or stop tasks they started that don't need the owner's approval.",
  },
  "error.guest.notFound": { zh: "找不到这个访客。", en: "Guest not found." },
  "error.guest.ownerActions": {
    zh: "访客不能开启新话题、追加轮数或删除白板事项。",
    en: "Guests can't start a new topic, add turns, or delete whiteboard items.",
  },
  "error.guest.preempt": {
    zh: "访客不能停下 Agent 正在执行的任务。",
    en: "Guests can't stop a task an agent is running.",
  },
  "error.guest.removed": {
    zh: "这个访客已被移除，请重新邀请。",
    en: "This guest was removed. Invite them again.",
  },
  "error.guest.revoked": {
    zh: "房主已把你移出这个房间。",
    en: "The owner removed you from this room.",
  },
  "error.im.connectionNotFound": { zh: "没有这个 IM 连接。", en: "There's no such IM connection." },
  "error.im.roomNotFound": {
    zh: "没有这个房间，或者已经归档。",
    en: "That room doesn't exist or has been archived.",
  },
  "error.im.notRoomMember": {
    zh: "你还不是这个房间的成员，请先在网页上进入一次。",
    en: "You're not a member of that room yet. Open it once in the web app first.",
  },
  "error.im.loginNotFound": {
    zh: "扫码会话不存在或已过期。",
    en: "This sign-in session doesn't exist or has expired.",
  },
  "error.im.ownerIdentity": {
    zh: "需要以房主本人在这个房间里的身份连接。",
    en: "Connect as the owner's own member in this room.",
  },
  "error.im.pairingCode": {
    zh: "配对码格式不对。",
    en: "The pairing code isn't in the right format.",
  },
  "error.im.wechatRisk": {
    zh: "连接个人微信前需要确认风险。",
    en: "Confirm the risks before connecting personal WeChat.",
  },
  "error.invite.expired": {
    zh: "这个邀请已经过期，请向房主要一个新邀请。",
    en: "This invite has expired. Ask the owner for a new one.",
  },
  "error.invite.identity": {
    zh: "这个邀请只能以 {name} 的身份进入 #{room}。",
    en: "This invite only lets you join #{room} as {name}.",
  },
  "error.invite.invalid": { zh: "邀请链接无效。", en: "This invite link isn't valid." },
  "error.invite.notFound": { zh: "邀请不存在。", en: "This invite doesn't exist." },
  "error.invite.revoked": { zh: "这个邀请已被房主撤销。", en: "The owner revoked this invite." },
  "error.invite.revokedReinvite": {
    zh: "这个邀请已被撤销，请重新邀请。",
    en: "This invite was revoked. Ask for a new one.",
  },
  "error.invocation.mayStillRun": {
    zh: "上一次执行可能还在进行。先停止，等 Agent 确认停下后再重试。",
    en: "The previous run may still be going. Stop it and wait for the agent to confirm before retrying.",
  },
  "error.invocation.notFound": { zh: "找不到这个任务。", en: "Task not found." },
  "error.invocation.notInRoom": {
    zh: "当前房间没有这个调用。",
    en: "There's no such task in this room.",
  },
  "error.invocation.notRetryable": {
    zh: "这个任务现在不能重试。",
    en: "This task can't be retried right now.",
  },
  "error.invocation.triggerGone": {
    zh: "触发这个任务的消息已经不在了。",
    en: "The message that started this task no longer exists.",
  },
  "error.keepAwake.disabled": {
    zh: "这个服务没有启用熄屏后保持在线。",
    en: "Keep awake isn't enabled on this server.",
  },
  "error.localAgent.configChanged": {
    zh: "Agent 的配置在批准后变了，已停下没有启动，请重新申请批准。",
    en: "The agent's configuration changed after approval, so it was stopped instead of started. Request approval again.",
  },
  "error.localAgent.cwdAbsolute": {
    zh: "工作目录需要是绝对路径，例如 /Users/me/project。",
    en: "The working directory must be an absolute path, such as /Users/me/project.",
  },
  "error.localAgent.cwdMissing": {
    zh: "找不到目录 {path}。",
    en: "Directory {path} doesn't exist.",
  },
  "error.localAgent.cwdNotDirectory": { zh: "{path} 不是目录。", en: "{path} isn't a directory." },
  "error.localAgent.cwdRequired": {
    zh: "工作区和完全访问权限需要指定工作目录。",
    en: "Workspace and full access need a working directory.",
  },
  "error.localAgent.cwdRoot": {
    zh: "不能把整个文件系统根目录作为工作目录。",
    en: "The file system root can't be the working directory.",
  },
  "error.localAgent.disabled": {
    zh: "本机 Agent 已在服务端关闭。",
    en: "Local agents are turned off on this server.",
  },
  "error.localAgent.mcpListFailed": {
    zh: "没能读取这个 Agent 的 MCP 列表。",
    en: "Couldn't read this agent's MCP servers.",
  },
  "error.localAgent.mcpUnsupported": {
    zh: "这个 Agent 类型暂不支持在 Hive 里开关 MCP。",
    en: "Hive can't turn MCP servers on or off for this kind of agent yet.",
  },
  "error.localAgent.nameExists": {
    zh: "本机已有名为 {name} 的 Agent。",
    en: "There's already a local agent named {name}.",
  },
  "error.localAgent.nameInUse": {
    zh: "名称 {name} 已被在线成员使用，请换一个。",
    en: "{name} is already used by an online member. Pick another.",
  },
  "error.localAgent.notFound": { zh: "找不到这个本机 Agent。", en: "Local agent not found." },
  "error.localAgent.restarting": { zh: "这个 Agent 正在重启。", en: "This agent is restarting." },
  "error.localAgent.restartingSettings": {
    zh: "这个 Agent 正在重启，等它启动后再改设置。",
    en: "This agent is restarting. Change its settings once it's up.",
  },
  "error.login.invalid": {
    zh: "登录链接无效、已过期或已经用过。请重新扫码，或在飞书里发 /web 获取新的链接。",
    en: "This sign-in link is invalid, expired, or already used. Scan again, or send /web in Feishu for a new link.",
  },
  "error.login.rateLimited": {
    zh: "尝试次数太多，请 10 分钟后再试。",
    en: "Too many attempts. Try again in 10 minutes.",
  },
  "error.member.notFound": { zh: "找不到这个成员。", en: "Member not found." },
  "error.message.empty": { zh: "消息内容为空。", en: "The message is empty." },
  "error.message.hopLimit": {
    zh: "这段 Agent 对话的转交深度已到上限。",
    en: "This agent conversation has been handed off too many times.",
  },
  "error.message.notInRoom": {
    zh: "这个房间里没有这条消息。",
    en: "There's no such message in this room.",
  },
  "error.message.parentMissing": {
    zh: "这个房间里没有要回复的那条消息。",
    en: "The message you're replying to isn't in this room.",
  },
  "error.message.rateLimit": {
    zh: "这个 Agent 发言太频繁，已到每分钟上限。",
    en: "This agent is replying too often and hit its per-minute limit.",
  },
  "error.message.recallSenderOnly": {
    zh: "只有发送者本人能撤回消息。",
    en: "Only the sender can unsend a message.",
  },
  "error.message.selfResponse": {
    zh: "Agent 不能回应自己发的消息。",
    en: "An agent can't respond to its own message.",
  },
  "error.message.tooLong": {
    zh: "消息超过 {max} 字符保护上限，请缩短正文或拆分发送。",
    en: "The message is over the {max}-character limit. Shorten it or split it into several messages.",
  },
  "error.message.traceLimit": {
    zh: "这条转交链里 Agent 发言已到上限。",
    en: "This agent conversation has reached its message limit.",
  },
  "error.message.unreadable": {
    zh: "当前房间/话题中没有这条可读取消息（可能已撤回）。",
    en: "There's no readable message like that in this room or topic (it may have been unsent).",
  },
  "error.name.agentFormat": {
    zh: "Agent 名字只能包含字母、数字、点、下划线和连字符。",
    en: "Agent names can only contain letters, numbers, dots, underscores, and hyphens.",
  },
  "error.name.format": {
    zh: "名字只能包含字母、数字、点、下划线和连字符。",
    en: "Names can only contain letters, numbers, dots, underscores, and hyphens.",
  },
  "error.name.online": {
    zh: "这个名字已经在房间里在线了。",
    en: "Someone with this name is already online in this room.",
  },
  "error.name.otherType": {
    zh: "这个名字已经被另一类成员（人或 Agent）使用。",
    en: "This name is already used by a different kind of member (person or agent).",
  },
  "error.name.taken": {
    zh: "房间里已经有这个名字了，请换一个。",
    en: "That name is already in use in this room. Pick another.",
  },
  "error.name.takenInRoom": {
    zh: "房间里已经有人用这个名字了，请换一个。",
    en: "Someone in this room already uses that name. Pick another.",
  },
  "error.progress.limit": {
    plural: "limit",
    zh: "这个任务的进度消息已经发了 {limit} 条，到上限了；把剩下的写进最终回复。",
    en: {
      one: "This task has already sent its {limit} progress update, the limit. Put the rest in your final reply.",
      other:
        "This task has already sent {limit} progress updates, the limit. Put the rest in your final reply.",
    },
  },
  "error.progress.mentionsAgent": {
    zh: "进度消息不会唤醒 {agents}；要别的 Agent 干活请用 hive_invoke，进度里提到它时去掉 @。",
    en: "Progress messages don't wake {agents}. Use hive_invoke to give another agent work, and drop the @ when you mention it in progress.",
  },
  "error.progress.outsideTask": {
    zh: "只能在执行任务的过程中发进度；最终结论请直接回复。",
    en: "You can only send progress while running a task. Reply directly with your final answer.",
  },
  "error.question.closed": {
    zh: "这个提问已经回答过或已停止等待。",
    en: "This question has already been answered or is no longer waiting.",
  },
  "error.question.duplicateOptions": { zh: "选项不能重复。", en: "Options must be unique." },
  "error.question.notFound": {
    zh: "这条提问不存在或没有可选项。",
    en: "This question doesn't exist or has no options.",
  },
  "error.question.optionCount": {
    zh: "选项需要 2 到 {max} 个；只有一个可选项时直接写在问题里。",
    en: "Questions need 2 to {max} options. If there's only one choice, put it in the question.",
  },
  "error.question.optionLength": {
    zh: "每个选项需为 1 到 {max} 个字符。",
    en: "Each option must be 1 to {max} characters.",
  },
  "error.request.invalid": { zh: "参数不正确。", en: "Invalid parameters." },
  "error.request.missingActor": { zh: "缺少操作人。", en: "The acting person is missing." },
  "error.room.agentsAbsent": {
    zh: "#{room} 里还没有在线的 {agents}，稍后再试或换一个 Agent。",
    en: "{agents} isn't online in #{room} yet. Try again shortly or pick another agent.",
  },
  "error.room.archivedJoin": {
    zh: "这个房间已归档，不再接受新成员。",
    en: "This room is archived and no longer accepts new members.",
  },
  "error.room.clearMembersOnly": {
    zh: "只有房间里的人类成员可以清空房间。",
    en: "Only human members of this room can clear it.",
  },
  "error.room.defaultProtected": {
    zh: "默认房间不能归档。",
    en: "The default room can't be archived.",
  },
  "error.room.exists": { zh: "已有这个 ID 的房间。", en: "A room with this ID already exists." },
  "error.room.guestAgentForbidden": {
    zh: "访客带入的 Agent 不能{action}。",
    en: "Agents brought in by a guest can't {action}.",
  },
  "error.room.leadInvalid": {
    zh: "{agent} 不是这个房间里的 Agent。",
    en: "{agent} isn't an agent in this room.",
  },
  "error.room.notFound": { zh: "房间不存在。", en: "Room not found." },
  "error.room.notFoundOrArchived": {
    zh: "房间不存在或已归档。",
    en: "The room doesn't exist or is archived.",
  },
  "error.room.notJoined": {
    zh: "你还没进入 #{room}，稍后再试。",
    en: "You haven't joined #{room} yet. Try again shortly.",
  },
  "error.room.outsideTask": {
    zh: "只能在处理某条消息的过程中{action}。",
    en: "You can only {action} while handling a message.",
  },
  "error.room.ownerTaskOnly": {
    zh: "只有房主本人发起的任务里才能{action}（访客发起的、Agent 之间的对话都不行）。",
    en: "You can only {action} in tasks the owner started (not in tasks started by guests or between agents).",
  },
  "error.room.postNeedsMention": {
    zh: "消息里要 @ 那个房间里接活的 Agent。",
    en: "@ the agent in that room who should take the task.",
  },
  "error.room.samePost": {
    zh: "这就是当前房间，直接回复或用 hive_invoke 即可。",
    en: "This is the current room. Reply directly or use hive_invoke.",
  },
  "error.room.targetNotFound": {
    zh: "没有房间 #{room}（或已归档）。",
    en: "There's no room #{room} (or it's archived).",
  },
  "error.schedule.humanOnly": {
    zh: "只有人发起的任务里才能创建定时任务（Agent 之间的对话不能自行排定时）。",
    en: "Scheduled tasks can only be created in tasks a person started (agents can't schedule each other).",
  },
  "error.schedule.intervalRange": {
    zh: "everyMinutes 需为 {min} 到 {max} 之间的整数（分钟）。",
    en: "everyMinutes must be a whole number from {min} to {max} (minutes).",
  },
  "error.schedule.missing": { zh: "定时任务不存在。", en: "Scheduled task not found." },
  "error.schedule.nested": {
    zh: "定时任务执行时不能再创建定时任务；要重复执行，请在最初创建时用 everyMinutes + until 登记成周期任务。",
    en: "A scheduled run can't create another scheduled task. To repeat, create a series up front with everyMinutes and until.",
  },
  "error.schedule.notFound": {
    zh: "这个房间里没有这个定时任务。",
    en: "There's no such scheduled task in this room.",
  },
  "error.schedule.outsideTask": {
    zh: "只能在处理某条消息的过程中创建定时任务。",
    en: "You can only create a scheduled task while handling a message.",
  },
  "error.schedule.ownOnly": {
    zh: "Agent 只能取消自己的定时任务。",
    en: "Agents can only cancel their own scheduled tasks.",
  },
  "error.schedule.requesterExpired": {
    zh: "发起人的访客权限已失效，不能再创建定时任务。",
    en: "The requester's guest access has expired, so no more scheduled tasks can be created.",
  },
  "error.schedule.roomLimit": {
    zh: "这个房间已有 {max} 个待执行的定时任务，先取消一些再建。",
    en: "This room already has {max} pending scheduled tasks. Cancel some first.",
  },
  "error.schedule.runAtFormat": {
    zh: "runAt 需为带时区偏移的 ISO 8601 时间，例如 2026-11-04T00:07:00+08:00。",
    en: "runAt must be an ISO 8601 time with a time zone offset, for example 2026-11-04T00:07:00+08:00.",
  },
  "error.schedule.runAtInvalid": { zh: "runAt 不是有效的时间。", en: "runAt isn't a valid time." },
  "error.schedule.runAtTooFar": {
    zh: "最多只能排到 {days} 天以内。",
    en: "Scheduled tasks can be at most {days} days ahead.",
  },
  "error.schedule.runAtTooSoon": {
    zh: "runAt 需晚于当前时间至少 30 秒；当前服务端时间 {now}。",
    en: "runAt must be at least 30 seconds from now. Server time is {now}.",
  },
  "error.schedule.taskLength": {
    zh: "任务说明需为 1 到 {max} 个字符。",
    en: "The task description must be 1 to {max} characters.",
  },
  "error.schedule.timeZone": {
    zh: "不认识的时区 {timeZone}，请用 IANA 名称，例如 Asia/Shanghai。",
    en: "Unknown time zone {timeZone}. Use an IANA name such as Asia/Shanghai.",
  },
  "error.schedule.tooManyOccurrences": {
    zh: "这样一共要执行 {count} 次，最多 {max} 次；请拉长间隔或提前结束时间。",
    en: "This would run {count} times; the maximum is {max}. Use a longer interval or an earlier end time.",
  },
  "error.schedule.untilBeforeRunAt": {
    zh: "until 需晚于第一次执行的时间 runAt。",
    en: "until must be later than the first run (runAt).",
  },
  "error.schedule.untilRequired": {
    zh: "周期任务要给 until：带时区偏移的 ISO 8601 结束时间，例如 2026-11-10T20:00:00+08:00。",
    en: "A series needs until: an ISO 8601 end time with a time zone offset, for example 2026-11-10T20:00:00+08:00.",
  },
  "error.schedule.untilTooFar": {
    zh: "周期最多只能排到 {days} 天以内。",
    en: "A series can run at most {days} days ahead.",
  },
  "error.steer.agentIdle": {
    zh: "{agent} 现在没有正在执行的任务，这条会照常开始。",
    en: "{agent} isn't running a task right now, so this message will start normally.",
  },
  "error.steer.humanOnly": {
    zh: "只有人直接发的消息可以用来引导当前任务。",
    en: "Only messages sent directly by a person can be added to the current task.",
  },
  "error.steer.messageGone": { zh: "这条消息已经不在了。", en: "This message no longer exists." },
  "error.steer.notQueued": {
    zh: "这条已经不在排队了。",
    en: "This message is no longer in the queue.",
  },
  "error.terminal.agentBusy": {
    zh: "{agent} 正在执行任务。终端里显示的是打开那一刻为止的会话记录，不会跟着刷新；在终端里发消息会和它同时写这个会话，把上下文搅乱。",
    en: "{agent} is running a task. The terminal shows the session as of when you open it and won't update; sending messages there writes to the same session at the same time and will scramble its context.",
  },
  "error.terminal.noSession": {
    zh: "{agent} 在这个房间还没有可以接着的会话：可能是它在支持这个功能之前启动的（重启一次就好）、在这个房间还没开始过任务，或这种 Agent 不支持。",
    en: "{agent} has no session to resume in this room. It may have started before this feature existed (restart it once), hasn't run a task in this room yet, or doesn't support it.",
  },
  "error.topic.humansOnly": {
    zh: "只有人能开启新话题。",
    en: "Only people can start a new topic.",
  },
  "error.ws.alreadyJoined": { zh: "已经加入过了。", en: "Already joined." },
  "error.ws.answerFailed": { zh: "回答没能提交。", en: "Couldn't submit the answer." },
  "error.ws.invalidEvent": { zh: "无效的请求。", en: "Invalid request." },
  "error.ws.invalidJson": {
    zh: "无法解析的消息格式。",
    en: "Couldn't read the message (invalid JSON).",
  },
  "error.ws.invalidToken": { zh: "接入令牌无效。", en: "The join token isn't valid." },
  "error.ws.joinFailed": { zh: "没能加入房间。", en: "Couldn't join the room." },
  "error.ws.notJoined": { zh: "请先加入房间。", en: "Join the room first." },
  "error.ws.recallFailed": { zh: "消息没能撤回。", en: "Couldn't unsend the message." },
  "error.ws.requestFailed": { zh: "请求没能处理。", en: "Couldn't handle the request." },
  "error.ws.sendFailed": { zh: "消息没能发出。", en: "Couldn't send the message." },

  /* ---------- IM 扫码与连接状态（网页 IM 弹窗显示；rd-claude2 维护） ---------- */
  "error.im.channelDisabled": { zh: "这个渠道没有启用。", en: "This channel isn't enabled." },
  "error.im.notMember": {
    zh: "需要以房间里的人类成员身份连接。",
    en: "Connect as a person who's a member of this room.",
  },
  "error.im.loginTimeout": {
    zh: "扫码超时，请重新开始。",
    en: "The QR code timed out. Start again.",
  },
  "error.im.noCodeNeeded": {
    zh: "当前不需要输入配对码。",
    en: "No pairing code is needed right now.",
  },
  "error.im.cancelled": { zh: "已取消", en: "Cancelled" },
  "error.im.wrongCode": {
    zh: "配对码不对，请重新输入。",
    en: "That pairing code is wrong. Enter it again.",
  },
  "error.im.takenByOther": {
    zh: "这个机器人已由另一个人连接，需要原来的人扫码，或先在原房间断开。",
    en: "Someone else already connected this bot. They need to scan the code, or disconnect it from its current room first.",
  },
  "error.im.noIdentity": {
    zh: "没有拿到扫码人的身份，请重试。",
    en: "Couldn't tell who scanned the code. Try again.",
  },
  "error.im.channelOff": {
    zh: "这个渠道已被关闭（HIVE_IM_WECHAT=0）。",
    en: "This channel has been turned off (HIVE_IM_WECHAT=0).",
  },
  "error.im.wechatBadAddress": {
    zh: "微信服务地址无效",
    en: "The WeChat service address isn't valid",
  },
  "error.im.wechatUnknownHost": {
    zh: "拒绝未知的微信服务地址：{host}",
    en: "Refused an unknown WeChat service address: {host}",
  },
  "error.im.wechatUnknownRedirect": {
    zh: "拒绝未知的微信跳转地址",
    en: "Refused an unknown WeChat redirect address",
  },
  "error.im.wechatSdkMismatch": {
    zh: "微信 SDK 版本不匹配",
    en: "The WeChat SDK version doesn't match",
  },
  "error.im.wechatSignedOut": {
    zh: "微信登录已失效，请重新扫码。",
    en: "Your WeChat sign-in is no longer valid. Scan the QR code again.",
  },
  "error.im.wechatExpired": {
    zh: "微信登录已过期，请重新扫码连接。",
    en: "Your WeChat sign-in expired. Scan the QR code again to reconnect.",
  },
  "error.im.wechatPollingStopped": {
    zh: "微信消息轮询已停止。",
    en: "Stopped checking WeChat for new messages.",
  },
  "error.im.feishuCode": { zh: "飞书返回错误 {code}", en: "Feishu returned error {code}" },
  "error.im.feishuNoImageKey": {
    zh: "飞书图片上传没有返回 image_key",
    en: "Feishu didn't return an image_key for the uploaded image",
  },
  "error.im.feishuNoFileKey": {
    zh: "飞书文件上传没有返回 file_key",
    en: "Feishu didn't return a file_key for the uploaded file",
  },
  "error.im.fileTooLarge": { zh: "文件超过 20 MiB", en: "The file is larger than 20 MiB" },
} as const satisfies Record<string, Entry>;

export type ServerTextKey = keyof typeof serverTexts;

/** 参数值：字符串、数字，或嵌套的另一段文案（从库里读出的 detailText 是线上形状，同样可以嵌进来） */
export type ServerTextParam = string | number | ServerText | WireServerText;
export type ServerText = { key: ServerTextKey; params?: Record<string, ServerTextParam> };

/** 线上传的形状：key 用字符串而不是枚举，旧网页遇到新键时退回原文，不会整条事件校验失败 */
export type WireServerText = {
  key: string;
  params?: Record<string, WireServerTextParam> | undefined;
};
type WireServerTextParam = string | number | WireServerText;

export const serverTextSchema: z.ZodType<WireServerText> = z.lazy(() =>
  z
    .object({
      key: z.string().min(1).max(120),
      params: z.record(z.union([z.string().max(4000), z.number(), serverTextSchema])).optional(),
    })
    .strict(),
);

export function serverText(
  key: ServerTextKey,
  params?: Record<string, ServerTextParam>,
): ServerText {
  return params ? { key, params } : { key };
}

export function isServerTextKey(key: string): key is ServerTextKey {
  return Object.prototype.hasOwnProperty.call(serverTexts, key);
}

/**
 * 按语言渲染；键不认识（服务端比网页新）时返回 undefined，调用方退回原有的中文字段。
 * 缺英文时退回中文；参数缺失时占位符留空。
 */
export function renderServerText(
  text: WireServerText | undefined,
  locale: ServerLocale,
): string | undefined {
  if (!text || !isServerTextKey(text.key)) return undefined;
  const entry: Entry = serverTexts[text.key];
  return fillTemplate(serverTextTemplate(entry, locale, text.params), (name) => {
    const value = text.params?.[name];
    if (value === undefined) return "";
    if (typeof value === "object") return renderServerText(value, locale) ?? "";
    return String(value);
  });
}

/** 按语言（英文再按数量）挑模板；IM 的文案目录也用它，保证三边单复数规则一致 */
export function serverTextTemplate(
  entry: ServerTextEntry,
  locale: ServerLocale,
  params?: Record<string, unknown>,
): string {
  if (locale !== "en" || !entry.en) return entry.zh;
  if (typeof entry.en === "string") return entry.en;
  return isEnglishSingular(params?.[entry.plural ?? "count"]) ? entry.en.one : entry.en.other;
}

/** 填占位符 {name} */
export function fillTemplate(template: string, value: (name: string) => string): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => value(name));
}

/** 英文的所有写法（测试用：每种写法都要和中文占位符一致、不夹中文） */
export function englishForms(entry: ServerTextEntry): string[] {
  return typeof entry.en === "string" ? [entry.en] : [entry.en.one, entry.en.other];
}

/** 服务端写中文兼容字段用 */
export function zhText(text: ServerText): string {
  return renderServerText(text, "zh-CN") ?? "";
}

/** 模板里的占位符名（测试与检查用） */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}
