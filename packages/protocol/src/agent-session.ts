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
      case "gemini":
        return `gemini --resume ${id}`;
      case "agy":
        return `agy --conversation ${id}`;
      case "copilot":
        return `copilot --resume=${id}`;
      default:
        return undefined;
    }
  })();
  // 会话 ID 拼在选项后面：以 - 开头或带奇怪字符的不接，免得被当成别的选项（例如跳过权限确认）
  if (!resume || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.sessionId)) return undefined;
  if (windows && /[%!"^&|<>]/.test(input.cwd)) return undefined;
  return windows ? `cd /d ${quote(input.cwd)} && ${resume}` : `cd ${quote(input.cwd)} && ${resume}`;
}

function posixQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** cmd 的引号：% 和 ! 在引号里也会被展开，带这些字符的路径不接（resumeCommand 返回前会检查） */
function windowsQuote(value: string): string {
  return /^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}
