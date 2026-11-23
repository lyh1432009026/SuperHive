import { classifyText } from "./failure.js";
import { AgentNonRetryableError, AgentTransientError } from "./responder.js";

/** 续接的线程已经不在了（Codex 把报错包了好几层）：交给调用方开新线程重来 */
export function isMissingCodexThread(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return classifyText(messages.join("\n")) === "session_invalid";
}

/** Only allowlisted diagnostics enter room-visible errors; never arbitrary stderr/credentials. */
export function codexStartupFailure(
  stage: string,
  error: unknown,
  stderr = "",
): AgentNonRetryableError | AgentTransientError {
  if (error instanceof AgentNonRetryableError || error instanceof AgentTransientError) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const text = `${error instanceof Error ? error.message : ""}\n${stderr}`;
  const reason =
    code === "ENOENT"
      ? "找不到 Codex 命令，请检查安装与 PATH"
      : error instanceof Error && error.name === "CodexRequestTimeoutError"
        ? "握手或会话准备超时；超时不代表不支持该协议"
        : /stdin is not a terminal|not a TTY|interactive TUI|TERM.*dumb/i.test(text)
          ? "CLI 进入了交互终端模式，无法通过 stdio 握手；请使用支持 app-server 的 Codex CLI"
          : /error loading configuration|invalid configuration|unknown variant/i.test(text)
            ? "Codex 配置不兼容，请检查 CLI 配置"
            : typeof code === "number"
              ? `协议请求失败（错误码 ${code}）`
              : "连接关闭或启动失败，请检查 CLI 与本机日志";
  // 握手超时只是一时没连上：还没发执行请求，交给 Bridge 退避重试；其余是安装、配置问题，等多久都一样
  if (error instanceof Error && error.name === "CodexRequestTimeoutError")
    return new AgentTransientError(`Codex ${stage}：${reason}。未发送执行请求，稍后自动重试。`, {
      cause: error,
    });
  return new AgentNonRetryableError(
    `Codex ${stage}：${reason}。未发送执行请求；不会自动降级或重试。`,
    error instanceof Error ? { cause: error } : undefined,
  );
}
