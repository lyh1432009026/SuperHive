import { CodexAppServerResponder } from "./codex-app-server-client.js";
import { defaultCommandRunner } from "./command-runner.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import {
  AgentNonRetryableError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import { compareVersions } from "./update.js";

/**
 * 只走 codex app-server：旧的 `codex mcp-server` 0.149 起弃用、0.154.0 起删除。
 * 最低版本是 app-server 协议里 Hive 用到的方法（thread/resume、turn/steer、turn/interrupt、
 * 结构化错误 codexErrorInfo、用量通知）和配置项（default_tools_approval_mode）都齐了的那一版。
 */
export const CODEX_MIN_VERSION = "0.105.0";
/** 实际连 Hive 跑通过的最新版本；更新的版本照常用，出了协议错误时提示可能是 CLI 改了协议 */
export const CODEX_TESTED_VERSION = "0.171.0";

export function parseCodexVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(output)?.[1];
}

export function codexTooOldMessage(version: string): string {
  return `Codex ${version} 太旧：Hive 通过 app-server 协议驱动 Codex，最低需要 ${CODEX_MIN_VERSION}。请运行 \`codex update\`（或 \`npm i -g @openai/codex@latest\`）升级后重启这个 Agent。`;
}

export function codexTooNewHint(version: string): string {
  return `当前 Codex ${version} 比 Hive 验证过的 ${CODEX_TESTED_VERSION} 新，可能是 CLI 改了协议：请先运行 \`hive update\` 升级 Hive；仍不行就装回 ${CODEX_TESTED_VERSION}（\`npm i -g @openai/codex@${CODEX_TESTED_VERSION}\`）。`;
}

type CodexVersionProbe = () => Promise<string | undefined>;

/**
 * 包一层 CodexAppServerResponder：第一轮先看一眼 CLI 版本，太旧的直接说清楚怎么升级
 * （否则会在握手时得到一句看不懂的协议错误），比验证过的新的在出错时补一句提示。
 */
export class CodexResponder implements AgentResponder {
  private readonly current: AgentResponder;
  private readonly log: (message: string) => void;
  private version: Promise<string | undefined> | undefined;

  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      log?: (message: string) => void;
      settingsFile?: string;
    },
    dependencies: { appServer?: AgentResponder; version?: CodexVersionProbe } = {},
  ) {
    this.log = options.log ?? console.warn;
    this.probeVersion =
      dependencies.version ??
      (() =>
        defaultCommandRunner(options.command, ["--version"], { cwd: options.cwd }).then(
          (result) => parseCodexVersion(`${result.stdout}\n${result.stderr}`),
          // 看不到版本（命令不存在等）不在这里拦：启动 app-server 时会给出准确的原因
          () => undefined,
        ));
    this.current =
      dependencies.appServer ??
      new CodexAppServerResponder({
        command: options.command,
        cwd: options.cwd,
        hive: options.hive,
        ...(options.access ? { access: options.access } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.settingsFile ? { settingsFile: options.settingsFile } : {}),
      });
  }

  private readonly probeVersion: CodexVersionProbe;

  private checkVersion(): Promise<string | undefined> {
    this.version ??= this.probeVersion().then((version) => {
      if (version && compareVersions(version, CODEX_TESTED_VERSION) > 0) {
        this.log(`[hive] ${codexTooNewHint(version)}`);
      }
      return version;
    });
    return this.version;
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const version = await this.checkVersion();
    if (version && compareVersions(version, CODEX_MIN_VERSION) < 0) {
      // 不缓存结论：用户升级 CLI 后下一轮重新看版本，不用重启 Agent
      this.version = undefined;
      throw new AgentNonRetryableError(codexTooOldMessage(version));
    }
    try {
      return await this.current.reply(input);
    } catch (error) {
      if (
        version &&
        error instanceof AgentNonRetryableError &&
        // 只给启动、握手这类协议问题补提示；额度、认证等上游错误和版本无关
        error.message.startsWith("Codex app-server") &&
        compareVersions(version, CODEX_TESTED_VERSION) > 0 &&
        !error.message.includes(CODEX_TESTED_VERSION)
      ) {
        error.message = `${error.message} ${codexTooNewHint(version)}`;
      }
      throw error;
    }
  }

  steer(prompt: string): Promise<boolean> {
    return this.current.steer ? this.current.steer(prompt) : Promise.resolve(false);
  }

  async close(): Promise<void> {
    await this.current.close?.();
  }
}
