import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * 聊天消息、白板里出现的提交号（7–40 位十六进制）和任务分支名（feat/xxx 这类）变成可点的链接：
 * 点了打开「代码」面板并定位到那个提交或那条任务线。
 *
 * 只有能看这个房间代码的人才有链接（App 只在这时提供 WorkspaceRefsContext）；
 * 是不是真的提交或登记过的任务线由服务端批量确认（GET workspace/refs），确认前和不存在的都按普通文字显示。
 */

export type RefTarget = { kind: "commit"; hash: string } | { kind: "branch"; source: string };

type Api = (path: string, query?: Record<string, string | undefined>) => Promise<unknown>;

const HASH = "[0-9a-f]{7,40}";
const BRANCH =
  "(?:feat|fix|chore|docs|refactor|hotfix|release|perf|test|ci|build|style)/[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]";
/** 正文里找候选：前后不能紧挨字母数字等，免得把长串、路径里的一段当成提交号 */
export const refPattern = new RegExp(
  `(?<![0-9A-Za-z_./-])(${HASH}|${BRANCH})(?![0-9A-Za-z_/-])`,
  "g",
);

/** 纯数字或纯字母的十六进制串多半是编号、单词，不当提交号去查 */
export function isRefCandidate(token: string): boolean {
  if (/^[0-9a-f]+$/.test(token)) return /[0-9]/.test(token) && /[a-f]/.test(token);
  return new RegExp(`^${BRANCH}$`).test(token);
}

/** 批量确认：同一批渲染里出现的候选攒一下一起查，查过的记住 */
export class RefResolver {
  private readonly known = new Map<string, RefTarget | null>();
  private readonly queued = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;

  constructor(private readonly api: Api) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  get(token: string): RefTarget | null | undefined {
    return this.known.get(token);
  }

  /** explicit：白板条目的 commit / branch 字段，本来就是提交或分支，不按正文候选规则过滤 */
  request(token: string, explicit = false): void {
    if (this.known.has(token) || this.queued.has(token)) return;
    if (!explicit && !isRefCandidate(token)) return;
    if (/[\s,]/.test(token) || token.length > 200) return;
    this.queued.add(token);
    this.timer ??= setTimeout(() => void this.flush(), 60);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const tokens = [...this.queued].slice(0, 100);
    for (const token of tokens) this.queued.delete(token);
    if (this.queued.size) this.timer = setTimeout(() => void this.flush(), 60);
    try {
      const result = (await this.api("/refs", { q: tokens.join(",") })) as {
        commits?: Record<string, string>;
        branches?: Record<string, string>;
      };
      for (const token of tokens) {
        const hash = result.commits?.[token];
        const source = result.branches?.[token];
        this.known.set(
          token,
          hash ? { kind: "commit", hash } : source ? { kind: "branch", source } : null,
        );
      }
    } catch {
      // 查不了（没权限、网络）就都当普通文字，不再反复请求
      for (const token of tokens) this.known.set(token, null);
    }
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export const WorkspaceRefsContext = createContext<
  { resolver: RefResolver; open: (target: RefTarget) => void } | undefined
>(undefined);

/** 一个候选：确认是提交或任务线就是按钮，否则原样显示 children */
export function RefLink({
  token,
  explicit = false,
  children,
}: {
  token: string;
  explicit?: boolean;
  children?: ReactNode;
}) {
  const context = useContext(WorkspaceRefsContext);
  useSyncExternalStore(
    context?.resolver.subscribe ?? noopSubscribe,
    context?.resolver.snapshot ?? zero,
  );
  useEffect(() => {
    context?.resolver.request(token, explicit);
  }, [context, token, explicit]);
  const target = context?.resolver.get(token);
  if (!context || !target) return <>{children ?? token}</>;
  return (
    <button
      type="button"
      className="md-ref-link"
      title={
        target.kind === "commit"
          ? t("在「代码」面板里查看提交 {0}", { 0: target.hash.slice(0, 7) })
          : t("在「代码」面板里打开任务线 {0}", { 0: token })
      }
      onClick={(event) => {
        event.stopPropagation();
        context.open(target);
      }}
    >
      {children ?? token}
    </button>
  );
}

/** 普通文字里的提交号、分支名换成 RefLink（白板条目这类不走 Markdown 的地方用） */
export function RefText({ text }: { text: string }) {
  const context = useContext(WorkspaceRefsContext);
  if (!context) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(refPattern)) {
    const token = match[1]!;
    if (!isRefCandidate(token)) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(<RefLink key={match.index} token={token} />);
    cursor = match.index + token.length;
  }
  if (!parts.length) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/* ---------- Markdown：remark 插件把候选包成 <span data-ref>，渲染时换成 RefLink ---------- */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

function refNode(token: string, child: MdNode): MdNode {
  return {
    type: "workspaceRef",
    data: { hName: "span", hProperties: { dataRef: token } },
    children: [child],
  };
}

function visit(node: MdNode): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    // `6c28c9a` 这样整段是提交号的行内代码：保留代码样式，外面包一层
    if (child.type === "inlineCode" && child.value && isRefCandidate(child.value)) {
      next.push(refNode(child.value, child));
      changed = true;
      continue;
    }
    if (child.type === "text" && child.value) {
      const value = child.value;
      let cursor = 0;
      const pieces: MdNode[] = [];
      for (const match of value.matchAll(refPattern)) {
        const token = match[1]!;
        if (!isRefCandidate(token)) continue;
        if (match.index > cursor)
          pieces.push({ type: "text", value: value.slice(cursor, match.index) });
        pieces.push(refNode(token, { type: "text", value: token }));
        cursor = match.index + token.length;
      }
      if (pieces.length) {
        if (cursor < value.length) pieces.push({ type: "text", value: value.slice(cursor) });
        next.push(...pieces);
        changed = true;
        continue;
      }
    }
    visit(child);
    next.push(child);
  }
  if (changed) node.children = next;
}

export function remarkWorkspaceRefs() {
  return (tree: MdNode) => visit(tree);
}
