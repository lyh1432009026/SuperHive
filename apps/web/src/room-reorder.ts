import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export const storedRoomOrderKey = "superhive.room-order";

export function loadRoomOrder(storage: Pick<Storage, "getItem"> | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(storedRoomOrderKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** 按保存的顺序排房间；没排过的（新建的）保持原来的先后，排在后面 */
export function orderRooms<T extends { id: string }>(
  rooms: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const ra = rank.get(a.room.id);
      const rb = rank.get(b.room.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.index - b.index;
    })
    .map((item) => item.room);
}

/** 把 id 移到 ids 里的 toIndex，返回新的完整顺序 */
export function moveRoom(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const next = ids.filter((item) => item !== id);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id);
  return next;
}

type Slot = { id: string; top: number; height: number };

type Drag = {
  id: string;
  pointerId: number;
  from: number;
  slots: Slot[];
  /** 相邻两项之间的距离（含间隙），其他项让位时移动的距离 */
  shift: number;
  startY: number;
  startScroll: number;
  offset: number;
  over: number;
  /** 松手后正在落位的动画 */
  dropping: boolean;
};

const DRAG_THRESHOLD = 4;
const DROP_MS = 180;
const EDGE = 32;

/**
 * 房间列表拖拽排序：按住拖动，其他房间平滑让位；松手后被拖的那项滑到新位置再提交顺序，不会跳一下。
 * 鼠标直接拖整行（移动超过几像素才算拖，普通点击照常切换房间）；触屏从左侧把手拖，不和列表滚动抢手势。
 * 靠近列表上下边缘时自动滚动。键盘：Alt + ↑/↓ 移动当前房间。
 */
