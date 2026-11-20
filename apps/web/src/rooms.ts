import type { RoomSummary } from "@superhive/protocol";
import { storedRoomKey } from "./app-storage";

export const roomIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function roomIdFromHash(): string | undefined {
  const value = window.location.hash.replace(/^#/, "");
  return roomIdPattern.test(value) ? value : undefined;
}

export function initialRoomId(): string {
  const value = roomIdFromHash() ?? localStorage.getItem(storedRoomKey);
  return value && roomIdPattern.test(value) ? value : "general";
}

export function sortRooms(rooms: RoomSummary[]): RoomSummary[] {
  return [...rooms].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
