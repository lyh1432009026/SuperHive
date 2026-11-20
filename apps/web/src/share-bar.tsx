import { Suspense, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@superhive/protocol";
import { buildShareMarkdown, downloadFile, formatShareTimestamp, shareFilename } from "./share";
import { copyTextToClipboard } from "./clipboard";
import { AvatarGlyph, avatarHueStyle } from "./avatar";
import { MessageMarkdown } from "./message-markdown-lazy";
import { t } from "./i18n";

/** 分享模式：选中若干条消息，复制或下载成 Markdown，或导出成图片 */
export function useShareSelection({
  messages,
  currentRoomId,
  currentRoomName,
}: {
  messages: ChatMessage[];
  currentRoomId: string;
  currentRoomName: string;
}) {
  const [shareMode, setShareMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(new Set());
  const [shareBusy, setShareBusy] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string>();
  const shareCardRef = useRef<HTMLDivElement>(null);
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.has(message.id) && !message.deletedAt),
    [messages, selectedMessageIds],
  );

  function toggleMessageSelected(messageId: string) {
    setSelectedMessageIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function toggleSelectAllMessages() {
    setSelectedMessageIds((previous) =>
      previous.size === messages.length
        ? new Set()
        : new Set(messages.map((message) => message.id)),
    );
  }

  function exitShareMode() {
    setShareMode(false);
    setSelectedMessageIds(new Set());
    setShareFeedback(undefined);
  }

  async function copyShareMarkdown() {
    try {
      await copyTextToClipboard(buildShareMarkdown(selectedMessages, currentRoomName));
      setShareFeedback(t("Markdown 已复制到剪贴板"));
    } catch {
      setShareFeedback(t("复制失败：剪贴板不可用"));
    }
  }

  function downloadShareMarkdown() {
    downloadFile(
      shareFilename(currentRoomId, "md"),
      new Blob([buildShareMarkdown(selectedMessages, currentRoomName)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    setShareFeedback(t("已下载 Markdown 文件"));
  }

  async function exportShareImage() {
    const node = shareCardRef.current;
    if (!node) return;
    setShareBusy(true);
    setShareFeedback(undefined);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(node, { pixelRatio: 2 });
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = shareFilename(currentRoomId, "png");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setShareFeedback(t("图片已导出"));
    } catch {
      setShareFeedback(t("图片导出失败，请重试。"));
    } finally {
      setShareBusy(false);
    }
  }

  return {
    shareMode,
    setShareMode,
    selectedMessageIds,
    shareBusy,
    shareFeedback,
    shareCardRef,
    selectedMessages,
    toggleMessageSelected,
    toggleSelectAllMessages,
    exitShareMode,
    copyShareMarkdown,
    downloadShareMarkdown,
    exportShareImage,
  };
}

export type ShareSelection = ReturnType<typeof useShareSelection>;

/** 分享模式下对话区底部的工具条，和导出图片时离屏渲染的分享卡片 */
export function ShareBar({
  share,
  messages,
  currentRoomName,
  agentProviderByName,
}: {
  share: ShareSelection;
  messages: ChatMessage[];
  currentRoomName: string;
  agentProviderByName: ReadonlyMap<string, string | undefined>;
}) {
  const {
    shareMode,
    selectedMessageIds,
    shareBusy,
    shareFeedback,
    shareCardRef,
    selectedMessages,
    toggleSelectAllMessages,
    exitShareMode,
    copyShareMarkdown,
    downloadShareMarkdown,
    exportShareImage,
  } = share;
  return (
    <>
      {shareMode && (
        <div className="share-bar" role="toolbar" aria-label={t("分享选中的消息")}>
          <span className="share-count" role="status">
            {t("已选 {0} 条", { 0: selectedMessages.length })}
          </span>
          <button type="button" onClick={toggleSelectAllMessages}>
            {messages.length > 0 && selectedMessageIds.size === messages.length
              ? t("清空")
              : t("全选")}
          </button>
          <button
            type="button"
            disabled={selectedMessages.length === 0 || shareBusy}
            onClick={() => void copyShareMarkdown()}
          >
            {t("复制 Markdown")}
          </button>
          <button
            type="button"
            disabled={selectedMessages.length === 0 || shareBusy}
            onClick={downloadShareMarkdown}
          >
            {t("下载 .md")}
          </button>
          <button
            type="button"
            disabled={selectedMessages.length === 0 || shareBusy}
            onClick={() => void exportShareImage()}
          >
            {shareBusy ? t("导出中…") : t("导出图片")}
          </button>
          {shareFeedback && (
            <span className="share-feedback" role="status">
              {shareFeedback}
            </span>
          )}
          <button type="button" className="share-exit" onClick={exitShareMode}>
            {t("退出")}
          </button>
        </div>
      )}
      {shareMode && selectedMessages.length > 0 && (
        <div className="share-card-stage" aria-hidden="true">
          <div ref={shareCardRef} className="share-card">
            <header className="share-card-header">
              <strong># {currentRoomName}</strong>
              <span>{t("SUPERHIVE · 对话分享")}</span>
            </header>
            {selectedMessages.map((message) => (
              <div
                key={message.id}
                className={`share-card-message ${message.senderType}`}
                style={
                  message.senderType === "human" ? avatarHueStyle(message.senderName) : undefined
                }
              >
                <span className={`share-card-avatar ${message.senderType}`}>
                  <AvatarGlyph
                    type={message.senderType}
                    name={message.senderName}
                    provider={agentProviderByName.get(message.senderName.toLocaleLowerCase())}
                  />
                </span>
                <div className="share-card-body">
                  <header>
                    <strong>{message.senderName}</strong>
                    {message.senderType === "agent" && <b>Agent</b>}
                    <time dateTime={message.createdAt}>
                      {formatShareTimestamp(message.createdAt)}
                    </time>
                    <span className="share-card-seq">#{message.seq}</span>
                  </header>
                  <div className="message-body">
                    <Suspense fallback={<p className="message-body-fallback">{message.content}</p>}>
                      <MessageMarkdown content={message.content} />
                    </Suspense>
                  </div>
                </div>
              </div>
            ))}
            <footer className="share-card-footer">
              <span>{t("导出于 {0}", { 0: formatShareTimestamp(new Date().toISOString()) })}</span>
              <span>SuperHive</span>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
