import { describe, expect, it } from "vitest";
import { moveRoom, orderRooms, sortRoomsForSidebar } from "./room-reorder";

describe("room order", () => {
  it("sorts by the saved order and keeps unsorted rooms after, in their original order", () => {
    const rooms = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(orderRooms(rooms, ["c", "a"]).map((room) => room.id)).toEqual(["c", "a", "b", "d"]);
    expect(orderRooms(rooms, ["gone", "d"]).map((room) => room.id)).toEqual(["d", "a", "b", "c"]);
  });
  it("moves a room to a position", () => {
    expect(moveRoom(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveRoom(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveRoom(["a", "b", "c"], "x", 0)).toEqual(["a", "b", "c"]);
  });
  it("puts pinned rooms first in pin order, then the rest by latest message", () => {
    const at = (minute: number) => `2026-11-13T04:${String(minute).padStart(2, "0")}:00.000Z`;
    const { pinned, others } = sortRoomsForSidebar([
      { id: "quiet", createdAt: at(1) },
      { id: "busy", createdAt: at(0), lastActivityAt: at(30) },
      { id: "second", createdAt: at(0), lastActivityAt: at(5), pinned: 1 },
      { id: "first", createdAt: at(0), pinned: 0 },
      { id: "old", createdAt: at(0), lastActivityAt: at(50), archivedAt: at(51) },
      { id: "recent", createdAt: at(0), lastActivityAt: at(20) },
    ]);
    expect(pinned.map((room) => room.id)).toEqual(["first", "second"]);
    // 还没有消息的按创建时间算；已归档的不管多新都放最后
    expect(others.map((room) => room.id)).toEqual(["busy", "recent", "quiet", "old"]);
  });
});
