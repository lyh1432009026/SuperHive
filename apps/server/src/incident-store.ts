import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Incident,
  IncidentDispatch,
  IncidentLesson,
  IncidentSample,
  IncidentSource,
  RuleProposal,
  WireServerText,
} from "@superhive/protocol";
import type { IncidentOccurrence } from "./incidents.js";

/** 每张故障单留几次现场 */
const SAMPLE_LIMIT = 5;
/** 最多保留多少张故障单：超出时先删最久没出现的已解决、已忽略的 */
const INCIDENT_LIMIT = 500;
/** 去重记录保留多久 */
const REF_TTL_MS = 30 * 24 * 60 * 60_000;

type IncidentRow = {
  id: string;
  fingerprint: string;
  origin: Incident["origin"];
  source: Incident["source"];
  title: string;
  status: Incident["status"];
  count: number;
  recent_count: number;
  first_seen_at: string;
  last_seen_at: string;
  samples: string;
  failed_attempts: number;
  fix_commit: string | null;
  fix_branch: string | null;
  resolved_at: string | null;
  reopened_count: number;
  note_text: string | null;
  updated_at: string;
};

type DispatchRow = {
  id: string;
  incident_id: string;
  attempt: number;
  room_id: string;
  agent_name: string;
  invocation_id: string | null;
  message_id: string | null;
  at: string;
  outcome: IncidentDispatch["outcome"];
  reason: string | null;
  commit_ref: string | null;
  branch: string | null;
  ended_at: string | null;
};

type LessonRow = {
  id: string;
  incident_id: string;
  source: IncidentSource;
  title: string;
  symptom: string;
  cause: string;
  fix: string;
  commit_ref: string | null;
  agent_name: string;
  created_at: string;
  verified: number;
};

