import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  DEVICE_IDLE_MS,
  DEVICE_MAX_AGE_MS,
  IM_TICKET_TTL_MS,
  OwnerDevices,
  PAIR_TICKET_TTL_MS,
} from "./owner-devices.js";
import { APPROVAL_TTL_MS, HostApprovals } from "./host-approvals.js";

function setup() {
  let now = Date.parse("2026-11-01T10:00:00.000Z");
  const devices = new OwnerDevices(new Database(":memory:"), {
    secret: randomBytes(32),
    now: () => now,
  });
  return { devices, advance: (ms: number) => (now += ms) };
}

describe("房主在其他设备上登录", () => {
  it("配对票只能用一次、5 分钟后失效；换到的设备令牌可以单独退出", () => {
    const { devices, advance } = setup();
    const { ticket } = devices.createPairTicket();
    const login = devices.redeem(ticket, "iPhone · Safari", () => true);
    expect(login?.token).toMatch(/^hod_/);
    expect(login?.device).toMatchObject({ name: "iPhone · Safari", source: "pair" });
    expect(devices.redeem(ticket, "again", () => true)).toBeUndefined();
    expect(devices.resolve(login!.token)).toBe(login!.device.id);

    const late = devices.createPairTicket().ticket;
    advance(PAIR_TICKET_TTL_MS + 1);
    expect(devices.redeem(late, "x", () => true)).toBeUndefined();

    expect(devices.list()).toHaveLength(1);
    expect(devices.revoke(login!.device.id)).toBe(true);
    expect(devices.resolve(login!.token)).toBeUndefined();
    expect(devices.list()).toHaveLength(0);
  });

  it("飞书票 24 小时内有效、只能兑换一次，绑定连接；篡改、过期、连接已断开都无效", () => {
    const { devices, advance } = setup();
    const valid = (id: string) => id === "conn-1";
    expect(devices.redeem(devices.createImTicket("conn-1"), "飞书", () => false)).toBeUndefined();
    const ticket = devices.createImTicket("conn-1");
    expect(devices.redeem(ticket, "飞书", valid)?.device.source).toBe("im");
    // 同一张票不能再换出第二个会话：泄露的链接不能无限派生设备
    expect(devices.redeem(ticket, "飞书 2", valid)).toBeUndefined();
    // 加尾巴、换一种等价编码也不行
    expect(devices.redeem(`${ticket}.extra`, "x", valid)).toBeUndefined();
    const [encoded, signature] = ticket.slice(4).split(".");
    expect(devices.redeem(`hoi_${encoded}=.${signature}`, "x", valid)).toBeUndefined();
    const forged = ticket.replace(/.$/, (char) => (char === "A" ? "B" : "A"));
    expect(devices.redeem(forged, "x", valid)).toBeUndefined();
    const other = devices.createImTicket("conn-2");
    expect(devices.redeem(other, "x", valid)).toBeUndefined();
    const late = devices.createImTicket("conn-1");
    advance(IM_TICKET_TTL_MS + 1);
    expect(devices.redeem(late, "x", valid)).toBeUndefined();
    expect(devices.redeem("hod_not-a-ticket", "x", valid)).toBeUndefined();
  });

  it("退出一台经飞书登录的设备后，这个连接之前发出的票全部作废，新发的票照常可用", () => {
    const { devices, advance } = setup();
    const valid = () => true;
    const ticket = devices.createImTicket("conn-1");
    const other = devices.createImTicket("conn-2");
    const login = devices.redeem(ticket, "iPhone · 飞书", valid)!;
    advance(1_000);
    expect(devices.revoke(login.device.id)).toBe(true);
    expect(devices.redeem(ticket, "again", valid)).toBeUndefined();
    // 别的连接不受影响
    expect(devices.redeem(other, "x", valid)).toBeDefined();
    advance(1_000);
    expect(devices.redeem(devices.createImTicket("conn-1"), "new", valid)).toBeDefined();
  });

  it("设备会话闲置 7 天或满 30 天失效", () => {
    const { devices, advance } = setup();
    const idle = devices.redeem(devices.createPairTicket().ticket, "idle", () => true)!;
    const busy = devices.redeem(devices.createPairTicket().ticket, "busy", () => true)!;
    advance(DEVICE_IDLE_MS - 60_000);
    expect(devices.resolve(busy.token)).toBe(busy.device.id);
    advance(120_000);
    expect(devices.resolve(idle.token)).toBeUndefined();
    expect(devices.list().map((device) => device.name)).toEqual(["busy"]);
    // 一直在用也有上限
    for (let at = DEVICE_IDLE_MS; at < DEVICE_MAX_AGE_MS; at += DEVICE_IDLE_MS / 2) {
      expect(devices.resolve(busy.token)).toBe(busy.device.id);
      advance(DEVICE_IDLE_MS / 2);
    }
    expect(devices.resolve(busy.token)).toBeUndefined();
  });

  it("管理权要单独授予、到期失效；全部退出保留发起的这台", () => {
    const { devices, advance } = setup();
    const a = devices.redeem(devices.createPairTicket().ticket, "a", () => true)!;
    const b = devices.redeem(devices.createPairTicket().ticket, "b", () => true)!;
    expect(devices.canManage(a.device.id)).toBe(false);
    expect(devices.get(a.device.id)?.manageUntil).toBeNull();
    devices.grantManage(a.device.id, 60_000);
    expect(devices.canManage(a.device.id)).toBe(true);
    advance(60_001);
    expect(devices.canManage(a.device.id)).toBe(false);
    expect(devices.revokeAll(a.device.id)).toEqual([b.device.id]);
    expect(devices.resolve(b.token)).toBeUndefined();
    expect(devices.resolve(a.token)).toBe(a.device.id);
  });

  it("可批准的 IM 账号按连接登记", () => {
    const { devices } = setup();
    devices.setHostApprover("conn-1", "ou_1", true);
    expect(devices.hostApprovers().get("conn-1")).toBe("ou_1");
    devices.setHostApprover("conn-1", "ou_1", false);
    expect(devices.hostApprovers().size).toBe(0);
  });
});

