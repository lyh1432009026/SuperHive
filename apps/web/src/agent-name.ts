export type SelectableAgentProvider =
  "codex" | "claude" | "copilot" | "openclaw" | "opencode" | "omp";

const providerSuffixes: Record<SelectableAgentProvider, string> = {
  codex: "-codex",
  claude: "-claude",
  copilot: "-copilot",
  openclaw: "-openclaw",
  opencode: "-opencode",
  omp: "-omp",
};

/**
 * 接入 Agent 的默认名：房主名 + 提供方后缀（rd-claude）。
 * 传入房间成员名（小写）时避开重名并自增：rd-claude → rd-claude2 → rd-claude3，
 * 与服务端按房间大小写不敏感的重名校验（USERNAME_TAKEN）对齐；总长不超过 32。
 */
export function agentNameFor(
  ownerUsername: string,
  provider: SelectableAgentProvider,
  takenNames?: ReadonlySet<string>,
): string {
  const suffix = providerSuffixes[provider];
  const base = `${ownerUsername.slice(0, 32 - suffix.length)}${suffix}`;
  if (!takenNames) return base;
  const taken = (name: string) => takenNames.has(name.toLocaleLowerCase());
  if (!taken(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const digits = String(index);
    const candidate = `${base.slice(0, 32 - digits.length)}${digits}`;
    if (!taken(candidate)) return candidate;
  }
  // 房间里不可能有上千个同名成员；真到这一步交回服务端报错
  return base;
}
