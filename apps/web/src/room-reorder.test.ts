import { describe, expect, it } from "vitest";
import { loadRoomOrder, moveRoom, orderRooms } from "./room-reorder";

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
  it("ignores a broken saved value", () => {
    expect(loadRoomOrder({ getItem: () => "not json" })).toEqual([]);
    expect(loadRoomOrder({ getItem: () => '["a", 1, "b"]' })).toEqual(["a", "b"]);
  });
});
