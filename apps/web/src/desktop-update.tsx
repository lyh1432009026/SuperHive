/**
 * 桌面端「有新版本」提示：侧栏底部一个不打扰的入口，点开看版本号、发布说明摘要，
 * 可以下载安装包或者忽略这个版本。只在桌面端出现（浏览器里没有 window.superhiveDesktop.updates）。
 *
 * 网页拿不到任何链接：「下载」「完整发布说明」只告诉桌面端打开哪一个，地址由桌面端从自己的检查结果里取，
 * 并且只会是 github.com 上本仓库 Release 下的地址。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppDialog } from "./app-dialog";
import { Icon } from "./app-icons";
import { Button } from "./button";
import { desktopBridge, type DesktopUpdateInfo, type DesktopUpdatesApi } from "./desktop-bridge";
import { getLocale, t, type Locale } from "./i18n";

/** 发布说明一条里中英文用「 / 」隔开（见 Release 说明的写法），按界面语言取一半；没有分隔就原样 */
export function noteForLocale(note: string, locale: Locale): string {
  const parts = note.split(" / ");
  if (parts.length < 2) return note;
  return (locale === "en" ? parts.slice(1).join(" / ") : parts[0]!).trim() || note;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  // 和访达、GitHub 一样按 1000 进位
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function formatDate(value: string | undefined, locale: Locale): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 订阅桌面端的新版检查结果；不在桌面端（或老版本桌面端）时一直是 undefined */
export function useDesktopUpdate(api: DesktopUpdatesApi | undefined = desktopBridge()?.updates): {
  info: DesktopUpdateInfo | undefined;
  api: DesktopUpdatesApi | undefined;
} {
  const [info, setInfo] = useState<DesktopUpdateInfo>();
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onChange((next) => {
      if (alive) setInfo(next ?? undefined);
    });
    void api
      .get()
      .then((next) => {
        if (alive) setInfo(next ?? undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [api]);
  return { info, api };
}

export function DesktopUpdateEntry({
  api: injected,
  platform = desktopBridge()?.platform,
}: {
  api?: DesktopUpdatesApi;
  platform?: string;
}) {
  const { info, api } = useDesktopUpdate(injected ?? desktopBridge()?.updates);
  const [open, setOpen] = useState(false);
  const [dismissedLocally, setDismissedLocally] = useState<string>();
  if (!api || !info || dismissedLocally === info.version) return null;
  const locale = getLocale();
  const published = formatDate(info.publishedAt, locale);
  const size = formatSize(info.assetSize);
  const notes = info.notes.map((note) => noteForLocale(note, locale)).filter(Boolean);
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        className="sidebar-action desktop-update-entry"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="desktop-update-dot" aria-hidden="true">
          <Icon name="arrow-up" size={12} />
        </span>
        <span>{t("有新版本 {0}", { 0: info.version })}</span>
      </button>
      {open &&
        createPortal(
          <AppDialog
            size="sm"
            title={t("有新版本 {0}", { 0: info.version })}
            className="desktop-update-dialog"
            onClose={close}
            footer={
              <>
                <Button
                  variant="primary"
                  onClick={() => {
                    void api.open("download");
                    close();
                  }}
                >
                  {t("下载")}
                  {size && <span className="desktop-update-size">{size}</span>}
                </Button>
                <Button
                  onClick={() => {
                    setDismissedLocally(info.version);
                    close();
                    void api.dismiss(info.version);
                  }}
                >
                  {t("忽略这个版本")}
                </Button>
                <Button variant="link" onClick={() => void api.open("release")}>
                  {t("完整发布说明")}
                  <Icon name="external" size={13} />
                </Button>
              </>
            }
          >
            <p className="desktop-update-meta">
              {published
                ? t("你现在用的是 {0}，新版发布于 {1}。", { 0: info.currentVersion, 1: published })
                : t("你现在用的是 {0}。", { 0: info.currentVersion })}
            </p>
            {notes.length > 0 && (
              <>
                <h3 className="desktop-update-heading">{t("本版改动")}</h3>
                <ul className="desktop-update-notes">
                  {notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="desktop-update-hint">
              {platform === "win32"
                ? t(
                    "下载后直接运行安装包，会关掉正在运行的 SuperHive 并覆盖安装，房间、消息和设置都会保留。",
                  )
                : t(
                    "下载后打开 dmg，把 SuperHive 拖进「应用程序」替换旧版，再重新打开。房间、消息和设置都会保留。",
                  )}
            </p>
          </AppDialog>,
          document.body,
        )}
    </>
  );
}
