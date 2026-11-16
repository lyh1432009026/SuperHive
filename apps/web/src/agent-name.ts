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

/**
 * 一次接入多个同类 Agent 时的名字：第一个用输入框里的名字，后面去掉末尾数字再按 2、3、4… 往后排，
 * 跳过房间里已有的和这一批里已经用掉的（大小写不敏感），总长不超过 32
 */
export function agentBatchNames(
  first: string,
  count: number,
  takenNames: ReadonlySet<string> = new Set(),
): string[] {
  const names = [first];
  const used = new Set([...takenNames, first.toLocaleLowerCase()]);
  const base = first.replace(/\d+$/, "") || first;
  for (let index = 2; names.length < count && index < 1000; index++) {
    const digits = String(index);
    const candidate = `${base.slice(0, 32 - digits.length)}${digits}`;
    if (used.has(candidate.toLocaleLowerCase())) continue;
    used.add(candidate.toLocaleLowerCase());
    names.push(candidate);
  }
  return names;
}
