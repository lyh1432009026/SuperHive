import { z } from "zod";

/**
 * Agent 进程运行的代码版本：Bridge 加入房间时上报，进程生命周期内不变。
 * npm 安装只有包版本；源码运行（仓库里 tsx）另带启动时的 HEAD 提交和 Agent 代码的 git 树指纹。
 */
export const agentCodeVersionSchema = z.object({
  /** superhive 包版本（package.json） */
  package: z.string().min(1).max(64),
  /** 源码运行：启动时仓库的 HEAD 提交 */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .optional(),
  /**
   * 源码运行：启动时 packages/superhive 与 packages/protocol 两个目录的 git 树对象。
   * 只有 Agent 会加载的代码变了它才变，只改网页、文档的提交不会让 Agent 算作旧版本。
   */
  fingerprint: z.string().min(1).max(128).optional(),
});

export type AgentCodeVersion = z.infer<typeof agentCodeVersionSchema>;

/** 按数字比较 x.y.z（预发布后缀按字符串）；a 比 b 旧返回负数 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre = ""] = value.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // 1.0.0-beta 比 1.0.0 旧
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * running 是否落后于 current。
 * sameCheckout：两边是同一份代码（本机 Server 拉起的 Agent），这时按树指纹判断，指纹不同就是旧的；
 * 否则（别的电脑上的 Agent）指纹没有可比性，只在包版本更低时才算旧。
 * 任一边不知道版本时返回 false：不确定就不打扰。
 */
export function isAgentOutdated(
  running: AgentCodeVersion | undefined,
  current: AgentCodeVersion | undefined,
  sameCheckout: boolean,
): boolean {
  if (!running || !current) return false;
  if (sameCheckout && current.fingerprint) return running.fingerprint !== current.fingerprint;
  return compareVersions(running.package, current.package) < 0;
}

/** 给人看的简短版本：0.3.1 · 277e2c5 */
export function formatAgentVersion(version: AgentCodeVersion): string {
  return version.commit ? `${version.package} · ${version.commit.slice(0, 7)}` : version.package;
}
