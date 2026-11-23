import { serverText, type RoomSummary, type ServerText } from "@superhive/protocol";
import { HiveError } from "./database.js";

/** 出错时最多列出多少个候选房间，免得房间多了撑爆 Agent 的上下文 */
export const ROOM_CANDIDATE_LIMIT = 20;

/** 比较用：去掉首尾空格和开头的 #，忽略大小写 */
export function normalizeRoomQuery(value: string): string {
  return value.trim().replace(/^#+/, "").trim().toLocaleLowerCase();
}

/** 「id（名称）、id（名称）…」，超过上限的只给总数；按语言用各自的分隔符 */
export function roomCandidatesText(
  rooms: Array<Pick<RoomSummary, "id" | "name">>,
  limit = ROOM_CANDIDATE_LIMIT,
): ServerText {
  const shown = rooms.slice(0, limit);
  const items = shown.map((room) =>
    serverText("roomPost.candidate", { id: room.id, name: room.name }),
  );
  let list = items[0]!;
  for (const item of items.slice(1))
    list = serverText("roomPost.candidateJoin", { head: list, tail: item });
  if (rooms.length <= shown.length) return list;
  return serverText("roomPost.candidatesMore", {
    list,
    more: rooms.length - shown.length,
  });
}

/**
 * 跨房间操作时把 Agent 填的房间解析成具体房间：先按 ID 精确匹配，再按显示名称在未归档房间里找
 * （忽略大小写、首尾空格和开头的 #）。人常说的是房间的显示名称，Agent 又没有列房间的工具，
 * 所以找不到或同名时把候选房间的 ID 和名称写进错误，让 Agent 自己改用 ID 重试。
 * rooms 是调用者能看到的未归档房间；exclude 是不该出现在候选里的房间（比如当前房间）。
 */
export function resolveRoom(
  query: string,
  rooms: RoomSummary[],
  options: { exclude?: string } = {},
): RoomSummary {
  const raw = query.trim().replace(/^#+/, "").trim();
  const live = rooms.filter((room) => !room.archivedAt);
  const byId = live.find((room) => room.id === raw);
  if (byId) return byId;
  const key = normalizeRoomQuery(raw);
  const byName = live.filter((room) => normalizeRoomQuery(room.name) === key);
  // ID 只差大小写也算命中（ID 不允许重复，只有一个时不会有歧义）
  const byIdLoose = live.filter((room) => room.id.toLocaleLowerCase() === key);
  const matches = [...new Map([...byName, ...byIdLoose].map((room) => [room.id, room])).values()];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new HiveError(
      "ROOM_AMBIGUOUS",
      serverText("error.room.targetAmbiguous", {
        room: raw,
        candidates: roomCandidatesText(matches),
      }),
    );
  }
  const candidates = live.filter((room) => room.id !== options.exclude);
  throw new HiveError(
    "ROOM_NOT_FOUND",
    candidates.length > 0
      ? serverText("error.room.targetNotFound", {
          room: raw,
          candidates: roomCandidatesText(candidates),
        })
      : serverText("error.room.targetNoneAvailable", { room: raw }),
  );
}

/** 新建房间时，已有未归档房间的 ID 或显示名称和新房间的显示名称撞了：按名称派活会有歧义，提醒用 ID */
export function roomsNamedLike(name: string, rooms: RoomSummary[], exclude: string): RoomSummary[] {
  const key = normalizeRoomQuery(name);
  return rooms.filter(
    (room) =>
      room.id !== exclude &&
      !room.archivedAt &&
      (normalizeRoomQuery(room.name) === key || room.id.toLocaleLowerCase() === key),
  );
}
