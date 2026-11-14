/**
 * Bridge 上报给服务端的调用说明：除了中文 detail（旧服务端、Agent 都读它），再带一份结构化文案
 * detailText，网页按用户语言渲染。键和中文模板必须与 @superhive/protocol 的 server-text.ts 一致
 * （bridge-text.test.ts 核对）；英文只在那边维护。这个包不依赖 protocol，所以这里只放中文。
 */
export const BRIDGE_TEXTS = {
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
  "bridge.noReply": "无需回复",
  "bridge.uncertain": "{reason} 已禁止自动重放；请先核对已执行操作再决定是否重试。",
  "bridge.offline": "Agent 已下线，本轮被中断；可在界面中重试",
  "bridge.failedRepeatedly": "连续失败 {attempts} 次：{reason}",
  "bridge.upstreamFailed":
    "上游模型服务出错：{reason}。{why}；点「继续」会接着原会话从中断处往下做。",
  "bridge.upstreamMutated": "这一轮已经做过改动，不自动重跑",
  "bridge.upstreamExhausted": "已自动继续 {count} 次仍未成功",
  "bridge.sessionRetrying": "会话已失效（{reason}），已开新会话重试",
  "bridge.sessionInvalid": "会话已失效：{reason}。{why}；点「重试」会开新会话。",
  "bridge.sessionExecuted": "这一轮已经开始执行工具，不自动重跑",
  "bridge.sessionRetried": "开了新会话还是失败",
  "bridge.modelFailed":
    "模型用不了：{reason}。等多久都不会好，点「换个模型重试」选别的模型，或者在 Agent 设置里改模型。",
  "bridge.usingModel": "这次用 {model} 重试",
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