export function useRoomReorder(ids: readonly string[], onReorder: (next: string[]) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<Drag | undefined>(undefined);
  const pendingRef = useRef<{ id: string; pointerId: number; x: number; y: number } | undefined>(
    undefined,
  );
  const suppressClickRef = useRef(false);
  const scrollFrame = useRef<number | undefined>(undefined);
  const lastClientY = useRef(0);
  const [drag, setDrag] = useState<Drag>();
  const [settling, setSettling] = useState(false);

  const measure = useCallback(
    (id: string, pointerId: number, clientY: number): Drag | undefined => {
      const list = listRef.current;
      if (!list) return undefined;
      const listTop = list.getBoundingClientRect().top;
      const slots: Slot[] = [];
      for (const roomId of ids) {
        const element = itemRefs.current.get(roomId);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        slots.push({ id: roomId, top: rect.top - listTop + list.scrollTop, height: rect.height });
      }
      const from = slots.findIndex((slot) => slot.id === id);
      if (from < 0) return undefined;
      const shift = slots.length > 1 ? slots[1]!.top - slots[0]!.top : (slots[0]?.height ?? 36);
      return {
        id,
        pointerId,
        from,
        slots,
        shift,
        startY: clientY,
        startScroll: list.scrollTop,
        offset: 0,
        over: from,
        dropping: false,
      };
    },
    [ids],
  );

  const update = useCallback((clientY: number) => {
    const current = dragRef.current;
    const list = listRef.current;
    if (!current || current.dropping || !list) return;
    lastClientY.current = clientY;
    const offset = clientY - current.startY + (list.scrollTop - current.startScroll);
    const self = current.slots[current.from]!;
    const center = self.top + offset + self.height / 2;
    let over = 0;
    current.slots.forEach((slot, index) => {
      if (index !== current.from && slot.top + slot.height / 2 < center) over += 1;
    });
    const next = { ...current, offset, over };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const autoScroll = useCallback(() => {
    const list = listRef.current;
    if (!dragRef.current || dragRef.current.dropping || !list) return;
    const rect = list.getBoundingClientRect();
    const y = lastClientY.current;
    const delta =
      y < rect.top + EDGE
        ? -Math.ceil((rect.top + EDGE - y) / 4)
        : y > rect.bottom - EDGE
          ? Math.ceil((y - rect.bottom + EDGE) / 4)
          : 0;
    if (delta) {
      list.scrollTop += delta;
      update(y);
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  }, [update]);

  const start = useCallback(
    (id: string, pointerId: number, clientY: number) => {
      const measured = measure(id, pointerId, clientY);
      if (!measured) return;
      dragRef.current = measured;
      lastClientY.current = clientY;
      setDrag(measured);
      document.body.classList.add("room-dragging");
      scrollFrame.current = requestAnimationFrame(autoScroll);
    },
    [autoScroll, measure],
  );

  const finish = useCallback(
    (commit: boolean) => {
      const current = dragRef.current;
      pendingRef.current = undefined;
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
      document.body.classList.remove("room-dragging");
      if (!current) return;
      suppressClickRef.current = true;
      window.setTimeout(() => (suppressClickRef.current = false), 0);
      if (!commit || current.over === current.from) {
        // 放回原位：让它滑回去
        const back = { ...current, offset: 0, over: current.from, dropping: true };
        dragRef.current = back;
        setDrag(back);
        window.setTimeout(() => {
          dragRef.current = undefined;
          setDrag(undefined);
        }, DROP_MS);
        return;
      }
      // 滑到新位置再提交，提交时关掉过渡，DOM 换序后视觉位置不变
      const target = current.slots[current.over]!;
      const self = current.slots[current.from]!;
      const offset =
        current.over > current.from
          ? target.top + target.height - (self.top + self.height)
          : target.top - self.top;
      const landing = { ...current, offset, dropping: true };
      dragRef.current = landing;
      setDrag(landing);
      window.setTimeout(() => {
        setSettling(true);
        onReorder(moveRoom(ids, current.id, current.over));
        dragRef.current = undefined;
        setDrag(undefined);
        requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
      }, DROP_MS);
    },
    [ids, onReorder],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && pending.pointerId === event.pointerId && !dragRef.current) {
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_THRESHOLD)
          return;
        start(pending.id, pending.pointerId, pending.y);
      }
      if (dragRef.current?.pointerId === event.pointerId) {
        event.preventDefault();
        update(event.clientY);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (pendingRef.current?.pointerId === event.pointerId) pendingRef.current = undefined;
      if (dragRef.current?.pointerId === event.pointerId && !dragRef.current.dropping) {
        finish(event.type === "pointerup");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current && !dragRef.current.dropping) finish(false);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish, start, update]);

  useEffect(
    () => () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
      document.body.classList.remove("room-dragging");
    },
    [],
  );

  /** 第 index 项此刻的位移与状态 */
  const itemStyle = (id: string, index: number): { style: CSSProperties; dragging: boolean } => {
    if (!drag) return { style: settling ? { transition: "none" } : {}, dragging: false };
    if (id === drag.id) {
      return {
        style: {
          transform: `translateY(${drag.offset}px)`,
          transition: drag.dropping ? `transform ${DROP_MS}ms cubic-bezier(0.2, 0, 0, 1)` : "none",
        },
        dragging: true,
      };
    }
    let move = 0;
    if (drag.from < drag.over && index > drag.from && index <= drag.over) move = -drag.shift;
    if (drag.over < drag.from && index >= drag.over && index < drag.from) move = drag.shift;
    return { style: move ? { transform: `translateY(${move}px)` } : {}, dragging: false };
  };

  const itemProps = (id: string) => ({
    ref: (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(id, element);
      else itemRefs.current.delete(id);
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || dragRef.current) return;
      const target = event.target as HTMLElement;
      const handle = target.closest(".room-drag-handle");
      // 触屏只从把手拖，免得和上下滚动列表冲突；管理按钮不触发拖拽
      if (event.pointerType === "touch" && !handle) return;
      if (target.closest(".room-item-manage")) return;
      if (handle) {
        event.preventDefault();
        start(id, event.pointerId, event.clientY);
        return;
      }
      pendingRef.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      // 刚拖完松手时浏览器还会补一个 click，不能因此切换房间
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const index = ids.indexOf(id);
      const to = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (index < 0 || to < 0 || to >= ids.length) return;
      onReorder(moveRoom(ids, id, to));
      requestAnimationFrame(() =>
        itemRefs.current.get(id)?.querySelector<HTMLElement>(".room-item-main")?.focus(),
      );
    },
  });

  return { listRef, itemProps, itemStyle, dragging: Boolean(drag) };
}
