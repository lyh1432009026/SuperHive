import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * 房主在其他设备上的登录：每台设备一个独立的房主会话（hod_ 开头的令牌），
 * 可以列出、单独退出，不需要把总令牌（join token）交出去。
 * 登录票两种：
 * - 配对票（本机网页上的二维码 / 链接）：5 分钟有效、只能用一次，存在库里；
 * - 飞书票（卡片上的「在网页查看」）：24 小时有效（过期后在飞书里发 /web 取新的）、只能兑换一次，用服务端密钥签名，
 *   绑定发出它的 IM 连接，连接断开后失效。只能用一次：否则一张泄露的链接能换出任意多个互不相干的会话。
 * 设备会话最长 30 天、闲置 7 天失效。
 * 管理 Server 所在电脑（启动 Agent 等）不随登录自动获得：设备要另外申请，经本机或飞书批准后在一段时间内有效。
 */

export const OWNER_DEVICE_PREFIX = "hod_";
const PAIR_PREFIX = "hop_";
const IM_PREFIX = "hoi_";
export const PAIR_TICKET_TTL_MS = 5 * 60_000;
export const IM_TICKET_TTL_MS = 24 * 60 * 60_000;
export const DEVICE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const DEVICE_IDLE_MS = 7 * 24 * 60 * 60_000;
/** 最近活跃时间最多每分钟写一次库 */
const TOUCH_INTERVAL_MS = 60_000;

export type OwnerDevice = {
  id: string;
  name: string;
  /** 怎么登录的：pair=本机扫码；im=飞书卡片 */
  source: "pair" | "im";
  createdAt: string;
  lastSeenAt: string;
  /** 能管理 Server 所在电脑到什么时候；没有或已过期时为 null */
  manageUntil: string | null;
};

