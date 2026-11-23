import { describe, expect, it } from "vitest";
import { desktopBridge } from "./desktop-bridge";

const fn = () => () => undefined;
const terminal = {
  create: fn,
  write: fn,
  resize: fn,
  kill: fn,
  onData: fn,
  onExit: fn,
  onNewRequest: fn,
};

describe("desktopBridge", () => {
  it("is absent in a normal browser", () => {
    expect(desktopBridge(undefined)).toBeUndefined();
    expect(desktopBridge()).toBeUndefined();
  });

  it("accepts the shape the desktop preload exposes", () => {
    const bridge = { version: 1, platform: "darwin", terminal };
    expect(desktopBridge(bridge)).toBe(bridge);
  });

  it("rejects incompatible versions and incomplete objects", () => {
    expect(desktopBridge({ version: 2, platform: "darwin", terminal })).toBeUndefined();
    expect(desktopBridge({ version: 1, platform: "darwin" })).toBeUndefined();
    expect(
      desktopBridge({ version: 1, platform: "darwin", terminal: { ...terminal, kill: "nope" } }),
    ).toBeUndefined();
    expect(desktopBridge("superhive")).toBeUndefined();
  });
});
