import { useState } from "react";
import {
  CLAUDE_COMPACT_WINDOW_DEFAULT,
  CLAUDE_COMPACT_WINDOW_MAX,
  CLAUDE_COMPACT_WINDOW_MIN,
  CLAUDE_COMPACT_WINDOW_PRESETS,
  type ClaudeCacheTtl,
  type ClaudeCompactWindow,
  type LocalAgent,
} from "@superhive/protocol";
import { getLocale, t } from "./i18n";
import { Select, type SelectOption } from "./select";
import { Button } from "./button";

/** 20 万 token / 200k tokens：按界面语言写 token 数 */
export function compactWindowLabel(tokens: number): string {
  return getLocale() === "en"
    ? `${(tokens / 1000).toLocaleString("en")}k tokens`
    : `${(tokens / 10_000).toLocaleString("zh-CN")} 万 token`;
}

const CUSTOM = "custom";

/** 压缩阈值在选择框里的值：档位直接用数字，"auto" 照旧，别的数字算自定义 */
function windowChoice(value: ClaudeCompactWindow): string {
  if (value === "auto") return "auto";
  return (CLAUDE_COMPACT_WINDOW_PRESETS as readonly number[]).includes(value)
    ? String(value)
    : CUSTOM;
}

/**
 * Claude Agent 的上下文设置：自动压缩阈值（默认 40 万 token）和缓存时长（默认跟随 Claude Code）。
 * 写进设置文件，下一轮生效；改了以后常驻的 Claude 进程会换新进程。
 */
export function ClaudeContextSettings({
  agent,
  disabled,
  onSave,
}: {
  agent: Pick<LocalAgent, "compactWindow" | "cacheTtl">;
  disabled: boolean;
  onSave: (settings: {
    compactWindow: ClaudeCompactWindow | null;
    cacheTtl: ClaudeCacheTtl | null;
  }) => Promise<Pick<LocalAgent, "compactWindow" | "cacheTtl">>;
}) {
  const initialWindow = agent.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT;
  const [saved, setSaved] = useState({ window: initialWindow, ttl: agent.cacheTtl ?? "" });
  const [choice, setChoice] = useState(windowChoice(initialWindow));
  const [custom, setCustom] = useState(
    typeof initialWindow === "number" ? String(initialWindow) : "",
  );
  const [ttl, setTtl] = useState<string>(agent.cacheTtl ?? "");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const customTokens = Number(custom.trim());
  const customValid =
    Number.isInteger(customTokens) &&
    customTokens >= CLAUDE_COMPACT_WINDOW_MIN &&
    customTokens <= CLAUDE_COMPACT_WINDOW_MAX;
  const window: ClaudeCompactWindow | undefined =
    choice === "auto"
      ? "auto"
      : choice === CUSTOM
        ? customValid
          ? customTokens
          : undefined
        : Number(choice);
  const dirty = window !== undefined && (window !== saved.window || ttl !== saved.ttl);

  const windowOptions: SelectOption[] = [
    ...CLAUDE_COMPACT_WINDOW_PRESETS.map((tokens) => ({
      value: String(tokens),
      label:
        tokens === CLAUDE_COMPACT_WINDOW_DEFAULT
          ? t("{0}（默认）", { 0: compactWindowLabel(tokens) })
          : compactWindowLabel(tokens),
    })),
    { value: CUSTOM, label: t("自定义…") },
    {
      value: "auto",
      label: t("不限制，交给 Claude Code"),
      description: t("接近模型上下文上限才压缩；会话可能长到几十万 token，越来越慢、越来越贵"),
    },
  ];
  const ttlOptions: SelectOption[] = [
    {
      value: "",
      label: t("跟随 Claude Code（默认）"),
      description: t("Claude Code 自动选：订阅额度内一般 1 小时，超出额度或用 API key 时 5 分钟"),
    },
    { value: "5m", label: t("5 分钟") },
    { value: "1h", label: t("1 小时"), description: t("写缓存更贵") },
  ];

  async function save() {
    if (window === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await onSave({
        // 默认值存成「没设过」：以后默认值改了，没动过的 Agent 跟着变
        compactWindow: window === CLAUDE_COMPACT_WINDOW_DEFAULT ? null : window,
        cacheTtl: ttl === "5m" || ttl === "1h" ? ttl : null,
      });
      const nextWindow = updated.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT;
      setSaved({ window: nextWindow, ttl: updated.cacheTtl ?? "" });
      setTtl(updated.cacheTtl ?? "");
      setChoice(windowChoice(nextWindow));
      if (typeof nextWindow === "number") setCustom(String(nextWindow));
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="agent-model agent-context" aria-labelledby="agent-context-title">
      <h3 id="agent-context-title">{t("上下文与缓存")}</h3>
      <h4>{t("自动压缩")}</h4>
      <Select
        aria-label={t("自动压缩")}
        value={choice}
        options={windowOptions}
        disabled={disabled || saving}
        onChange={(next) => {
          setChoice(next);
          setDone(false);
        }}
      />
      {choice === CUSTOM && (
        <label className="agent-context-custom">
          <input
            className="model-picker-input"
            type="number"
            inputMode="numeric"
            min={CLAUDE_COMPACT_WINDOW_MIN}
            max={CLAUDE_COMPACT_WINDOW_MAX}
            step={10_000}
            value={custom}
            disabled={disabled || saving}
            aria-label={t("自定义压缩阈值（token）")}
            aria-invalid={!customValid}
            onChange={(event) => {
              setCustom(event.target.value);
              setDone(false);
            }}
          />
          <span>token</span>
        </label>
      )}
      <p
        className={choice === CUSTOM && !customValid ? "agent-mcp-hint warning" : "agent-mcp-hint"}
      >
        {choice === CUSTOM && !customValid
          ? t("填 {0}～{1} 之间的整数。", {
              0: CLAUDE_COMPACT_WINDOW_MIN.toLocaleString(),
              1: CLAUDE_COMPACT_WINDOW_MAX.toLocaleString(),
            })
          : t(
              "对话超过这个大小时，Claude 会把前面的内容压成摘要：每轮的速度和费用更稳定，但很早以前的细节只剩摘要。所选模型的上下文比这个小时，按模型上限，接近上限时压缩。",
            )}
      </p>
      <h4>{t("缓存时长")}</h4>
      <Select
        aria-label={t("缓存时长")}
        value={ttl}
        options={ttlOptions}
        disabled={disabled || saving}
        onChange={(next) => {
          setTtl(next);
          setDone(false);
        }}
      />
      {ttl === "1h" && (
        <p className="agent-mcp-hint warning" role="note">
          {t(
            "写缓存的费用从输入单价的 1.25 倍变成 2 倍。两轮之间常隔 5 分钟以上时通常更省、更快；偶尔才聊一句的房间反而更贵。",
          )}
        </p>
      )}
      {error && (
        <p className="agent-mcp-hint warning" role="alert">
          {error}
        </p>
      )}
      <div className="agent-model-actions">
        <small>{t("从下一次回复开始生效，不用重启。")}</small>
        {done && (
          <span className="agent-mcp-saved" role="status">
            {t("已保存。")}
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={disabled || saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? t("保存中…") : t("保存上下文设置")}
        </Button>
      </div>
    </section>
  );
}