type ProposalRow = {
  id: string;
  room_id: string;
  agent_name: string;
  text: string;
  reason: string;
  status: RuleProposal["status"];
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type IncidentPatch = Partial<{
  status: Incident["status"];
  recentCount: number;
  failedAttempts: number;
  fixCommit: string | null;
  fixBranch: string | null;
  resolvedAt: string | null;
  reopenedCount: number;
  noteText: WireServerText | null;
}>;

function mapDispatch(row: DispatchRow): IncidentDispatch {
  return {
    id: row.id,
    incidentId: row.incident_id,
    attempt: row.attempt,
    roomId: row.room_id,
    agentName: row.agent_name,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    at: row.at,
    outcome: row.outcome,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.commit_ref ? { commit: row.commit_ref } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

function mapLesson(row: LessonRow): IncidentLesson {
  return {
    id: row.id,
    incidentId: row.incident_id,
    source: row.source,
    title: row.title,
    symptom: row.symptom,
    cause: row.cause,
    fix: row.fix,
    ...(row.commit_ref ? { commit: row.commit_ref } : {}),
    agentName: row.agent_name,
    createdAt: row.created_at,
    verified: row.verified === 1,
  };
}

function mapProposal(row: ProposalRow): RuleProposal {
  return {
    id: row.id,
    roomId: row.room_id,
    agentName: row.agent_name,
    text: row.text,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
  };
}

/**
 * 故障单、派修记录、经验库和规则提议，存在同一个 SQLite 里。
 * 只管存取；什么时候派修、重新打开、升级给人由 IncidentDesk 决定。
 */
export class IncidentStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        count INTEGER NOT NULL,
        recent_count INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        samples TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        fix_commit TEXT,
        fix_branch TEXT,
        resolved_at TEXT,
        reopened_count INTEGER NOT NULL DEFAULT 0,
        note_text TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_seen ON incidents(last_seen_at);

      -- 同一次出现只记一次（断线重发、迟到的重复上报）
      CREATE TABLE IF NOT EXISTS incident_refs (
        ref TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incident_dispatches (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        room_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        invocation_id TEXT,
        message_id TEXT,
        at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        commit_ref TEXT,
        branch TEXT,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS incident_dispatches_incident ON incident_dispatches(incident_id, at);
      CREATE INDEX IF NOT EXISTS incident_dispatches_at ON incident_dispatches(at);

      CREATE TABLE IF NOT EXISTS incident_lessons (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        symptom TEXT NOT NULL,
        cause TEXT NOT NULL,
        fix TEXT NOT NULL,
        commit_ref TEXT,
        agent_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rule_proposals (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      );
    `);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * 记一次出现：同指纹合并计数，现场留最近几次。
   * 同一个 ref 已经记过就不再计数，返回 duplicate。
   */
  record(occurrence: IncidentOccurrence): { incident: Incident; created: boolean } | "duplicate" {
    const at = this.iso();
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM incidents WHERE fingerprint = ?")
        .get(occurrence.fingerprint) as IncidentRow | undefined;
      const id = existing?.id ?? randomUUID();
      if (occurrence.ref) {
        const inserted = this.db
          .prepare("INSERT OR IGNORE INTO incident_refs(ref, incident_id, at) VALUES (?, ?, ?)")
          .run(occurrence.ref, id, at);
        if (inserted.changes === 0) return "duplicate" as const;
      }
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO incidents(id, fingerprint, origin, source, title, status, count, recent_count,
               first_seen_at, last_seen_at, samples, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', 1, 1, ?, ?, ?, ?)`,
          )
          .run(
            id,
            occurrence.fingerprint,
            occurrence.origin,
            occurrence.source,
            occurrence.title,
            occurrence.sample.at,
            occurrence.sample.at,
            JSON.stringify([occurrence.sample]),
            at,
          );
        this.prune();
        return { incident: this.get(id)!, created: true };
      }
      const samples = [occurrence.sample, ...(JSON.parse(existing.samples) as IncidentSample[])];
      this.db
        .prepare(
          `UPDATE incidents SET count = count + 1, recent_count = recent_count + 1,
             last_seen_at = ?, samples = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          occurrence.sample.at > existing.last_seen_at
            ? occurrence.sample.at
            : existing.last_seen_at,
          JSON.stringify(samples.slice(0, SAMPLE_LIMIT)),
          at,
          id,
        );
      return { incident: this.get(id)!, created: false };
    })();
  }

  /** 超出上限时删最久没出现的已解决、已忽略、外部原因的故障单（连同派修记录） */
  private prune(): void {
    const { total } = this.db.prepare("SELECT COUNT(*) AS total FROM incidents").get() as {
      total: number;
    };
    if (total > INCIDENT_LIMIT) {
      const stale = this.db
        .prepare(
          `SELECT id FROM incidents
           WHERE status IN ('resolved', 'ignored') OR origin != 'internal'
           ORDER BY last_seen_at LIMIT ?`,
        )
        .all(total - INCIDENT_LIMIT) as Array<{ id: string }>;
      for (const { id } of stale) {
        this.db.prepare("DELETE FROM incidents WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM incident_dispatches WHERE incident_id = ?").run(id);
      }
    }
    this.db
      .prepare("DELETE FROM incident_refs WHERE at < ?")
      .run(new Date(this.now() - REF_TTL_MS).toISOString());
  }

  get(id: string): Incident | undefined {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as
      IncidentRow | undefined;
    return row ? this.map(row) : undefined;
  }

  /** 最近出现的在前 */
  list(): Incident[] {
    const rows = this.db
      .prepare("SELECT * FROM incidents ORDER BY last_seen_at DESC")
      .all() as IncidentRow[];
    return rows.map((row) => this.map(row));
  }

  update(id: string, patch: IncidentPatch): Incident {
    const columns: Record<keyof IncidentPatch, string> = {
      status: "status",
      recentCount: "recent_count",
      failedAttempts: "failed_attempts",
      fixCommit: "fix_commit",
      fixBranch: "fix_branch",
      resolvedAt: "resolved_at",
      reopenedCount: "reopened_count",
      noteText: "note_text",
    };
    const assignments = ["updated_at = ?"];
    const values: unknown[] = [this.iso()];
    for (const [key, column] of Object.entries(columns) as Array<[keyof IncidentPatch, string]>) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      const value = patch[key];
      values.push(key === "noteText" && value !== null ? JSON.stringify(value) : value);
    }
    this.db
      .prepare(`UPDATE incidents SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, id);
    return this.get(id)!;
  }

  private map(row: IncidentRow): Incident {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      origin: row.origin,
      source: row.source,
      title: row.title,
      status: row.status,
      count: row.count,
      recentCount: row.recent_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      samples: JSON.parse(row.samples) as IncidentSample[],
      failedAttempts: row.failed_attempts,
      dispatches: this.dispatchesOf(row.id),
      ...(row.fix_commit ? { fixCommit: row.fix_commit } : {}),
      ...(row.fix_branch ? { fixBranch: row.fix_branch } : {}),
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      reopenedCount: row.reopened_count,
      ...(row.note_text ? { noteText: JSON.parse(row.note_text) as WireServerText } : {}),
      updatedAt: row.updated_at,
    };
  }

  /** 升级给人的故障单 + 待批准的规则提议 */
  attentionCount(): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM incidents WHERE status = 'escalated')
              + (SELECT COUNT(*) FROM rule_proposals WHERE status = 'pending') AS total`,
      )
      .get() as { total: number };
    return row.total;
  }

  /* ---------- 派修 ---------- */

  addDispatch(input: {
    incidentId: string;
    attempt: number;
    roomId: string;
    agentName: string;
  }): IncidentDispatch {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO incident_dispatches(id, incident_id, attempt, room_id, agent_name, at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(id, input.incidentId, input.attempt, input.roomId, input.agentName, this.iso());
    return this.getDispatch(id)!;
  }

  getDispatch(id: string): IncidentDispatch | undefined {
    const row = this.db.prepare("SELECT * FROM incident_dispatches WHERE id = ?").get(id) as
      DispatchRow | undefined;
    return row ? mapDispatch(row) : undefined;
  }

  updateDispatch(
    id: string,
    patch: Partial<{
      invocationId: string;
      messageId: string;
      outcome: IncidentDispatch["outcome"];
      reason: string;
      commit: string;
      branch: string;
    }>,
  ): IncidentDispatch {
    const columns = {
      invocationId: "invocation_id",
      messageId: "message_id",
      outcome: "outcome",
      reason: "reason",
      commit: "commit_ref",
      branch: "branch",
    } as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (patch.outcome && patch.outcome !== "pending") {
      assignments.push("ended_at = ?");
      values.push(this.iso());
    }
    if (assignments.length > 0) {
      this.db
        .prepare(`UPDATE incident_dispatches SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);
    }
    return this.getDispatch(id)!;
  }

  dispatchesOf(incidentId: string): IncidentDispatch[] {
    const rows = this.db
      .prepare("SELECT * FROM incident_dispatches WHERE incident_id = ? ORDER BY at DESC")
      .all(incidentId) as DispatchRow[];
    return rows.map(mapDispatch);
  }

  pendingDispatches(): IncidentDispatch[] {
    const rows = this.db
      .prepare("SELECT * FROM incident_dispatches WHERE outcome = 'pending' ORDER BY at")
      .all() as DispatchRow[];
    return rows.map(mapDispatch);
  }

  /** 从某个时间点起自动派修了几次（每日上限用） */
  dispatchCountSince(iso: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS total FROM incident_dispatches WHERE at >= ?")
        .get(iso) as {
        total: number;
      }
    ).total;
  }

  /* ---------- 经验库 ---------- */

  addLesson(input: Omit<IncidentLesson, "id" | "createdAt" | "verified">): IncidentLesson {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO incident_lessons(id, incident_id, source, title, symptom, cause, fix, commit_ref,
           agent_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.incidentId,
        input.source,
        input.title,
        input.symptom,
        input.cause,
        input.fix,
        input.commit ?? null,
        input.agentName,
        this.iso(),
      );
    return this.lessons().find((lesson) => lesson.id === id)!;
  }

  /** 修复进了在跑的代码：这张单的经验标为已验证 */
  verifyLessons(incidentId: string, verified: boolean): void {
    this.db
      .prepare("UPDATE incident_lessons SET verified = ? WHERE incident_id = ?")
      .run(verified ? 1 : 0, incidentId);
  }

  /** 新的在前 */
  lessons(): IncidentLesson[] {
    const rows = this.db
      .prepare("SELECT * FROM incident_lessons ORDER BY created_at DESC")
      .all() as LessonRow[];
    return rows.map(mapLesson);
  }

  /* ---------- 规则提议 ---------- */

  addProposal(input: {
    roomId: string;
    agentName: string;
    text: string;
    reason: string;
  }): RuleProposal {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO rule_proposals(id, room_id, agent_name, text, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.roomId, input.agentName, input.text, input.reason, this.iso());
    return this.getProposal(id)!;
  }

  getProposal(id: string): RuleProposal | undefined {
    const row = this.db.prepare("SELECT * FROM rule_proposals WHERE id = ?").get(id) as
      ProposalRow | undefined;
    return row ? mapProposal(row) : undefined;
  }

  /** 新的在前 */
  proposals(): RuleProposal[] {
    const rows = this.db
      .prepare("SELECT * FROM rule_proposals ORDER BY created_at DESC")
      .all() as ProposalRow[];
    return rows.map(mapProposal);
  }

  decideProposal(id: string, status: RuleProposal["status"], by: string): RuleProposal {
    this.db
      .prepare("UPDATE rule_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?")
      .run(status, this.iso(), by, id);
    return this.getProposal(id)!;
  }

  /** 已批准、生效中的规则，按批准先后 */
  approvedRules(): RuleProposal[] {
    const rows = this.db
      .prepare("SELECT * FROM rule_proposals WHERE status = 'approved' ORDER BY decided_at, id")
      .all() as ProposalRow[];
    return rows.map(mapProposal);
  }
}
