import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MetaResponse, RoomSummary, RoomsResponse } from "@superhive/protocol";
import {
  sortRoomsForSidebar,
  orderRooms,
  storedRoomOrderKey,
  useRoomReorder,
} from "./room-reorder";
import { serverError } from "./server-text";
import { readSeqStorageKey } from "./app-storage";
import { sortRooms } from "./rooms";
import { t } from "./i18n";

/** 房间列表：各房间摘要、已读位置、侧栏排序与置顶 */
export function useRoomList({
  base,
  authToken,
  meta,
  isOwner,
  username,
  latestSeqRef,
  setError,
}: {
  base: string;
  authToken: string | undefined;
  meta: MetaResponse | undefined;
  isOwner: boolean;
  username: string;
  latestSeqRef: RefObject<number>;
  setError: Dispatch<SetStateAction<string | undefined>>;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [readSeqs, setReadSeqs] = useState<Record<string, number>>({});
  const [showArchivedRooms, setShowArchivedRooms] = useState(false);
  // 房间顺序：置顶的在最前（顺序存在服务端，跟着房主走），其余按最近活跃倒序。
  // 鼠标停在列表上或焦点在列表里时，不置顶区暂停重排，免得正要点的房间被新消息顶走
  const [roomListFrozen, setRoomListFrozen] = useState<string[]>();
  const sidebarRooms = useMemo(() => {
    const sorted = sortRoomsForSidebar(
      rooms
        .filter((room) => showArchivedRooms || !room.archivedAt)
        // 访客看不到房主的置顶
        .map((room) =>
          isOwner || room.pinned === undefined ? room : { ...room, pinned: undefined },
        ),
    );
    return roomListFrozen
      ? { pinned: sorted.pinned, others: orderRooms(sorted.others, roomListFrozen) }
      : sorted;
  }, [isOwner, roomListFrozen, rooms, showArchivedRooms]);
  const pinnedRoomIds = useMemo(
    () => sidebarRooms.pinned.map((room) => room.id),
    [sidebarRooms.pinned],
  );
  const freezeRoomList = () =>
    setRoomListFrozen((current) => current ?? sidebarRooms.others.map((room) => room.id));
  const thawRoomList = (element: HTMLElement) => {
    if (element.matches(":hover") || element.contains(document.activeElement)) return;
    setRoomListFrozen(undefined);
  };
  const refreshRoomsRef = useRef<() => Promise<unknown>>(undefined);
  /** 整份写回置顶列表：先在本地改好，服务端确认后会广播新的房间摘要 */
  const savePinnedRooms = useCallback(
    (next: string[]) => {
      const index = new Map(next.map((id, position) => [id, position]));
      setRooms((current) =>
        current.map((room) => {
          const pinned = index.get(room.id);
          if (pinned === room.pinned) return room;
          const { pinned: _old, ...rest } = room;
          void _old;
          return pinned === undefined ? rest : { ...rest, pinned };
        }),
      );
      void fetch(`${base}/api/room-pins`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ roomIds: next }),
      })
        .then(async (response) => {
          if (!response.ok) {
            const failure: unknown = await response.json().catch(() => ({}));
            throw new Error(
              serverError(failure) ?? t("置顶没保存上（{0}）", { 0: response.status }),
            );
          }
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          // 没存上就以服务端为准重新拉一遍
          void refreshRoomsRef.current?.().catch(() => undefined);
        });
    },
    [authToken, base],
  );
  // 拖动和 Alt+↑/↓ 只在置顶区里排序
  const roomReorder = useRoomReorder(pinnedRoomIds, savePinnedRooms);
  useEffect(() => {
    try {
      localStorage.removeItem(storedRoomOrderKey);
    } catch {
      // 清不掉也无妨：已经不再读取
    }
  }, []);
  const activeRoomCount = useMemo(() => rooms.filter((room) => !room.archivedAt).length, [rooms]);

  const markRoomRead = useCallback((roomId: string) => {
    const seq = latestSeqRef.current;
    if (seq <= 0) return;
    const stored = Number(localStorage.getItem(readSeqStorageKey(roomId)) ?? "0");
    if (seq > stored) localStorage.setItem(readSeqStorageKey(roomId), String(seq));
    setReadSeqs((current) =>
      (current[roomId] ?? 0) >= seq ? current : { ...current, [roomId]: seq },
    );
  }, []);

  const upsertRoom = useCallback((room: RoomSummary) => {
    setRooms((current) =>
      sortRooms([...current.filter((existing) => existing.id !== room.id), room]),
    );
  }, []);

  const refreshRooms = useCallback(async () => {
    if (!meta || !authToken) return;
    const response = await fetch(`${base}/api/rooms?includeArchived=true`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(t("房间列表拉取失败 ({0})", { 0: response.status }));
    const payload = (await response.json()) as RoomsResponse;
    setRooms(sortRooms(payload.rooms));
    setReadSeqs((current) => {
      const next = { ...current };
      for (const room of payload.rooms) {
        if (next[room.id] === undefined) {
          next[room.id] = Number(localStorage.getItem(readSeqStorageKey(room.id)) ?? "0");
        }
      }
      return next;
    });
  }, [authToken, base, meta]);
  refreshRoomsRef.current = refreshRooms;

  useEffect(() => {
    if (!meta || !username) return;
    void refreshRooms().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [meta, refreshRooms, username]);

  function markRoomReadNow(room: RoomSummary) {
    localStorage.setItem(readSeqStorageKey(room.id), String(room.latestSeq));
    setReadSeqs((current) => ({ ...current, [room.id]: room.latestSeq }));
  }

  return {
    rooms,
    setRooms,
    readSeqs,
    setReadSeqs,
    showArchivedRooms,
    setShowArchivedRooms,
    sidebarRooms,
    pinnedRoomIds,
    freezeRoomList,
    thawRoomList,
    savePinnedRooms,
    roomReorder,
    activeRoomCount,
    markRoomRead,
    upsertRoom,
    refreshRooms,
    markRoomReadNow,
  };
}
