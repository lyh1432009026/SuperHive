import { useEffect, useMemo, useRef, useState } from "react";
import { filterGoToItems, type GoToFilter, type GoToItem } from "./goto";
import { t } from "./i18n";
import { keyLabel } from "./shortcuts";
import "./styles/goto.css";

const filters: { value: GoToFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "attention", label: "要处理" },
  // 筛选标签说的是「一类东西」，英文要复数；和下面每行的类型标签分开写
  { value: "task", label: "只看任务" },
  { value: "room", label: "只看房间" },
  { value: "agent", label: "只看 Agent" },
];

const kindLabels: Record<GoToItem["kind"], string> = {
  room: "房间",
  agent: "Agent",
  task: "任务",
};

/** 列表太长时只渲染前面这些，再多就该继续输入缩小范围 */
const MAX_RESULTS = 60;

/**
 * Go To 跳转器：⌘P 打开，一个输入框搜房间、Agent、任务，↑↓ 选、Enter 跳；
 * Tab 在「全部 / 要处理 / 任务 / 房间 / Agent」之间切换范围。
 */
export function GoToPalette({
  items,
  onSelect,
  onNextAttention,
  onClose,
}: {
  items: GoToItem[];
  onSelect: (item: GoToItem) => void;
  /** 有需要处理的任务时，在列表顶部给一个「跳到下一个要处理的」入口 */
  onNextAttention?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GoToFilter>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(
    () => filterGoToItems(items, query, filter).slice(0, MAX_RESULTS),
    [filter, items, query],
  );
  const attentionTotal = items.filter((item) => item.kind === "task" && item.attention).length;

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActiveIndex(0), [query, filter]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const choose = (item: GoToItem | undefined) => {
    if (!item) return;
    onSelect(item);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const index = filters.findIndex((entry) => entry.value === filter);
      const step = event.shiftKey ? -1 : 1;
      setFilter(filters[(index + step + filters.length) % filters.length]!.value);
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[activeIndex]);
    }
  };

  return (
    <div className="activity-layer goto-layer">
      <button type="button" className="activity-scrim" aria-label={t("关闭")} onClick={onClose} />
      <div
        className="activity-panel search goto-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("跳转到")}
        onKeyDown={onKeyDown}
      >
        <header className="activity-header">
          <input
            ref={inputRef}
            type="search"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-label={t("跳转到房间、Agent 或任务")}
            aria-controls="goto-results"
            aria-activedescendant={results.length ? `goto-option-${activeIndex}` : undefined}
            placeholder={t("跳转到房间、Agent 或任务…")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="activity-close" aria-label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="goto-filters" role="group" aria-label={t("范围")}>
          {filters.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={filter === entry.value}
              onClick={() => {
                setFilter(entry.value);
                inputRef.current?.focus();
              }}
            >
              {t(entry.label)}
              {entry.value === "attention" && attentionTotal > 0 && (
                <span className="goto-count">{attentionTotal}</span>
              )}
            </button>
          ))}
          {onNextAttention && attentionTotal > 0 && (
            <button
              type="button"
              className="goto-next"
              title={t("跳到下一个要你处理的任务")}
              onClick={() => {
                onNextAttention();
                onClose();
              }}
            >
              {t("下一个要处理的")}
              <kbd>{keyLabel("Mod")}</kbd>
              <kbd>J</kbd>
            </button>
          )}
        </div>
        <div className="activity-body">
          {results.length === 0 ? (
            <p className="activity-empty">
              {query.trim()
                ? t("没有匹配“{0}”的房间、Agent 或任务。", { 0: query.trim() })
                : filter === "attention"
                  ? t("现在没有要你处理的任务。")
                  : t("这里还没有内容。")}
            </p>
          ) : (
            <ul id="goto-results" ref={listRef} role="listbox" className="goto-list">
              {results.map((item, index) => (
                <li
                  key={item.key}
                  id={`goto-option-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`goto-item ${item.kind}${index === activeIndex ? " active" : ""}`}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                >
                  <span className="goto-kind">{t(kindLabels[item.kind])}</span>
                  <span className="goto-text">
                    <strong>{item.title}</strong>
                    {item.subtitle && <small>{item.subtitle}</small>}
                  </span>
                  {item.kind === "room" && item.current && (
                    <span className="goto-tag">{t("当前")}</span>
                  )}
                  {item.attention > 0 && (
                    <span className="goto-attention">
                      {item.kind === "task"
                        ? t("要处理")
                        : t("{0} 个要处理", { 0: item.attention })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="goto-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("选择")}
          </span>
          <span>
            <kbd>Enter</kbd> {t("跳转")}
          </span>
          <span>
            <kbd>Tab</kbd> {t("切换范围")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("关闭")}
          </span>
        </footer>
      </div>
    </div>
  );
}
