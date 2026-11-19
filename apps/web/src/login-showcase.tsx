import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ProviderLogo } from "./provider-logos";
import { t, useLocale } from "./i18n";

/**
 * 登录页左栏的「活的房间」：一段按节奏自动播放的演示——人 @Agent、Agent 认领并执行、
 * 停下来等人决定、交付文件和提交、合入。纯装饰，整体对读屏隐藏。
 * 离开视口或切到后台时暂停；减少动态效果、或环境不支持 IntersectionObserver 时直接显示最后一帧。
 */

type Beat = { ms: number };

/** 每一拍停留多久；下标就是 step */
const BEATS: Beat[] = [
  { ms: 1900 }, // 0 输入框里打字
  { ms: 1000 }, // 1 消息发出，排队
  { ms: 1500 }, // 2 认领，执行中：读代码
  { ms: 1500 }, // 3 执行中：画预览，对方正在输入
  { ms: 1900 }, // 4 提问，等你决定
  { ms: 1300 }, // 5 人选了一个选项
  { ms: 1500 }, // 6 继续执行，正在输入
  { ms: 2400 }, // 7 交付：附件 + 提交
  { ms: 3600 }, // 8 合入
];
const LAST = BEATS.length - 1;
const TYPE_INTERVAL_MS = 55;

function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** 不能动的环境（减少动态效果、测试环境）只给静态的完整画面 */
function canAnimate(): boolean {
  return typeof IntersectionObserver !== "undefined" && !prefersReducedMotion();
}

