import { z } from "zod";

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

type Entry = { zh: string; en: string };

export const serverTexts = {
  /* ---------- 通用 ---------- */
  "common.unknown": { zh: "未知", en: "unknown" },

  /* ---------- 调用（任务）状态说明 ---------- */
  "invocation.delivered": { zh: "已送达，排队中", en: "Delivered, waiting in queue" },
  "invocation.steerRequested": {
    zh: "{name} 请求插入当前任务",
    en: "{name} asked to add this to the current task",
  },
  "invocation.preemptRequested": {
    zh: "{name} 已请求停下当前任务，停下后先做这一条",
    en: "{name} asked to stop the current task and do this one first",
  },
  "invocation.steerSend": {
    zh: "发送并插话：请求插入当前任务",
    en: "Sent as steer: asked to add this to the current task",
  },
  "invocation.steerAuto": {
    zh: "自动插话：请求插入当前任务",
    en: "Auto steer: asked to add this to the current task",
  },
  "invocation.answered": {
    zh: "{name} 已回答（#{seq}），已续到新的调用",
    en: "{name} answered (#{seq}); continued in a new task",
  },
  "invocation.waitingAnswer": {
    zh: "等人回答：{question}",
    en: "Waiting for an answer: {question}",
  },
  "invocation.cancelledBy": { zh: "{name} 取消了", en: "Cancelled by {name}" },
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
  "invocation.recalledNotRun": { zh: "消息已撤回，未执行", en: "Message recalled; not run" },
} as const satisfies Record<string, Entry>;

export type ServerTextKey = keyof typeof serverTexts;

export type ServerTextParam = string | number | ServerText;
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
  const template = locale === "en" ? entry.en || entry.zh : entry.zh;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = text.params?.[name];
    if (value === undefined) return "";
    if (typeof value === "object") return renderServerText(value, locale) ?? "";
    return String(value);
  });
}

/** 服务端写中文兼容字段用 */
export function zhText(text: ServerText): string {
  return renderServerText(text, "zh-CN") ?? "";
}

/** 模板里的占位符名（测试与检查用） */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}
