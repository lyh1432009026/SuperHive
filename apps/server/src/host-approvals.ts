import { randomUUID } from "node:crypto";

/**
 * 其他设备要管理 Server 所在电脑时的批准单：由本机房主在网页上，或可批准的 IM 账号在卡片上批准。
 * - manage：申请一段时间的管理权；
 * - action：单次高危操作（例如用完全权限启动 Agent），绑定设备与操作指纹（接口 + 参数），
 *   批准后只能由这台设备、用同样的参数使用一次，防止重放或换参数。
 * 只存在内存里：Server 重启后未处理的申请作废，重新申请即可。
 */

export const APPROVAL_TTL_MS = 5 * 60_000;
/** 批准后至少还有这么久可以用 */
const USE_WINDOW_MS = 2 * 60_000;

export type HostApprovalKind = "manage" | "action";
export type HostApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";

export type HostApproval = {
  id: string;
  kind: HostApprovalKind;
  deviceId: string;
  deviceName: string;
  /** 给批准人看的一句话：要做什么 */
  summary: string;
  status: HostApprovalStatus;
  createdAt: string;
  expiresAt: string;
  /** 谁批准或拒绝的：local=本机网页；其余为 IM 连接 ID */
  decidedBy?: string;
};

type Entry = HostApproval & { fingerprint: string };

export class HostApprovals {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private settle(entry: Entry): Entry {
    if (entry.status === "pending" && Date.parse(entry.expiresAt) <= this.now()) {
      entry.status = "expired";
    }
    return entry;
  }

  private view(entry: Entry): HostApproval {
    // 指纹（操作参数）只在服务端比对，不发给页面
    const { id, kind, deviceId, deviceName, summary, status, createdAt, expiresAt, decidedBy } =
      this.settle(entry);
    return {
      id,
      kind,
      deviceId,
      deviceName,
      summary,
      status,
      createdAt,
      expiresAt,
      ...(decidedBy ? { decidedBy } : {}),
    };
  }

  private prune(): void {
    const cutoff = this.now() - APPROVAL_TTL_MS;
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.expiresAt) < cutoff) this.entries.delete(id);
    }
  }

  create(input: {
    kind: HostApprovalKind;
    deviceId: string;
    deviceName: string;
    summary: string;
    fingerprint?: string;
  }): HostApproval {
    this.prune();
    // 同一台设备同一件事只保留一张待批的：反复点按钮不会刷出一串卡片
    for (const entry of this.entries.values()) {
      if (
        this.settle(entry).status === "pending" &&
        entry.deviceId === input.deviceId &&
        entry.kind === input.kind &&
        entry.fingerprint === (input.fingerprint ?? "")
      ) {
        return this.view(entry);
      }
    }
    const entry: Entry = {
      id: randomUUID(),
      kind: input.kind,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      summary: input.summary,
      fingerprint: input.fingerprint ?? "",
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + APPROVAL_TTL_MS).toISOString(),
    };
    this.entries.set(entry.id, entry);
    return this.view(entry);
  }

  get(id: string): HostApproval | undefined {
    const entry = this.entries.get(id);
    return entry ? this.view(entry) : undefined;
  }

  pending(): HostApproval[] {
    return [...this.entries.values()]
      .map((entry) => this.view(entry))
      .filter((entry) => entry.status === "pending");
  }

  /** 批准或拒绝；已处理过、已过期时返回 undefined */
  decide(id: string, allow: boolean, by: string): HostApproval | undefined {
    const entry = this.entries.get(id);
    if (!entry || this.settle(entry).status !== "pending") return undefined;
    entry.status = allow ? "approved" : "denied";
    entry.decidedBy = by;
    // 快到期才批准的：留出设备重新提交的时间
    const floor = this.now() + USE_WINDOW_MS;
    if (allow && Date.parse(entry.expiresAt) < floor)
      entry.expiresAt = new Date(floor).toISOString();
    return this.view(entry);
  }

  /** 单次操作：这台设备、同样的操作指纹、已批准且没用过、没过期，才算数，用掉即作废 */
  consume(id: string, deviceId: string, fingerprint: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== "action") return false;
    if (entry.deviceId !== deviceId || entry.fingerprint !== fingerprint) return false;
    if (entry.status !== "approved" || Date.parse(entry.expiresAt) <= this.now()) return false;
    entry.status = "used";
    return true;
  }

  /** 设备退出后，它的申请一并作废 */
  dropDevice(deviceId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.deviceId === deviceId) this.entries.delete(id);
    }
  }
}
