import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Tooltip } from "./tooltip";

/**
 * 按钮规范（样式见 styles/button.css）。全项目的操作按钮都用这里的组件，不再手写按钮样式：
 *
 *   <Button variant="primary" onClick={save}>保存</Button>
 *   <Button variant="secondary" size="sm" tone="danger">断开</Button>
 *   <IconButton label={t("关闭")} onClick={onClose}><CloseGlyph /></IconButton>
 *
 * - variant：primary 主要 / secondary 次要（默认）/ ghost 幽灵 / danger 危险 / link 文字链接；
 * - size：md 32px（默认）/ sm 28px / lg 40px（只给登录这类整页表单）；
 * - tone="danger"：secondary、ghost、link 的红字版本（会删东西但还有下一步确认）；
 * - loading：转圈、不可点，aria-busy；文字保留占位，宽度不跳；
 * - type 默认 "button"，表单提交要显式写 type="submit"。
 *
 * 弹窗底部用 <div className="dialog-actions">：主要按钮放最后（最右），取消在它左边，
 * 和主流程无关的删除类操作加 className="dialog-actions-start" 放最左；窄屏自动竖排、主要按钮在上。
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "md" | "sm" | "lg";

export type ButtonStyle = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: "danger";
  /** 纯图标正方形按钮；一般直接用 IconButton */
  icon?: boolean;
  /** 撑满宽度：只给窄表单、引导页里单独的一个按钮用 */
  block?: boolean;
};

/** 按规范拼 class；给 <a>、<label> 这类不能换成 <button> 的元素用 */
export function buttonClass(
  { variant = "secondary", size = "md", tone, icon, block }: ButtonStyle = {},
  extra?: string,
): string {
  return [
    "btn",
    `btn-${variant}`,
    size === "md" ? "" : `btn-${size}`,
    tone === "danger" && variant !== "danger" ? "btn-tone-danger" : "",
    icon ? "btn-icon" : "",
    block ? "btn-block" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  ButtonStyle & {
    loading?: boolean;
    ref?: Ref<HTMLButtonElement>;
  };

export function Button({
  variant,
  size,
  tone,
  icon,
  block,
  loading = false,
  className,
  type = "button",
  disabled,
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, tone, icon, block }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {wrapText(children)}
    </button>
  );
}

/** 加载时要把内容藏起来占位：裸文字包一层 span，图标和元素原样 */
function wrapText(children: ReactNode): ReactNode {
  return typeof children === "string" || typeof children === "number" ? (
    <span>{children}</span>
  ) : (
    children
  );
}

export type IconButtonProps = Omit<ButtonProps, "icon" | "aria-label" | "title"> & {
  /** 读屏念的名字，也是默认的悬停提示 */
  label: string;
  /** 悬停提示和名字不同时写这个（比如带说明）；false 表示外层已经包了 Tooltip */
  tooltip?: ReactNode | false;
  shortcut?: string[];
};

/** 纯图标按钮：必须有名字（aria-label），悬停用 Tooltip 提示，不用原生 title */
export function IconButton({
  label,
  tooltip,
  shortcut,
  variant = "ghost",
  ...rest
}: IconButtonProps) {
  const button = <Button {...rest} variant={variant} icon aria-label={label} />;
  if (tooltip === false) return button;
  return (
    <Tooltip content={tooltip ?? label} {...(shortcut ? { shortcut } : {})}>
      {button}
    </Tooltip>
  );
}
