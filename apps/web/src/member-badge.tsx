import type { ReactNode } from "react";
import { t } from "./i18n";
import "./styles/member-badge.css";
import { Tooltip } from "./tooltip";

/**
 * 标签级别：warning（黄）是需要人处理的提醒，danger（红）是能力缺失，info（灰）是值得知道但不用处理的状态。
 * 正常状态一律不挂标签——成员名后面只出现需要人看一眼的东西
 */
export type MemberBadgeLevel = "warning" | "danger" | "info";

/**
 * 成员名旁的标签：大小、圆角、颜色只在 member-badge.css 定一处，各种状态（旧版本、工作区、工具、沙箱）都用它，
 * 不再各写一套样式。悬停 / 键盘聚焦看说明；点它不触发成员行的点击
 */
export function MemberBadge({
  level,
  hint,
  children,
}: {
  level: MemberBadgeLevel;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={hint}>
      <span
        className={`member-badge ${level}`}
        tabIndex={0}
        aria-label={hint}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {children}
      </span>
    </Tooltip>
  );
}

/** 成员名：成员多、侧栏窄时名字优先，标签先收起；悬停看 Agent 在本房间实际的工作目录 */
export function MemberName({ name, hint }: { name: string; hint?: string }) {
  const label = <span className="member-name">{name}</span>;
  return hint ? <Tooltip content={hint}>{label}</Tooltip> : label;
}

/** 主 Agent：常驻的身份说明，不算提醒，弱化成名字旁的一个灰字 */
export function LeadMark() {
  return (
    <span
      className="member-lead-mark"
      title={t("主 Agent：没有 @ 任何人的消息由它接话、调度其他 Agent")}
    >
      {t("主")}
    </span>
  );
}