/** still：SuperHive「外观」里开了减少动态效果 */
export function LoginShowcase({ still = false }: { still?: boolean }) {
  useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [canMove] = useState(canAnimate);
  const animated = canMove && !still;
  const [playing, setPlaying] = useState(0);
  const step = animated ? playing : LAST;
  const [typed, setTyped] = useState(0);
  const [running, setRunning] = useState(false);
  // 循环时整段先淡出再从头开始
  const [resetting, setResetting] = useState(false);

  const live = animated && running;
  const draft = t("@claude 登录页左边太空了，做个好看的版本");

  useEffect(() => {
    if (!animated) return;
    const root = rootRef.current;
    if (!root) return;
    let visible = false;
    const update = () => setRunning(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      update();
    });
    observer.observe(root);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [animated]);

  // 第 0 拍逐字打出草稿
  useEffect(() => {
    if (!live || step !== 0 || typed >= draft.length) return;
    const timer = window.setTimeout(() => setTyped((count) => count + 1), TYPE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [draft.length, live, step, typed]);

  useEffect(() => {
    if (!live) return;
    if (step === 0 && typed < draft.length) return;
    const timer = window.setTimeout(() => {
      if (step < LAST) {
        setPlaying(step + 1);
        return;
      }
      setResetting(true);
    }, BEATS[step]?.ms ?? 1000);
    return () => window.clearTimeout(timer);
  }, [draft.length, live, step, typed]);

  useEffect(() => {
    if (!resetting) return;
    const timer = window.setTimeout(() => {
      setTyped(0);
      setPlaying(0);
      setResetting(false);
    }, 480);
    return () => window.clearTimeout(timer);
  }, [resetting]);

  const at = (index: number) => step >= index;
  const chip =
    step <= 1
      ? { state: "queued", label: t("排队中"), detail: "" }
      : step === 2
        ? { state: "running", label: t("执行中"), detail: t("读取 login.css") }
        : step === 3
          ? { state: "running", label: t("执行中"), detail: t("画左栏预览") }
          : step <= 5
            ? { state: "waiting", label: t("等你决定"), detail: "" }
            : step === 6
              ? { state: "running", label: t("执行中"), detail: t("跑测试") }
              : { state: "done", label: t("已完成"), detail: t("3 分 12 秒") };
  const typing = animated && (step === 3 || step === 6);

  return (
    <div
      ref={rootRef}
      className={`showcase ${animated ? "animated" : "static"} ${resetting ? "resetting" : ""}`}
      aria-hidden="true"
    >
      <div className="showcase-window">
        <header className="showcase-header">
          <span className="showcase-room">
            <span className="showcase-hash">#</span>build
          </span>
          <span className="showcase-members">
            <Avatar kind="human" />
            <Avatar kind="claude" />
            <Avatar kind="codex" />
            <span className="showcase-online">{t("3 位在线")}</span>
          </span>
        </header>

        <div className="showcase-thread">
          {at(1) && (
            <div className="showcase-message enter">
              <Avatar kind="human" />
              <div className="showcase-body">
                <div className="showcase-meta">
                  <strong>Mia</strong>
                  <time>10:24</time>
                </div>
                <p>
                  <span className="showcase-mention">@claude</span>{" "}
                  {draft.replace(/^@claude\s*/, "")}
                </p>
                <span className={`showcase-chip ${chip.state}`}>
                  <span className="showcase-dot">{chip.state === "done" && <CheckGlyph />}</span>
                  <span className="showcase-chip-agent">claude</span>
                  <span className="showcase-chip-status">{chip.label}</span>
                  {chip.detail && (
                    <span key={chip.detail} className="showcase-chip-detail">
                      {chip.detail}
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {at(4) && (
            <div className="showcase-message agent enter">
              <Avatar kind="claude" />
              <div className="showcase-body">
                <div className="showcase-meta">
                  <strong>claude</strong>
                  <span className="showcase-badge">Agent</span>
                  <time>10:26</time>
                </div>
                <p>{t("左栏放动态的房间预览，还是一张静态插画？")}</p>
                <div className="showcase-options">
                  <span className={`showcase-option ${at(5) ? "picked" : ""}`}>
                    {at(5) && <CheckGlyph />}
                    {t("动态预览")}
                  </span>
                  <span className={`showcase-option ${at(5) ? "dimmed" : ""}`}>
                    {t("静态插画")}
                  </span>
                </div>
              </div>
            </div>
          )}

          {at(7) && (
            <div className="showcase-message agent enter">
              <Avatar kind="claude" />
              <div className="showcase-body">
                <div className="showcase-meta">
                  <strong>claude</strong>
                  <span className="showcase-badge">Agent</span>
                  <time>10:29</time>
                </div>
                <p>{t("做好了，明暗主题和窄屏都看过。")}</p>
                <div className="showcase-artifacts">
                  <span className="showcase-file">
                    <span className="showcase-thumb">
                      <span />
                      <span />
                    </span>
                    <span className="showcase-file-text">
                      <strong>login-after.png</strong>
                      <span>1440 × 900 · 182 KB</span>
                    </span>
                  </span>
                  <span className="showcase-commit">
                    <CommitGlyph />
                    <code>a3f9c21</code>
                    <span>feat(web): {t("登录页重做")}</span>
                  </span>
                </div>
              </div>
            </div>
          )}

          {at(8) && (
            <div className="showcase-system enter">
              <Avatar kind="codex" />
              <span>{t("codex 审核通过，已合入 main")}</span>
            </div>
          )}

          {typing && (
            <div className="showcase-typing enter">
              <span className="showcase-typing-dots">
                <span />
                <span />
                <span />
              </span>
              {t("claude 正在输入…")}
            </div>
          )}
        </div>

        <div className={`showcase-composer ${step === 0 && typed > 0 ? "active" : ""}`}>
          <span className="showcase-composer-text">
            {step === 0 && typed > 0 ? (
              <>
                {draft.slice(0, typed)}
                <span className="showcase-caret" />
              </>
            ) : (
              <span className="showcase-placeholder">{t("发消息，@ 提及 Agent…")}</span>
            )}
          </span>
          <span className={`showcase-send ${step === 0 && typed >= draft.length ? "ready" : ""}`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
              <path d="M12 19V5m-6 6 6-6 6 6" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 演示里的人类成员 Mia：和真实头像一样按色相上色 */
const HUMAN_STYLE = { "--avatar-hue": 28 } as CSSProperties;

function Avatar({ kind }: { kind: "human" | "claude" | "codex" }) {
  if (kind === "human") {
    return (
      <span className="showcase-avatar human" style={HUMAN_STYLE}>
        M
      </span>
    );
  }
  return (
    <span className="showcase-avatar agent">
      <ProviderLogo provider={kind} />
    </span>
  );
}

function CheckGlyph() {
  return (
    <svg className="showcase-check" viewBox="0 0 24 24" width="10" height="10" fill="none">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function CommitGlyph() {
  return (
    <svg className="showcase-commit-icon" viewBox="0 0 24 24" width="14" height="14" fill="none">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5m7 0H21" />
    </svg>
  );
}
