import { t } from "./i18n";

/**
 * 整数步进器：「−  2  +」一体的分段控件，替代浏览器自带的 number 输入框（那对小箭头又小又难点）。
 * 中间是 role="spinbutton"：方向键 ↑↓ 加减、Home/End 跳到最小/最大，读屏会读出当前值和范围
 */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const set = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return (
    <div className={`stepper${disabled ? " disabled" : ""}`}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("减少")}
        disabled={disabled || value <= min}
        onClick={() => set(value - 1)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <span
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={disabled || undefined}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
          if (step !== undefined) set(value + step);
          else if (event.key === "Home") set(min);
          else if (event.key === "End") set(max);
          else return;
          event.preventDefault();
        }}
      >
        {value}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("增加")}
        disabled={disabled || value >= max}
        onClick={() => set(value + 1)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M3.5 8h9M8 3.5v9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