describe("其他设备管理这台电脑的批准单", () => {
  it("单次操作只能由同一设备、同样参数、批准后用一次", () => {
    let now = 0;
    const approvals = new HostApprovals({ now: () => now });
    const approval = approvals.create({
      kind: "action",
      deviceId: "d1",
      deviceName: "iPhone",
      summary: "用完全权限启动",
      fingerprint: "create:x",
    });
    // 同一件事待批时不重复建
    expect(
      approvals.create({
        kind: "action",
        deviceId: "d1",
        deviceName: "iPhone",
        summary: "用完全权限启动",
        fingerprint: "create:x",
      }).id,
    ).toBe(approval.id);
    expect(approvals.consume(approval.id, "d1", "create:x")).toBe(false);
    expect(approvals.decide(approval.id, true, "local")?.status).toBe("approved");
    expect(approvals.decide(approval.id, false, "local")).toBeUndefined();
    expect(approvals.consume(approval.id, "d2", "create:x")).toBe(false);
    expect(approvals.consume(approval.id, "d1", "create:y")).toBe(false);
    expect(approvals.consume(approval.id, "d1", "create:x")).toBe(true);
    expect(approvals.consume(approval.id, "d1", "create:x")).toBe(false);

    const late = approvals.create({
      kind: "action",
      deviceId: "d1",
      deviceName: "iPhone",
      summary: "s",
      fingerprint: "f",
    });
    now += APPROVAL_TTL_MS + 1;
    expect(approvals.get(late.id)?.status).toBe("expired");
    expect(approvals.decide(late.id, true, "local")).toBeUndefined();
  });
});
