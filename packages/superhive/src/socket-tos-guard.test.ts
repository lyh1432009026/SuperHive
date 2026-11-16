import net from "node:net";
import { describe, expect, it } from "vitest";
import { guardSocketTypeOfService } from "./socket-tos-guard.js";

describe("guardSocketTypeOfService", () => {
  it("swallows only EINVAL from setTypeOfService and is idempotent", () => {
    const proto = net.Socket.prototype as unknown as Record<string, unknown>;
    const saved = proto.setTypeOfService;
    let code = "EINVAL";
    proto.setTypeOfService = function () {
      throw Object.assign(new Error(`setTypeOfService ${code}`), { code });
    };
    try {
      guardSocketTypeOfService();
      guardSocketTypeOfService();
      const socket = new net.Socket();
      const call = () =>
        (socket as unknown as { setTypeOfService(v: number): unknown }).setTypeOfService(0);
      expect(call()).toBe(socket);
      code = "EPERM";
      expect(call).toThrowError("setTypeOfService EPERM");
      socket.destroy();
    } finally {
      proto.setTypeOfService = saved;
    }
  });
});
