import type { ChatMessage, Invocation, Participant, RoomSummary } from "@superhive/protocol";
import { attentionLabels, type AttentionItem } from "./attention";
import { t } from "./i18n";

/**
 * Go To 跳转器的数据：房间、当前房间的 Agent、跨房间的任务，一个列表里搜。
 * 「需要处理」用 attention.ts 排好序的列表（和侧栏、提醒、⌘J 同一口径），这里只按它的顺序排。
 */
export type GoToKind = "room" | "agent" | "task";
export type GoToFilter = "all" | "attention" | GoToKind;

export type GoToItem =
  | {
      kind: "room";
      key: string;
      title: string;
      subtitle?: string;
      search: string;
      attention: number;
      current: boolean;
      room: RoomSummary;
    }
  | {
      kind: "agent";
      key: string;
      title: string;
      subtitle?: string;
      search: string;
      attention: number;
      participant: Participant;
      /** 它手上最该看的那条任务：要处理的、正在执行的、最近更新的，依次挑 */
      task?: Invocation;
    }
  | {
      kind: "task";
      key: string;
      title: string;
      subtitle?: string;
      search: string;
      attention: number;
      invocation: Invocation;
    };

function preview(content: string, length = 80): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

export function buildGoToItems(input: {
  rooms: readonly RoomSummary[];
  currentRoomId: string;
  participants: readonly Participant[];
  /** 进行中和需要处理的调用（跨房间） */
  invocations: Iterable<Invocation>;
  /** attention.ts 的 collectAttention 结果，已按紧急程度排好 */
  attention: readonly AttentionItem[];
  messages: ReadonlyMap<string, ChatMessage>;
  /** 任务状态文字（复用调用状态的标签，带多语言） */
  statusLabel: (invocation: Invocation) => string;
}): GoToItem[] {
  const roomNames = new Map(input.rooms.map((room) => [room.id, room.name]));
  const rank = new Map(input.attention.map((item, index) => [item.invocation.id, index]));
  const kindOf = new Map(input.attention.map((item) => [item.invocation.id, item.kind]));
  // 完成未看的调用不在进行中列表里，从 attention 补进来
  const byId = new Map<string, Invocation>();
  for (const invocation of input.invocations) byId.set(invocation.id, invocation);
  for (const item of input.attention) byId.set(item.invocation.id, item.invocation);
  const invocations = [...byId.values()];
  const attentionByRoom = new Map<string, number>();
  for (const item of input.attention) {
    attentionByRoom.set(item.roomId, (attentionByRoom.get(item.roomId) ?? 0) + 1);
  }

  const tasks: Extract<GoToItem, { kind: "task" }>[] = invocations.map((invocation) => {
    const message = input.messages.get(invocation.messageId);
    const roomName = roomNames.get(invocation.roomId) ?? invocation.roomId;
    const kind = kindOf.get(invocation.id);
    return {
      kind: "task",
      key: `task:${invocation.id}`,
      title: `@${invocation.agentName} · ${kind ? attentionLabels[kind] : input.statusLabel(invocation)}`,
      subtitle: [`#${roomName}`, message ? preview(message.content) : invocation.detail]
        .filter(Boolean)
        .join(" · "),
      search: [
        invocation.agentName,
        roomName,
        message?.senderName,
        message?.content,
        invocation.detail,
      ]
        .filter(Boolean)
        .join(" "),
      attention: kind ? 1 : 0,
      invocation,
    };
  });
  tasks.sort(
    (a, b) =>
      (rank.get(a.invocation.id) ?? Infinity) - (rank.get(b.invocation.id) ?? Infinity) ||
      b.invocation.updatedAt.localeCompare(a.invocation.updatedAt),
  );

  const agents: GoToItem[] = input.participants
    .filter((participant) => participant.type === "agent")
    .map((participant) => {
      const own = tasks
        .map((task) => task.invocation)
        .filter((invocation) => invocation.agentId === participant.id);
      const attention = own.filter((invocation) => rank.has(invocation.id)).length;
      const pick =
        own.find((invocation) => rank.has(invocation.id)) ??
        own.find((invocation) => invocation.status !== "queued") ??
        own[0];
      const state =
        participant.status === "offline"
          ? t("离线")
          : participant.status === "busy"
            ? t("忙碌")
            : t("在线");
      return {
        kind: "agent" as const,
        key: `agent:${participant.id}`,
        title: `@${participant.username}`,
        subtitle: [state, pick ? input.statusLabel(pick) : undefined].filter(Boolean).join(" · "),
        search: [participant.username, participant.provider, participant.persona]
          .filter(Boolean)
          .join(" "),
        attention,
        participant,
        ...(pick ? { task: pick } : {}),
      };
    })
    .sort((a, b) => b.attention - a.attention || a.title.localeCompare(b.title));

  const rooms: GoToItem[] = input.rooms
    .filter((room) => !room.archivedAt)
    .map((room) => ({
      kind: "room" as const,
      key: `room:${room.id}`,
      title: `#${room.name}`,
      ...(room.branch || room.workspace
        ? { subtitle: [room.branch, room.workspace].filter(Boolean).join(" · ") }
        : {}),
      search: [room.name, room.id, room.branch, room.workspace, room.leadAgent]
        .filter(Boolean)
        .join(" "),
      attention: attentionByRoom.get(room.id) ?? 0,
      current: room.id === input.currentRoomId,
      room,
    }));

  return [
    ...tasks.filter((item) => item.attention),
    ...rooms,
    ...agents,
    ...tasks.filter((item) => !item.attention),
  ];
}

/**
 * 匹配打分：名字开头 > 名字包含 > 其它字段包含 > 按顺序出现的子序列；不匹配返回 -1。
 * 多个词（空格分开）都要匹配上。
 */
export function scoreGoToItem(item: GoToItem, query: string): number {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const title = item.title.toLocaleLowerCase().replace(/^[#@]/, "");
  const haystack = `${item.title} ${item.subtitle ?? ""} ${item.search}`.toLocaleLowerCase();
  let total = 0;
  for (const word of words) {
    const needle = word.replace(/^[#@]/, "");
    if (title.startsWith(needle)) total += 4;
    else if (title.includes(needle)) total += 3;
    else if (haystack.includes(needle)) total += 2;
    else if (isSubsequence(needle, title)) total += 1;
    else return -1;
  }
  return total;
}

function isSubsequence(needle: string, text: string): boolean {
  let cursor = 0;
  for (const char of text) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return needle.length === 0;
}

export function filterGoToItems(items: GoToItem[], query: string, filter: GoToFilter): GoToItem[] {
  const scoped = items.filter((item) =>
    filter === "all" ? true : filter === "attention" ? item.attention > 0 : item.kind === filter,
  );
  if (!query.trim()) return scoped;
  return scoped
    .map((item, index) => ({ item, index, score: scoreGoToItem(item, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
