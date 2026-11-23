import { describe, expect, it } from "vitest";
import { renderServerText, type RoomSummary } from "@superhive/protocol";
import { HiveError } from "./database.js";
import { resolveRoom, roomCandidatesText, roomsNamedLike } from "./room-lookup.js";

const room = (id: string, name: string, archivedAt?: string): RoomSummary =>
  ({
    id,
    name,
    createdAt: "2026-11-23T00:00:00.000Z",
    ...(archivedAt ? { archivedAt } : {}),
  }) as RoomSummary;

const rooms = [
  room("general", "大厅"),
  room("z-code", "Z 代码"),
  room("mail", "Mail Connectors"),
  room("old", "Archived Room", "2026-11-01T00:00:00.000Z"),
  room("dup-a", "设计"),
  room("dup-b", "设计"),
];

function failure(query: string, list = rooms, exclude = "general"): HiveError {
  try {
    resolveRoom(query, list, { exclude });
  } catch (error) {
    expect(error).toBeInstanceOf(HiveError);
    return error as HiveError;
  }
  throw new Error(`expected ${query} to fail`);
}

describe("resolveRoom", () => {
  it("matches the room ID exactly first, with or without a leading #", () => {
    expect(resolveRoom("z-code", rooms).id).toBe("z-code");
    expect(resolveRoom("#z-code", rooms).id).toBe("z-code");
    expect(resolveRoom("  #mail ", rooms).id).toBe("mail");
  });

  it("prefers an exact ID over another room whose display name equals it", () => {
    const list = [room("design", "Design"), room("other", "design")];
    expect(resolveRoom("design", list).id).toBe("design");
  });

  it("falls back to the display name, ignoring case, surrounding spaces and a leading #", () => {
    expect(resolveRoom("Z 代码", rooms).id).toBe("z-code");
    expect(resolveRoom("mail connectors", rooms).id).toBe("mail");
    expect(resolveRoom("  #MAIL CONNECTORS  ", rooms).id).toBe("mail");
    expect(resolveRoom("Z-CODE", rooms).id).toBe("z-code");
  });

  it("skips archived rooms, even by exact ID", () => {
    expect(failure("old").code).toBe("ROOM_NOT_FOUND");
    expect(failure("archived room").code).toBe("ROOM_NOT_FOUND");
  });

  it("refuses an ambiguous display name and lists each candidate's ID and name", () => {
    const error = failure("设计");
    expect(error.code).toBe("ROOM_AMBIGUOUS");
    expect(renderServerText(error.text!, "zh-CN")).toBe(
      "有多个房间的显示名称都是「设计」：dup-a（设计）、dup-b（设计）。改用其中一个的 ID 重试。",
    );
    expect(renderServerText(error.text!, "en")).toBe(
      'More than one room is named "设计": dup-a (设计), dup-b (设计). Retry with one of these IDs.',
    );
  });

  it("lists the available rooms (not archived, not the current room) when nothing matches", () => {
    const error = failure("#nowhere");
    expect(error.code).toBe("ROOM_NOT_FOUND");
    const zh = renderServerText(error.text!, "zh-CN");
    expect(zh).toBe(
      "没有 ID 或显示名称是「nowhere」的房间（或已归档）。可用的房间：z-code（Z 代码）、mail（Mail Connectors）、dup-a（设计）、dup-b（设计）。改用其中一个的 ID 重试。",
    );
    expect(zh).not.toContain("general");
    expect(zh).not.toContain("old");
    expect(renderServerText(error.text!, "en")).toContain(
      "Available rooms: z-code (Z 代码), mail (Mail Connectors), dup-a (设计), dup-b (设计).",
    );
  });

  it("says so when there is no other room at all", () => {
    const error = failure("nowhere", [room("general", "大厅")]);
    expect(error.code).toBe("ROOM_NOT_FOUND");
    expect(renderServerText(error.text!, "zh-CN")).toContain("hive_room_create");
  });

  it("caps the candidate list", () => {
    const many = Array.from({ length: 25 }, (_, index) => room(`r${index}`, `Room ${index}`));
    const text = roomCandidatesText(many, 3);
    expect(renderServerText(text, "zh-CN")).toBe(
      "r0（Room 0）、r1（Room 1）、r2（Room 2），还有 22 个",
    );
    expect(renderServerText(text, "en")).toBe("r0 (Room 0), r1 (Room 1), r2 (Room 2), and 22 more");
  });
});

describe("roomsNamedLike", () => {
  it("finds live rooms whose name or ID collides with a new room's name", () => {
    expect(roomsNamedLike("设计", rooms, "dup-a").map((item) => item.id)).toEqual(["dup-b"]);
    expect(roomsNamedLike("Z-Code", rooms, "new").map((item) => item.id)).toEqual(["z-code"]);
    expect(roomsNamedLike("archived room", rooms, "new")).toEqual([]);
  });
});
