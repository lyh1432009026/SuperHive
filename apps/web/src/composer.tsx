import { Suspense, lazy } from "react";
import { MAX_MESSAGE_LENGTH, MESSAGE_LENGTH_WARNING_RATIO } from "./collapsible-message";
import { highlightDraft } from "./draft-highlight";
import { ComposerAttachments, PaperclipIcon } from "./attachments";
import { KeyCombo } from "./key-combo";
import { participantStatusLabel } from "./agent-setup";
import { Icon } from "./app-icons";
import { AvatarGlyph, avatarHueStyle } from "./avatar";
import { composerMaxHeight } from "./composer-size";
import { MessageMarkdown } from "./message-markdown-lazy";
import type { SendShortcut } from "./app-storage";
import type { ComposerState } from "./use-composer";
import { t } from "./i18n";
import { Tooltip } from "./tooltip";

/** 所见即所得输入框（Tiptap）单独打包，用到时才加载；加载完之前先用纯文本输入框顶着 */
const RichComposer = lazy(() => import("./rich-composer"));

/** 对话区底部：回到最新、@ 成员候选、回答提问提示、输入框和发送按钮 */
export function Composer({
  composer,
  showJumpToBottom,
  pendingNewMessages,
  jumpToLatest,
  connectionState,
  sendShortcut,
  richComposer,
  currentRoomId,
}: {
  composer: ComposerState;
  showJumpToBottom: boolean;
  pendingNewMessages: number;
  jumpToLatest: () => void;
  connectionState: "connecting" | "online" | "offline";
  sendShortcut: SendShortcut;
  richComposer: boolean;
  currentRoomId: string;
}) {
  const {
    answering,
    setAnswering,
    draft,
    setDraft,
    mentionContext,
    setMentionContext,
    activeMentionIndex,
    setActiveMentionIndex,
    composingRef,
    textareaRef,
    composerPreview,
    setComposerPreview,
    composerExpanded,
    setComposerExpanded,
    attachComposer,
    browsingHistoryRef,
    highlightRef,
    attachmentQueue,
    fileInputRef,
    attachmentNotice,
    dragActive,
    setDragActive,
    addAttachments,
    mentionSuggestions,
    mentionMenuRef,
    draftTooLong,
    steerTargets,
    canSend,
    sendMessage,
    visibleMention,
    updateMentionContext,
    handleComposerKey,
    chooseMention,
    composerPlaceholder,
  } = composer;
  const plainComposerInput = (
    <>
      <div
        className="composer-highlight"
        ref={highlightRef}
        aria-hidden="true"
        hidden={composerPreview}
      >
        {highlightDraft(draft).map((segment, index) =>
          segment.kind === "mention" ? (
            <mark key={index}>{segment.text}</mark>
          ) : segment.kind ? (
            <span key={index} className={`md-${segment.kind}`}>
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
        {/* 末尾换行需要占位，否则高亮层比输入框少一行 */}
        {"\u200b"}
      </div>
      <textarea
        ref={attachComposer}
        rows={1}
        hidden={composerPreview}
        value={draft}
        onScroll={(event) => {
          if (highlightRef.current) {
            highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!composingRef.current) {
            updateMentionContext(event.target.value, event.target.selectionStart);
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onSelect={(event) => {
          // 翻到的旧消息以 @某人 结尾时不弹成员列表，否则方向键会被列表接走
          if (!composingRef.current && event.currentTarget.value !== browsingHistoryRef.current) {
            updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart);
          }
        }}
        onPaste={(event) => {
          // 只接收浏览器交来的文件（截图、复制的图片）；粘贴的路径文本仍按文字处理，不去读本地文件
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          addAttachments(files);
        }}
        onKeyDown={(event) => {
          // ⌘/Ctrl+Shift+E：切到预览
          if (
            (event.metaKey || event.ctrlKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "e" &&
            draft.trim()
          ) {
            event.preventDefault();
            setComposerPreview(true);
            return;
          }
          if (composingRef.current) return;
          const textarea = event.currentTarget;
          if (
            handleComposerKey(event.nativeEvent, {
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
              inCode: false,
            })
          ) {
            event.preventDefault();
          }
        }}
        placeholder={composerPlaceholder}
        aria-label={t("消息")}
        aria-autocomplete="list"
        aria-controls={mentionContext ? "mention-suggestions" : undefined}
        aria-expanded={Boolean(mentionContext)}
        aria-activedescendant={
          mentionContext && mentionSuggestions[activeMentionIndex]
            ? `mention-option-${mentionSuggestions[activeMentionIndex].id}`
            : undefined
        }
      />
    </>
  );
  return (
    <div className="composer">
      {showJumpToBottom && !mentionContext && (
        <Tooltip content={t("回到最新消息")}>
          <button
            type="button"
            className="jump-to-bottom"
            aria-label={t("滚动到底部")}
            onClick={jumpToLatest}
          >
            <Icon name="arrow-down" size={16} />
          </button>
        </Tooltip>
      )}
      {pendingNewMessages > 0 && !mentionContext && (
        <button type="button" className="jump-pill" onClick={jumpToLatest}>
          {t("↓ {0} 条新消息", { 0: pendingNewMessages })}
        </button>
      )}
      {mentionContext && (
        <div ref={mentionMenuRef} className="mention-menu" id="mention-suggestions" role="listbox">
          <div className="mention-menu-heading">
            <span>{t("提及成员")}</span>
            <small>{t("{0} 个匹配", { 0: mentionSuggestions.length })}</small>
          </div>
          {mentionSuggestions.length > 0 ? (
            <div className="mention-options">
              {mentionSuggestions.map((participant, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  id={`mention-option-${participant.id}`}
                  className={`mention-option ${index === activeMentionIndex ? "active" : ""}`}
                  key={participant.id}
                  onMouseMove={(event) => {
                    // 键盘翻动使列表滚到静止的鼠标下时，浏览器也会补发鼠标事件，不能让它抢走选中项
                    if (event.movementX || event.movementY) setActiveMentionIndex(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseMention(participant)}
                >
                  <span
                    className={`mention-avatar ${participant.type}`}
                    style={
                      participant.type === "human"
                        ? avatarHueStyle(participant.username)
                        : undefined
                    }
                    aria-hidden="true"
                  >
                    <AvatarGlyph
                      type={participant.type}
                      name={participant.username}
                      provider={participant.provider}
                    />
                  </span>
                  <span className="mention-member-copy">
                    <strong>@{participant.username}</strong>
                    <small>
                      {participant.type === "agent" ? "Agent" : t("用户")} ·{" "}
                      {participantStatusLabel(participant.status)}
                    </small>
                  </span>
                  <span
                    className={`status-dot ${participant.status}`}
                    aria-label={participantStatusLabel(participant.status)}
                  />
                </button>
              ))}
            </div>
          ) : (
            <div className="mention-empty">{t("没有找到匹配的成员")}</div>
          )}
          <div className="mention-menu-footer">
            <span>
              <kbd>↑↓</kbd> {t("选择")}
            </span>
            <span>
              <kbd>Enter</kbd> {t("或")} <kbd>Tab</kbd> {t("补全")}
            </span>
            <span>
              <kbd>Esc</kbd> {t("关闭")}
            </span>
          </div>
        </div>
      )}
      {answering && answering.roomId === currentRoomId && (
        <div className="composer-answering" role="status">
          <strong>{t("回答 @{0} 的提问", { 0: answering.senderName })}</strong>
          <span>{answering.content.replace(/\s+/g, " ")}</span>
          <Tooltip content={t("取消回答，改为普通消息")}>
            <button
              type="button"
              aria-label={t("取消回答")}
              onClick={() => setAnswering(undefined)}
            >
              ×
            </button>
          </Tooltip>
        </div>
      )}
      <div
        className={`composer-box${dragActive ? " drag-active" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragActive(false);
          addAttachments([...event.dataTransfer.files]);
        }}
      >
        <ComposerAttachments
          items={attachmentQueue.items}
          onRemove={attachmentQueue.remove}
          onRetry={attachmentQueue.retry}
        />
        <div className="composer-input">
          {composerPreview && (
            <div
              className="composer-preview"
              role="region"
              aria-label={t("Markdown 预览")}
              tabIndex={0}
              ref={(element) => element?.focus({ preventScroll: true })}
              style={{ maxHeight: `${composerMaxHeight(composerExpanded)}px` }}
              onKeyDown={(event) => {
                const toggle =
                  (event.metaKey || event.ctrlKey) &&
                  event.shiftKey &&
                  event.key.toLowerCase() === "e";
                if (event.key !== "Escape" && !toggle) return;
                event.preventDefault();
                event.stopPropagation();
                setComposerPreview(false);
                window.requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onClick={() => {
                setComposerPreview(false);
                window.requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              title={t("点一下回到编辑")}
            >
              {draft.trim() ? (
                <div className="message-body">
                  <MessageMarkdown content={draft} />
                </div>
              ) : (
                <p className="composer-preview-empty">{t("还没有内容")}</p>
              )}
            </div>
          )}
          {richComposer ? (
            <Suspense fallback={plainComposerInput}>
              <RichComposer
                value={draft}
                onChange={(value) => setDraft(value)}
                onMentionContext={(value, context) => {
                  // 翻到的旧消息以 @某人 结尾时不弹成员列表，否则方向键会被列表接走
                  if (value && value === browsingHistoryRef.current) return;
                  setMentionContext(visibleMention(context));
                  setActiveMentionIndex(0);
                }}
                onKeyDown={handleComposerKey}
                onPasteFiles={addAttachments}
                handleRef={attachComposer}
                placeholder={composerPlaceholder}
                expanded={composerExpanded}
                newlineOnEnter={sendShortcut === "modifier-enter"}
                ariaLabel={t("消息")}
                ariaExpanded={Boolean(mentionContext)}
                ariaControls={mentionContext ? "mention-suggestions" : undefined}
                ariaActiveDescendant={
                  mentionContext && mentionSuggestions[activeMentionIndex]
                    ? `mention-option-${mentionSuggestions[activeMentionIndex].id}`
                    : undefined
                }
              />
            </Suspense>
          ) : (
            plainComposerInput
          )}
        </div>
        <div className="composer-footer">
          <Tooltip content={t("添加图片或文件（也可以粘贴截图、拖入文件）")}>
            <button
              type="button"
              className="composer-attach"
              onClick={() => fileInputRef.current?.click()}
              aria-label={t("添加附件")}
            >
              <PaperclipIcon />
            </button>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addAttachments([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          {(attachmentNotice || attachmentQueue.failed) && (
            <span className="composer-notice" role="status">
              {attachmentNotice ?? t("有附件上传失败，请重试或移除后再发送")}
            </span>
          )}
          {!richComposer && (draft.trim() || composerPreview) && (
            <Tooltip
              content={composerPreview ? t("回到编辑") : t("预览 Markdown 效果")}
              shortcut={["Mod", "Shift", "E"]}
            >
              <button
                type="button"
                className={`composer-tool ${composerPreview ? "active" : ""}`}
                aria-pressed={composerPreview}
                onClick={() => {
                  setComposerPreview((value) => !value);
                  if (composerPreview) {
                    window.requestAnimationFrame(() => textareaRef.current?.focus());
                  }
                }}
              >
                {composerPreview ? t("编辑") : t("预览")}
              </button>
            </Tooltip>
          )}
          <Tooltip
            content={
              composerExpanded
                ? t("收起输入框，回到普通高度")
                : t("把输入框拉高到约半屏，写长内容更方便；发送后自动收回")
            }
          >
            <button
              type="button"
              className={`composer-tool composer-expand ${composerExpanded ? "active" : ""}`}
              aria-pressed={composerExpanded}
              aria-label={composerExpanded ? t("收起输入框") : t("展开输入框")}
              onClick={() => {
                setComposerExpanded((value) => !value);
                window.requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            >
              <Icon name={composerExpanded ? "minimize" : "maximize"} size={15} />
              <span>{composerExpanded ? t("收起") : t("展开")}</span>
            </button>
          </Tooltip>
          <span className="composer-hint">
            {/* 按当前发送方式显示：⌘↵ 发送 · ↵ 换行，或 ↵ 发送 · ⇧↵ 换行 */}
            {t("{0} 发送 · {1} 换行")
              .split(/(\{[01]\})/)
              .map((part, index) => {
                const keys =
                  sendShortcut === "modifier-enter"
                    ? { "{0}": ["Mod", "Enter"], "{1}": ["Enter"] }
                    : { "{0}": ["Enter"], "{1}": ["Shift", "Enter"] };
                return part === "{0}" || part === "{1}" ? (
                  <KeyCombo key={index} keys={keys[part]} />
                ) : (
                  part
                );
              })}
          </span>
          <div className="composer-actions">
            {draftTooLong ? (
              <span className="char-count danger" role="alert">
                {t("超出 {0} 字，无法发送", {
                  0: (draft.trim().length - MAX_MESSAGE_LENGTH).toLocaleString(),
                })}
              </span>
            ) : (
              draft.length > MAX_MESSAGE_LENGTH * MESSAGE_LENGTH_WARNING_RATIO && (
                <span className="char-count">
                  {draft.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
                </span>
              )
            )}
            {steerTargets.length > 0 && (
              <Tooltip
                content={t("{0} 正在执行任务：发出后直接用来引导它当前的任务，不排队", {
                  0: steerTargets.map((name) => `@${name}`).join(t("、")),
                })}
              >
                <button
                  type="button"
                  className="composer-steer"
                  onClick={() => sendMessage(true)}
                  disabled={!canSend || connectionState !== "online"}
                >
                  {t("引导")}
                </button>
              </Tooltip>
            )}
            <Tooltip
              content={t("发送")}
              shortcut={sendShortcut === "modifier-enter" ? ["Mod", "Enter"] : ["Enter"]}
            >
              <button
                type="button"
                className="composer-send"
                aria-label={t("发送")}
                onClick={() => sendMessage()}
                disabled={!canSend || connectionState !== "online"}
              >
                <Icon name="arrow-up" size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