type DeviceRow = {
  id: string;
  token_hash: string;
  name: string;
  source: "pair" | "im";
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  manage_until: string | null;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export function isOwnerDeviceToken(value: string | undefined): value is string {
  return Boolean(value?.startsWith(OWNER_DEVICE_PREFIX));
}

export class OwnerDevices {
  private readonly touched = new Map<string, number>();
  private readonly secret: Buffer;

  constructor(
    private readonly db: Database.Database,
    options: { secret: Buffer; now?: () => number },
  ) {
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_devices (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      );
      -- 退出某台经飞书登录的设备时，记下这个连接的「签发时间下限」，之前发出的票全部作废
      CREATE TABLE IF NOT EXISTS owner_im_ticket_floor (
        connection_id TEXT PRIMARY KEY,
        not_before INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner_pair_tickets (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS owner_im_tickets_used (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      -- 哪些 IM 账号可以批准其他设备管理这台电脑：只在本机房主操作时登记
      CREATE TABLE IF NOT EXISTS owner_host_approvers (
        connection_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const columns = db.pragma("table_info(owner_devices)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "connection_id")) {
      db.exec("ALTER TABLE owner_devices ADD COLUMN connection_id TEXT");
    }
    if (!columns.some((column) => column.name === "manage_until")) {
      db.exec("ALTER TABLE owner_devices ADD COLUMN manage_until TEXT");
    }
  }

  private readonly now: () => number;

  private iso(offset = 0): string {
    return new Date(this.now() + offset).toISOString();
  }

  /** 本机网页上生成配对票：二维码 / 链接里带它 */
  createPairTicket(): { ticket: string; expiresAt: string } {
    const ticket = token(PAIR_PREFIX);
    const expiresAt = this.iso(PAIR_TICKET_TTL_MS);
    this.db.prepare("DELETE FROM owner_pair_tickets WHERE expires_at < ?").run(this.iso());
    this.db
      .prepare("INSERT INTO owner_pair_tickets(token_hash, expires_at) VALUES(?, ?)")
      .run(hash(ticket), expiresAt);
    return { ticket, expiresAt };
  }

  /** 飞书卡片按钮上的登录票：签名里带连接 ID 和到期时间 */
  createImTicket(connectionId: string): string {
    const issued = this.now();
    // 末尾的随机数让同一毫秒发出的两张票也不同：票只能用一次
    const nonce = randomBytes(6).toString("base64url");
    const payload = `${connectionId}.${issued}.${issued + IM_TICKET_TTL_MS}.${nonce}`;
    return `${IM_PREFIX}${Buffer.from(payload).toString("base64url")}.${this.sign(payload)}`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(`im-login:${payload}`).digest("base64url");
  }

  /**
   * 用登录票换一个设备会话。imConnectionValid 判断飞书票所属的连接是否还在。
   * 返回 undefined 表示票无效、过期或已用过。
   */
  redeem(
    ticket: string,
    deviceName: string,
    imConnectionValid: (connectionId: string) => boolean,
  ): { token: string; device: OwnerDevice } | undefined {
    let source: OwnerDevice["source"];
    let connectionId: string | undefined;
    if (ticket.startsWith(PAIR_PREFIX)) {
      const used = this.db
        .prepare(
          "UPDATE owner_pair_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .run(this.iso(), hash(ticket), this.iso());
      if (used.changes !== 1) return undefined;
      source = "pair";
    } else if (ticket.startsWith(IM_PREFIX)) {
      const [encoded, signature] = ticket.slice(IM_PREFIX.length).split(".");
      if (!encoded || !signature) return undefined;
      const payload = Buffer.from(encoded, "base64url").toString();
      const expected = Buffer.from(this.sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
      const [connection, issued, expires] = payload.split(".");
      if (!connection || !(Number(expires) > this.now())) return undefined;
      const floor = this.db
        .prepare("SELECT not_before FROM owner_im_ticket_floor WHERE connection_id = ?")
        .get(connection) as { not_before: number } | undefined;
      if (floor && !(Number(issued) > floor.not_before)) return undefined;
      if (!imConnectionValid(connection)) return undefined;
      this.db.prepare("DELETE FROM owner_im_tickets_used WHERE expires_at < ?").run(this.now());
      const used = this.db
        .prepare("INSERT OR IGNORE INTO owner_im_tickets_used(token_hash, expires_at) VALUES(?, ?)")
        .run(hash(ticket), Number(expires));
      if (used.changes !== 1) return undefined;
      source = "im";
      connectionId = connection;
    } else {
      return undefined;
    }
    const secret = token(OWNER_DEVICE_PREFIX);
    const id = randomUUID();
    const now = this.iso();
    const name = deviceName.trim().slice(0, 64) || "未命名设备";
    this.db
      .prepare(
        "INSERT INTO owner_devices(id, token_hash, name, source, connection_id, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, hash(secret), name, source, connectionId ?? null, now, now);
    return { token: secret, device: this.get(id)! };
  }

  /** 还在有效期内：没退出、没超过最长期限、没闲置太久 */
  private alive(row: Pick<DeviceRow, "created_at" | "last_seen_at" | "revoked_at">): boolean {
    if (row.revoked_at) return false;
    const now = this.now();
    return (
      now - Date.parse(row.created_at) < DEVICE_MAX_AGE_MS &&
      now - Date.parse(row.last_seen_at) < DEVICE_IDLE_MS
    );
  }

  /** 校验设备令牌，有效时返回设备 ID（并按需刷新最近活跃时间） */
  resolve(value: string): string | undefined {
    if (!isOwnerDeviceToken(value)) return undefined;
    const row = this.db
      .prepare("SELECT * FROM owner_devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hash(value)) as DeviceRow | undefined;
    if (!row || !this.alive(row)) return undefined;
    const last = this.touched.get(row.id) ?? 0;
    if (this.now() - last > TOUCH_INTERVAL_MS) {
      this.touched.set(row.id, this.now());
      this.db
        .prepare("UPDATE owner_devices SET last_seen_at = ? WHERE id = ?")
        .run(this.iso(), row.id);
    }
    return row.id;
  }

  get(id: string): OwnerDevice | undefined {
    const row = this.db.prepare("SELECT * FROM owner_devices WHERE id = ?").get(id) as
      DeviceRow | undefined;
    return row && this.alive(row) ? this.map(row) : undefined;
  }

  list(): OwnerDevice[] {
    return (
      this.db
        .prepare("SELECT * FROM owner_devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC")
        .all() as DeviceRow[]
    )
      .filter((row) => this.alive(row))
      .map((row) => this.map(row));
  }

  /** 这台设备现在能不能管理 Server 所在电脑 */
  canManage(id: string): boolean {
    const until = this.get(id)?.manageUntil;
    return Boolean(until && Date.parse(until) > this.now());
  }

  /** 批准一台设备在 durationMs 内管理 Server 所在电脑 */
  grantManage(id: string, durationMs: number): string | undefined {
    if (!this.get(id)) return undefined;
    const until = this.iso(durationMs);
    this.db.prepare("UPDATE owner_devices SET manage_until = ? WHERE id = ?").run(until, id);
    return until;
  }

  /** 全部退出（丢了设备时用）；except 是发起操作的这台 */
  revokeAll(except?: string): string[] {
    const ids = this.list()
      .map((device) => device.id)
      .filter((id) => id !== except);
    for (const id of ids) this.revoke(id);
    return ids;
  }

  /* ---------- 可以批准其他设备管理这台电脑的 IM 账号 ---------- */

  setHostApprover(connectionId: string, actorId: string, allowed: boolean): void {
    if (allowed) {
      this.db
        .prepare(
          `INSERT INTO owner_host_approvers(connection_id, actor_id, created_at) VALUES(?, ?, ?)
           ON CONFLICT(connection_id) DO UPDATE SET actor_id = excluded.actor_id`,
        )
        .run(connectionId, actorId, this.iso());
    } else {
      this.db.prepare("DELETE FROM owner_host_approvers WHERE connection_id = ?").run(connectionId);
    }
  }

  /** 连接 ID → 登记时的 IM 账号；用的时候还要核对连接现在的账号没变 */
  hostApprovers(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT connection_id, actor_id FROM owner_host_approvers")
      .all() as Array<{ connection_id: string; actor_id: string }>;
    return new Map(rows.map((row) => [row.connection_id, row.actor_id]));
  }

  /**
   * 退出一台设备。经飞书登录的，同时作废这个连接此前发出的所有票：
   * 否则再点一次同一张卡片就又登进来了，「退出」形同虚设。
   */
  revoke(id: string): boolean {
    const row = this.db
      .prepare("SELECT connection_id FROM owner_devices WHERE id = ? AND revoked_at IS NULL")
      .get(id) as { connection_id: string | null } | undefined;
    if (!row) return false;
    this.db.transaction(() => {
      this.db.prepare("UPDATE owner_devices SET revoked_at = ? WHERE id = ?").run(this.iso(), id);
      if (row.connection_id) {
        this.db
          .prepare(
            `INSERT INTO owner_im_ticket_floor(connection_id, not_before) VALUES(?, ?)
             ON CONFLICT(connection_id) DO UPDATE SET not_before = excluded.not_before`,
          )
          .run(row.connection_id, this.now());
      }
    })();
    return true;
  }

  private map(row: DeviceRow): OwnerDevice {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      manageUntil:
        row.manage_until && Date.parse(row.manage_until) > this.now() ? row.manage_until : null,
    };
  }
}
