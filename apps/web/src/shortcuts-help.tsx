import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { SHORTCUTS, keyLabel, type Shortcut } from "./shortcuts";
import "./styles/goto.css";

/** 快捷键帮助：? 或 ⌘/ 打开，按说明或按键筛选 */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (shortcut: Shortcut) =>
      !needle ||
      [
        t(shortcut.label),
        shortcut.label,
        t(shortcut.group),
        ...shortcut.keys.map((key) => keyLabel(key)),
        ...shortcut.keys,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    const byGroup = new Map<string, Shortcut[]>();
    for (const shortcut of SHORTCUTS.filter(matches)) {
      const list = byGroup.get(shortcut.group);
      if (list) list.push(shortcut);
      else byGroup.set(shortcut.group, [shortcut]);
    }
    return [...byGroup];
  }, [query]);

  return (
    <div className="activity-layer goto-layer">
      <button type="button" className="activity-scrim" aria-label={t("关闭")} onClick={onClose} />
      <div
        className="activity-panel search shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("快捷键")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="activity-header">
          <input
            ref={inputRef}
            type="search"
            value={query}
            aria-label={t("筛选快捷键")}
            placeholder={t("快捷键 · 输入筛选…")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="activity-close" aria-label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="activity-body">
          {groups.length === 0 ? (
            <p className="activity-empty">{t("没有匹配“{0}”的快捷键。", { 0: query.trim() })}</p>
          ) : (
            groups.map(([group, shortcuts]) => (
              <section key={group} aria-label={t(group)}>
                <h3 className="activity-section-label">{t(group)}</h3>
                <dl className="shortcuts-list">
                  {shortcuts.map((shortcut) => (
                    <div key={`${shortcut.keys.join("+")}:${shortcut.label}`}>
                      <dt>
                        {shortcut.keys.map((key) => (
                          <kbd key={key}>{keyLabel(key)}</kbd>
                        ))}
                      </dt>
                      <dd>{t(shortcut.label)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
