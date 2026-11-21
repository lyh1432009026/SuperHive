import {
  DEFAULT_INCIDENT_SETTINGS,
  incidentSettingsSchema,
  serverText,
  type Incident,
  type IncidentDispatch,
  type IncidentLesson,
  type IncidentSettings,
  type IncidentsResponse,
  type Invocation,
  type RuleProposal,
  type ServerText,
  type ServerTextKey,
  type UpdateIncidentSettingsRequest,
} from "@superhive/protocol";
import { HiveError } from "./database.js";
import type { IncidentOccurrence } from "./incidents.js";
import type { IncidentStore } from "./incident-store.js";

/**
 * 自动修复不许改的代码：权限、协作规则、门禁测试、审计，以及故障单系统自己。
 * 否则 Agent 可能把「让测试通过」变成「改测试」，或者把挡住它的规则改掉。前缀匹配，路径相对仓库根。
 */
export const PROTECTED_PATHS: readonly string[] = [
  // 权限与凭证
  "apps/server/src/access-store.ts",
  "apps/server/src/local-access.ts",
  "apps/server/src/local-routes.ts",
  "apps/server/src/owner-devices.ts",
  "apps/server/src/host-approvals.ts",
  "apps/server/src/runtime-credentials.ts",
  // 协作规则与提示词
  "apps/server/src/agent-instructions.ts",
  "apps/server/src/agent-skill.ts",
  "skills/",
  // 门禁：提交钩子、lint 配置、根目录脚本
  ".githooks/",
  "scripts/git-hooks.mjs",
  "eslint.config.js",
  "package.json",
  // 故障单系统自己
  "apps/server/src/incidents.ts",
  "apps/server/src/incident-store.ts",
  "apps/server/src/incident-desk.ts",
  "packages/protocol/src/incidents.ts",
];

export function protectedChanges(files: readonly string[]): string[] {
  return files.filter((file) =>
    PROTECTED_PATHS.some((prefix) =>
      prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
    ),
  );
}

/** 派出后多久没有回报就算这次没修成 */
export const DISPATCH_TIMEOUT_MS = 24 * 60 * 60_000;
/** 派修消息里附几条经验 */
const LESSONS_PER_DISPATCH = 5;
/** 查修复有没有进在跑的代码：最多这么久查一次 */
const RESOLUTION_CHECK_MS = 60_000;

const SETTINGS_KEY = "incidents";

/** 故障单的短号：派修消息、提交信息里用 */
export function incidentShortId(id: string): string {
  return id.slice(0, 8);
}

export type IncidentGit = {
  /** 在跑的代码里有没有这个修复：提交本身，或提交信息里带「Incident: 短号」的提交（变基后提交号会变） */
  containsFix(input: { commit?: string; shortId: string }): Promise<boolean | undefined>;
  /** 这个提交相对在跑代码的分叉点改了哪些文件；提交不存在时返回 undefined */
  changedFiles(commit: string): Promise<Array<{ status: string; file: string }> | undefined>;
};

export type IncidentDeskDeps = {
  store: IncidentStore;
  readSetting(key: string): string | undefined;
  writeSetting(key: string, value: string): void;
  now(): number;
  /** 在跑的 Server 代码提交；不是从源码仓库跑的就没有，这时不能自动派修 */
  runningCommit: string | undefined;
  git: IncidentGit;
  /** 以 requester 的名义在房间里 @ agent 发出派活消息，返回调用 */
  dispatch(input: {
    roomId: string;
    requester: string;
    agent: string;
    text: ServerText;
    clientMessageId: string;
  }): { invocationId: string; messageId: string };
  /** 在房间里提醒人（代 agent 发出，不唤醒任何 Agent） */
  notify(input: { roomId: string; agent: string; text: ServerText; clientMessageId: string }): void;
  getInvocation(id: string): Invocation | undefined;
  /** 故障单、经验、提议变了：推给房主页面 */
  changed(): void;
  log?: { warn(object: Record<string, unknown>, message: string): void };
};

