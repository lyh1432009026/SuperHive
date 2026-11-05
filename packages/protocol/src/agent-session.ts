/** 在终端里接着 Agent 当前会话的命令；不支持的 Provider 返回 undefined */
export function resumeCommand(input: {
  provider: string;
  sessionId: string;
  cwd: string;
  platform?: string;
}): string | undefined {
  const windows = input.platform === "win32";
  const quote = windows ? windowsQuote : posixQuote;
  const id = quote(input.sessionId);
  const resume = (() => {
    switch (input.provider) {
      case "claude":
        return `claude --resume ${id}`;
      case "codex":
        return `codex resume ${id}`;
      case "opencode":
        return `opencode --session ${id}`;
      case "omp":
        return `omp --resume ${id}`;
      case "copilot":
        return `copilot --resume ${id}`;
      default:
        return undefined;
    }
  })();
  if (!resume) return undefined;
  return windows ? `cd /d ${quote(input.cwd)} && ${resume}` : `cd ${quote(input.cwd)} && ${resume}`;
}

function posixQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsQuote(value: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}
