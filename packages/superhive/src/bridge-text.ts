/**
 * Bridge 上报给服务端的调用说明：除了中文 detail（旧服务端、Agent 都读它），再带一份结构化文案
 * detailText，网页按用户语言渲染。键和中文模板必须与 @superhive/protocol 的 server-text.ts 一致
 * （bridge-text.test.ts 核对）；英文只在那边维护。这个包不依赖 protocol，所以这里只放中文。
 */
export const BRIDGE_TEXTS = {
  "bridge.worktreeCleaned": "任务目录已被清理，本轮无需继续执行：{path}",
  "bridge.worktreeFocusDropped":
    "上次用的任务目录 {path} 不能再用（{reason}），这次没有沿用，在默认工作目录开工；已提醒 Agent 改代码前先用 hive_worktree_create 建新任务目录",
  "bridge.worktreeCheckBeforeContinue":
    "已绑定目录 {path}，但本轮已有其它副作用（{step}）；未自动续跑，请核对原目录的操作后再继续",
  "bridge.worktreeHandoff": "已切到独立目录 {path}，开新会话继续；旧会话不迁移",
  "bridge.worktreeBusy":
    "暂时没能确认这次该在哪个任务目录里干活（{reason}），已自动重试仍未成功；这一轮还没开始执行，稍后点「重试」即可",
  "bridge.transientFailed":
    "暂时没成功：{reason}。已自动重试 {count} 次；这一轮还没开始执行，稍后点「重试」即可。",
  "bridge.unsafe": "已停下，不会自动重试：{reason}。先按原因处理，再决定是否重试。",
  "bridge.worktreeSteerQueued": "这条消息绑定了另一个工作目录 {path}，不能引导当前任务，已排队",
  "bridge.crashedMidTurn":
    "Agent 在处理途中意外退出，结果未知；未自动重跑，需先核对原执行与工具进程。",
  "bridge.beyondCatchUp": "Agent 首次加入时这条提及已超出补拉范围，未处理；可手动重试。",
  "bridge.reconnectedGone":
    "Agent 重新连接时这次处理已不在进行，结果未知；需先核对原执行与工具进程。",
  "bridge.cancelledBeforeRun": "任务在执行前被取消",
  "bridge.notSteeredQueued": "当前没有正在执行、能引导的任务，已排队",
  "bridge.steerUnsupported": "这个运行时不支持引导，已排队",
  "bridge.steering": "正在引导",
  "bridge.steerUnconfirmed": "消息已尝试注入但未获确认；禁止退回队列或自动重放。",
  "bridge.steerRemoved": "未注入的排队任务已移除",
  "bridge.steerCancelRace": "取消与注入并发，执行结果需核对",
  "bridge.steerEndRace": "消息注入与回合结束并发，结果待核实；禁止自动重放。",
  "bridge.steered": "已并入当前任务（#{seq}）",
  "bridge.steerLate": "没能引导当前任务（这一轮已经收尾），已排队",
  "bridge.stoppedWhileWaiting": "等待自动继续时被停止",
  "bridge.cancelNotPersisted": "无法持久化取消结果，需核对",
  "bridge.queuedRemoved": "尚未执行的排队任务已移除",
  "bridge.alreadyEnded":
    "这一轮在 Agent 这边早已结束，没有在跑的回合；当初的结果仍未知，请先核对再决定是否重试。",
  "bridge.stoppedNoReply": "本轮已结束，已停止的触发消息未发送回复",
  "bridge.stopDeferred":
    "已请求停止，但同一轮还在处理其它没停的消息，这一轮会继续；这条不再回复，这一轮结束后标为已停止",
  "bridge.noReply": "无需回复",
  "bridge.uncertain":
    "这一轮没做完就停了：{reason} 停下前可能已经执行过工具（改文件、跑命令等），所以没有自动重跑。点「继续」会接着原会话，先核对已做的再往下做；不需要了点「忽略」。",
  "bridge.offline": "Agent 已下线，本轮被中断；可在界面中重试",
  "bridge.failedRepeatedly": "连续失败 {attempts} 次：{reason}",
  "bridge.upstreamFailed":
    "上游模型服务出错：{reason}。{why}；点「继续」会接着原会话从中断处往下做，不需要了点「忽略」。",
  "bridge.upstreamMutated": "这一轮已经做过改动，不自动重跑",
  "bridge.upstreamExhausted": "已自动继续 {count} 次仍未成功",
  "bridge.fix.login":
    "凭证无效或没有登录，等多久都不会好，没有自动重试；先在这台电脑上重新登录这个 Agent 的 CLI 或检查 API key",
  "bridge.fix.quota":
    "用量额度用完了，到重置时间才会恢复，没有自动重试；等额度恢复或换个账号后再处理，也可以点「换个模型重试」",
  "bridge.fix.billing": "账户余额不足或欠费，没有自动重试；先充值或检查账单",
  "bridge.fix.context":
    "对话超出了模型的上下文长度，没有自动重试；接着原会话多半还会超，建议开个新话题再派，或点「换个模型重试」换上下文更长的模型",
  "bridge.fix.refused":
    "模型拒绝回答，原样重试结果一样，没有自动重试；可以换个说法重新派，或点「换个模型重试」",
  "bridge.fix.request":
    "模型服务拒绝了这次请求，原样重试结果一样，没有自动重试；多半是运行时或模型配置的问题，先检查配置",
  "bridge.sessionRetrying": "会话已失效（{reason}），已开新会话重试",
  "bridge.sessionInvalid": "会话已失效：{reason}。{why}；点「重试」会开新会话。",
  "bridge.sessionExecuted": "这一轮已经开始执行工具，不自动重跑",
  "bridge.sessionRetried": "开了新会话还是失败",
  "bridge.modelFailed":
    "模型用不了：{reason}。等多久都不会好，点「换个模型重试」选别的模型，或者在 Agent 设置里改模型。",
  "bridge.usingModel": "这次用 {model} 重试",
  "bridge.crashResumed":
    "Agent 中途意外退出，这一轮还没做过任何改动，已自动重新执行（第 {count}/{limit} 次）",
  "bridge.crashResumedDone": "中途意外退出后已自动恢复 {count} 次",
  "bridge.crashResumedNoReply": "无需回复（中途意外退出后已自动恢复 {count} 次）",
  "bridge.crashedAfterResume":
    "Agent 在处理途中再次意外退出（已自动恢复过 {count} 次），结果未知；不再自动重跑，需先核对原执行与工具进程。",
  "bridge.crashedIrreversible":
    "Agent 在处理途中意外退出，中断时正在执行：{step}；它做没做完不确定，确认后点「继续」，Agent 会先核对再往下做。",
  "bridge.crashedRuntimeAlive":
    "Agent 在处理途中意外退出，原运行时进程还没退出、可能仍在执行；未自动重跑，需先核对原执行与工具进程。",
  "bridge.crashResumeStopped": "Agent 中途意外退出后、自动恢复前已被停止，未重新执行",
} as const;

export type BridgeTextKey = keyof typeof BRIDGE_TEXTS;
export type BridgeText = {
  key: BridgeTextKey;
  params?: Record<string, string | number | BridgeText>;
};

function render(text: BridgeText): string {
  return BRIDGE_TEXTS[text.key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = text.params?.[name];
    if (value === undefined) return "";
    return typeof value === "object" ? render(value) : String(value);
  });
}

export function bridgeText(
  key: BridgeTextKey,
  params?: Record<string, string | number | BridgeText>,
): BridgeText {
  return params ? { key, params } : { key };
}

/** 中文正文（日志、进度一行） */
export function bridgeTextZh(text: BridgeText): string {
  return render(text);
}

/** 上报用：detail 是中文（截到 limit），detailText 是结构化文案 */
export function said(text: BridgeText, limit = 500): { detail: string; detailText: BridgeText } {
  return { detail: render(text).slice(0, limit), detailText: text };
}