export type IncidentReport =
  | {
      status: "fixed";
      commit: string;
      branch?: string | undefined;
      symptom: string;
      cause: string;
      fix: string;
    }
  | { status: "failed"; reason: string };

const TERMINAL_FAILED: ReadonlyArray<Invocation["status"]> = ["failed", "cancelled", "timed_out"];

/**
 * 故障单的决策：记一次出现后要不要派修、修好后又出现要不要重新打开、修失败几次后升级给人。
 * 合入仍由人 review；修好后又出现只提醒回滚，不自动回滚。
 */
export class IncidentDesk {
  private lastResolutionCheck = 0;
  private checking: Promise<boolean> | undefined;

  constructor(private readonly deps: IncidentDeskDeps) {}

  settings(): IncidentSettings {
    const raw = this.deps.readSetting(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_INCIDENT_SETTINGS };
    try {
      const parsed = incidentSettingsSchema.partial().safeParse(JSON.parse(raw));
      if (!parsed.success) return { ...DEFAULT_INCIDENT_SETTINGS };
      const stored = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined),
      ) as Partial<IncidentSettings>;
      return { ...DEFAULT_INCIDENT_SETTINGS, ...stored };
    } catch {
      return { ...DEFAULT_INCIDENT_SETTINGS };
    }
  }

  updateSettings(patch: UpdateIncidentSettingsRequest): IncidentSettings {
    const given = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next = incidentSettingsSchema.parse({ ...this.settings(), ...given });
    // 空字符串当作清空
    for (const key of ["roomId", "requester", "fixer", "reviewer"] as const) {
      if (!next[key]) delete next[key];
    }
    this.deps.writeSetting(SETTINGS_KEY, JSON.stringify(next));
    this.deps.changed();
    return next;
  }

  private dayStart(): string {
    const day = new Date(this.deps.now());
    day.setHours(0, 0, 0, 0);
    return day.toISOString();
  }

  snapshot(): IncidentsResponse {
    return {
      incidents: this.deps.store.list(),
      lessons: this.deps.store.lessons(),
      proposals: this.deps.store.proposals(),
      settings: this.settings(),
      dispatchedToday: this.deps.store.dispatchCountSince(this.dayStart()),
      protectedPaths: [...PROTECTED_PATHS],
      ...(this.deps.runningCommit ? { runningCommit: this.deps.runningCommit } : {}),
    };
  }

  /** 需要房主处理的：升级给人的故障单 + 待批准的规则提议 */
  attention(): number {
    return this.deps.store.attentionCount();
  }

  /** 记一次出现；返回合并后的故障单（重复上报返回 undefined） */
  record(occurrence: IncidentOccurrence): Incident | undefined {
    const result = this.deps.store.record(occurrence);
    if (result === "duplicate") return undefined;
    let incident = result.incident;
    if (incident.origin === "internal" && incident.status === "resolved") {
      incident = this.reopenAfterFix(incident);
    }
    incident = this.maybeDispatch(incident) ?? incident;
    this.deps.changed();
    return incident;
  }

  /** 修好后同一种错误又出现：重新打开、算一次修失败，提醒人考虑回滚（不自动回滚） */
  private reopenAfterFix(incident: Incident): Incident {
    const settings = this.settings();
    const failedAttempts = incident.failedAttempts + 1;
    this.deps.store.verifyLessons(incident.id, false);
    const commit = incident.fixCommit?.slice(0, 12) ?? "?";
    let next = this.deps.store.update(incident.id, {
      status: "open",
      recentCount: 1,
      failedAttempts,
      reopenedCount: incident.reopenedCount + 1,
      resolvedAt: null,
      noteText: serverText("incident.note.recurred", { commit }),
    });
    this.notify(next, serverText("incident.recurred", this.noticeParams(next, { commit })));
    if (failedAttempts >= settings.maxAttempts) next = this.escalate(next, "attempts");
    return next;
  }

  private escalate(incident: Incident, why: "attempts" | "protected", files?: string[]): Incident {
    const note =
      why === "attempts"
        ? serverText("incident.note.escalatedAttempts", { count: incident.failedAttempts })
        : serverText("incident.note.escalatedProtected", { files: (files ?? []).join("、") });
    const next = this.deps.store.update(incident.id, { status: "escalated", noteText: note });
    this.notify(next, serverText("incident.escalated", this.noticeParams(next, { reason: note })));
    return next;
  }

  private noticeParams(
    incident: Incident,
    extra: Record<string, string | ServerText>,
  ): Record<string, string | number | ServerText> {
    const settings = this.settings();
    return {
      requester: settings.requester ?? "",
      agent: settings.fixer ?? "",
      short: incidentShortId(incident.id),
      title: incident.title.replace(/@/g, "＠"),
      count: incident.count,
      ...extra,
    };
  }

  private notify(incident: Incident, text: ServerText): void {
    const settings = this.settings();
    if (!settings.roomId || !settings.fixer) return;
    try {
      this.deps.notify({
        roomId: settings.roomId,
        agent: settings.fixer,
        text,
        clientMessageId: `incident-${incident.id}-${text.key}-${incident.reopenedCount}-${incident.failedAttempts}`,
      });
    } catch (error) {
      this.deps.log?.warn({ err: error, incidentId: incident.id }, "incident notice failed");
    }
  }

  /** 为什么现在不能自动派修；可以派时返回 undefined */
  private blocker(incident: Incident, manual: boolean): string | undefined {
    const settings = this.settings();
    // 外部原因改代码修不好；说不清是谁的只能房主判断后手动派
    if (incident.origin === "external") return "external cause";
    if (!manual && incident.origin !== "internal") return "not internal";
    if (!manual && !settings.autoDispatch) return "auto dispatch off";
    if (!this.deps.runningCommit) return "not running from a git checkout";
    if (!settings.roomId || !settings.fixer || !settings.requester) return "not configured";
    if (!manual && incident.status !== "open") return `status ${incident.status}`;
    if (manual && !["open", "escalated"].includes(incident.status)) {
      return `status ${incident.status}`;
    }
    if (!manual && incident.recentCount < settings.threshold) return "below threshold";
    if (!manual && incident.failedAttempts >= settings.maxAttempts) return "too many attempts";
    if (!manual && this.deps.store.dispatchCountSince(this.dayStart()) >= settings.dailyLimit) {
      return "daily limit";
    }
    return undefined;
  }

  /** 到阈值就派给修的 Agent；manual=房主点了「派修」，不看阈值、每日上限和自动开关 */
  maybeDispatch(incident: Incident, manual = false): Incident | undefined {
    const blocked = this.blocker(incident, manual);
    if (blocked) {
      if (manual) {
        throw new HiveError(
          "INCIDENT_NOT_DISPATCHABLE",
          serverText("error.incident.notDispatchable", { reason: blocked }),
        );
      }
      if (blocked === "too many attempts" && incident.status === "open") {
        return this.escalate(incident, "attempts");
      }
      return undefined;
    }
    const settings = this.settings();
    const attempt = incident.dispatches.length + 1;
    const dispatch = this.deps.store.addDispatch({
      incidentId: incident.id,
      attempt,
      roomId: settings.roomId!,
      agentName: settings.fixer!,
    });
    try {
      const sent = this.deps.dispatch({
        roomId: settings.roomId!,
        requester: settings.requester!,
        agent: settings.fixer!,
        text: this.dispatchText(incident, attempt),
        clientMessageId: `incident-${dispatch.id}`,
      });
      this.deps.store.updateDispatch(dispatch.id, {
        invocationId: sent.invocationId,
        messageId: sent.messageId,
      });
    } catch (error) {
      this.deps.store.updateDispatch(dispatch.id, {
        outcome: "failed",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
      this.deps.log?.warn({ err: error, incidentId: incident.id }, "incident dispatch failed");
      if (manual) throw error;
      return this.deps.store.get(incident.id);
    }
    return this.deps.store.update(incident.id, { status: "fixing", noteText: null });
  }

  /** 和这张单相关的经验：同一张单的优先，再是同一来源的，最后是最近的 */
  relevantLessons(incident: Incident): IncidentLesson[] {
    const lessons = this.deps.store.lessons();
    const rank = (lesson: IncidentLesson) =>
      lesson.incidentId === incident.id ? 0 : lesson.source === incident.source ? 1 : 2;
    return [...lessons]
      .sort((a, b) => rank(a) - rank(b) || Number(b.verified) - Number(a.verified))
      .slice(0, LESSONS_PER_DISPATCH);
  }

  private dispatchText(incident: Incident, attempt: number): ServerText {
    const settings = this.settings();
    const sample = incident.samples[0];
    const lessons = this.relevantLessons(incident);
    const scene = sample
      ? [
          sample.route ? `位置：${sample.route}` : "",
          sample.agentName
            ? `Agent：${sample.agentName}${sample.provider ? `（${sample.provider}）` : ""}`
            : "",
          sample.roomId ? `房间：#${sample.roomId}` : "",
          sample.invocationId ? `调用：${sample.invocationId}` : "",
          sample.messageId ? `消息：${sample.messageId}` : "",
          sample.url ? `页面：${sample.url}` : "",
          sample.detail ? `说明：${sample.detail}` : "",
          sample.stack ? `调用栈：\n${sample.stack}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    return serverText("incident.dispatch", {
      agent: settings.fixer ?? "",
      requester: settings.requester ?? "",
      short: incidentShortId(incident.id),
      title: incident.title,
      attempt,
      source: serverText(`incident.source.${incident.source}` as ServerTextKey),
      count: incident.count,
      firstSeen: incident.firstSeenAt,
      lastSeen: incident.lastSeenAt,
      commit: this.deps.runningCommit?.slice(0, 12) ?? "?",
      scene: quote(scene, 3000),
      reviewer: settings.reviewer
        ? serverText("incident.reviewer", { reviewer: settings.reviewer })
        : serverText("incident.reviewerAny"),
      protected: PROTECTED_PATHS.join("、"),
      lessons:
        lessons.length > 0
          ? serverText("incident.lessons", {
              lessons: quote(
                lessons
                  .map(
                    (lesson, index) =>
                      `${index + 1}. ${lesson.title}${lesson.verified ? "" : "（未验证）"}\n   症状：${lesson.symptom}\n   原因：${lesson.cause}\n   修法：${lesson.fix}`,
                  )
                  .join("\n"),
                3000,
              ),
            })
          : "",
      id: incident.id,
    });
  }

  /** 修的 Agent 回报结果（hive_incident_report） */
  async report(
    caller: { roomId: string; agentName: string },
    incidentId: string,
    report: IncidentReport,
  ): Promise<{ incident: Incident; protectedFiles?: string[]; modifiedTests?: string[] }> {
    const incident = this.deps.store.get(incidentId);
    if (!incident) {
      throw new HiveError("INCIDENT_NOT_FOUND", serverText("error.incident.notFound"));
    }
    const dispatch = incident.dispatches.find(
      (item) =>
        item.outcome === "pending" &&
        item.roomId === caller.roomId &&
        item.agentName.toLocaleLowerCase() === caller.agentName.toLocaleLowerCase(),
    );
    if (!dispatch) {
      throw new HiveError("INCIDENT_NOT_ASSIGNED", serverText("error.incident.notAssigned"));
    }
    if (report.status === "failed") {
      this.deps.store.updateDispatch(dispatch.id, { outcome: "failed", reason: report.reason });
      const next = this.attemptFailed(
        incident,
        serverText("incident.note.failed", {
          reason: report.reason.slice(0, 300),
        }),
      );
      this.deps.changed();
      return { incident: next };
    }
    const changes = await this.deps.git.changedFiles(report.commit);
    if (!changes) {
      throw new HiveError("INCIDENT_COMMIT_UNKNOWN", serverText("error.incident.commitUnknown"));
    }
    const files = changes.map((change) => change.file);
    const protectedFiles = protectedChanges(files);
    if (protectedFiles.length > 0) {
      this.deps.store.updateDispatch(dispatch.id, {
        outcome: "failed",
        reason: `protected: ${protectedFiles.join(", ")}`.slice(0, 1000),
        commit: report.commit,
        ...(report.branch ? { branch: report.branch } : {}),
      });
      const next = this.escalate(
        this.deps.store.update(incident.id, { failedAttempts: incident.failedAttempts + 1 }),
        "protected",
        protectedFiles,
      );
      this.deps.changed();
      return { incident: next, protectedFiles };
    }
    // 改了（不是新增）已有测试：不拦，记在派修记录上给 review 的人看
    const modifiedTests = changes
      .filter((change) => change.status !== "A" && /\.test\.[cm]?[jt]sx?$/.test(change.file))
      .map((change) => change.file);
    this.deps.store.updateDispatch(dispatch.id, {
      outcome: "submitted",
      commit: report.commit,
      ...(report.branch ? { branch: report.branch } : {}),
      ...(modifiedTests.length > 0
        ? { reason: `modified tests: ${modifiedTests.join(", ")}`.slice(0, 1000) }
        : {}),
    });
    this.deps.store.addLesson({
      incidentId: incident.id,
      source: incident.source,
      title: incident.title,
      symptom: report.symptom,
      cause: report.cause,
      fix: report.fix,
      commit: report.commit,
      agentName: caller.agentName,
    });
    let next = this.deps.store.update(incident.id, {
      status: "fix_submitted",
      fixCommit: report.commit,
      fixBranch: report.branch ?? null,
      recentCount: 0,
      noteText: null,
    });
    // 已经合进在跑的代码（例如人先合了再让它补报）：直接标已解决
    if (
      await this.deps.git.containsFix({
        commit: report.commit,
        shortId: incidentShortId(incident.id),
      })
    ) {
      next = this.markResolved(next);
    }
    this.deps.changed();
    return { incident: next, ...(modifiedTests.length > 0 ? { modifiedTests } : {}) };
  }

  /** 一次派修没成：计一次失败，够上限就升级给人，否则回到 open 重新攒次数 */
  private attemptFailed(incident: Incident, note: ServerText): Incident {
    const settings = this.settings();
    const failedAttempts = incident.failedAttempts + 1;
    const next = this.deps.store.update(incident.id, {
      status: "open",
      failedAttempts,
      recentCount: 0,
      noteText: note,
    });
    return failedAttempts >= settings.maxAttempts ? this.escalate(next, "attempts") : next;
  }

  private markResolved(incident: Incident): Incident {
    this.deps.store.verifyLessons(incident.id, true);
    return this.deps.store.update(incident.id, {
      status: "resolved",
      resolvedAt: new Date(this.deps.now()).toISOString(),
      recentCount: 0,
      noteText: null,
    });
  }

  /**
   * 定期扫描：派出去的调用失败或停了、超时没回报的算一次没修成；交了修复的，
   * 修复进了在跑的代码就标已解决。
   */
  async sweep(): Promise<void> {
    let changed = false;
    for (const dispatch of this.deps.store.pendingDispatches()) {
      const outcome = this.dispatchOutcome(dispatch);
      if (!outcome) continue;
      this.deps.store.updateDispatch(dispatch.id, { outcome: "failed", reason: outcome });
      const incident = this.deps.store.get(dispatch.incidentId);
      if (incident?.status === "fixing") {
        this.attemptFailed(incident, serverText("incident.note.failed", { reason: outcome }));
      }
      changed = true;
    }
    if (this.deps.now() - this.lastResolutionCheck >= RESOLUTION_CHECK_MS && !this.checking) {
      this.lastResolutionCheck = this.deps.now();
      this.checking = this.checkResolutions().finally(() => (this.checking = undefined));
      if (await this.checking) changed = true;
    }
    if (changed) this.deps.changed();
  }

  private dispatchOutcome(dispatch: IncidentDispatch): string | undefined {
    const invocation = dispatch.invocationId
      ? this.deps.getInvocation(dispatch.invocationId)
      : undefined;
    // 被人收起、被取代的调用不算没修成：人另行处理了，等超时或人手动关
    if (invocation && TERMINAL_FAILED.includes(invocation.status) && !invocation.resolution) {
      return `invocation ${invocation.status}`;
    }
    if (this.deps.now() - Date.parse(dispatch.at) > DISPATCH_TIMEOUT_MS) return "no report in 24h";
    return undefined;
  }

  private async checkResolutions(): Promise<boolean> {
    let changed = false;
    for (const incident of this.deps.store.list()) {
      if (incident.status !== "fix_submitted") continue;
      const contained = await this.deps.git.containsFix({
        ...(incident.fixCommit ? { commit: incident.fixCommit } : {}),
        shortId: incidentShortId(incident.id),
      });
      if (contained) {
        this.markResolved(incident);
        changed = true;
      }
    }
    return changed;
  }

  /** 房主在页面上处理一张单 */
  act(id: string, action: "ignore" | "reopen" | "resolve" | "dispatch"): Incident {
    const incident = this.deps.store.get(id);
    if (!incident) throw new HiveError("INCIDENT_NOT_FOUND", serverText("error.incident.notFound"));
    let next: Incident;
    if (action === "dispatch") {
      next = this.maybeDispatch(incident, true) ?? incident;
    } else {
      // 人接手了：还在修的派修记录标为被取代，不再算修失败
      for (const dispatch of incident.dispatches) {
        if (dispatch.outcome === "pending") {
          this.deps.store.updateDispatch(dispatch.id, { outcome: "superseded" });
        }
      }
      next =
        action === "ignore"
          ? this.deps.store.update(id, { status: "ignored", noteText: null })
          : action === "resolve"
            ? this.markResolved(incident)
            : // 重新打开：清零修失败次数，给自动修复重新一次机会
              this.deps.store.update(id, {
                status: "open",
                recentCount: 0,
                failedAttempts: 0,
                noteText: null,
              });
    }
    this.deps.changed();
    return next;
  }

  /* ---------- 规则提议 ---------- */

  propose(
    caller: { roomId: string; agentName: string },
    text: string,
    reason: string,
  ): RuleProposal {
    const pending = this.deps.store.proposals().filter((proposal) => proposal.status === "pending");
    if (pending.length >= 20) {
      throw new HiveError("RULE_PROPOSALS_FULL", serverText("error.ruleProposal.full"));
    }
    const proposal = this.deps.store.addProposal({ ...caller, text, reason });
    this.deps.changed();
    return proposal;
  }

  decide(id: string, decision: "approve" | "reject" | "retire", by: string): RuleProposal {
    const proposal = this.deps.store.getProposal(id);
    if (!proposal) {
      throw new HiveError("RULE_PROPOSAL_NOT_FOUND", serverText("error.ruleProposal.notFound"));
    }
    const allowed =
      decision === "retire" ? proposal.status === "approved" : proposal.status === "pending";
    if (!allowed) {
      throw new HiveError("RULE_PROPOSAL_DECIDED", serverText("error.ruleProposal.decided"));
    }
    const next = this.deps.store.decideProposal(
      id,
      decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "retired",
      by,
    );
    this.deps.changed();
    return next;
  }

  /** 房主批准的补充规则，接在 Agent 规则后面（新会话生效） */
  rulesAddendum(): string {
    const rules = this.deps.store.approvedRules();
    if (rules.length === 0) return "";
    return `\n房主批准的补充规则：\n\n${rules
      .map((rule, index) => `${index + 1}. ${rule.text.replace(/\s+/g, " ").trim()}`)
      .join("\n")}\n`;
  }
}

/** 引用进派修消息：去掉 @（不唤醒别人），过长截断 */
function quote(text: string, limit: number): string {
  const quoted = text.replace(/@/g, "＠");
  return quoted.length > limit ? `${quoted.slice(0, limit)}…` : quoted;
}
