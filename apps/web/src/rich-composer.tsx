import { Extension, type Editor } from "@tiptap/core";
import { Selection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { findMentionContext, type MentionContext } from "./mention-autocomplete";
import { editorMarkdown, richComposerExtensions } from "./rich-markdown";

/** App 用来控制输入框的方法；HTMLTextAreaElement 本身也满足，纯文本模式直接用它 */
export type ComposerHandle = {
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
  /** 用选中的成员替换正在输入的 @xx */
  applyMention?: (username: string) => void;
};

export type ComposerKeyInfo = {
  /** 光标在 Markdown 文本里的大致位置：开头 0、末尾 value.length，在中间时是负数 */
  selectionStart: number;
  selectionEnd: number;
  /** 光标在代码块里：Enter 换行，不发送 */
  inCode: boolean;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** 光标附近的 @ 提及变化（输入法组字时不报） */
  onMentionContext: (value: string, context: MentionContext | undefined) => void;
  /** 返回 true 表示 App 已处理（发送、选成员、翻历史） */
  onKeyDown: (event: KeyboardEvent, info: ComposerKeyInfo) => boolean;
  onPasteFiles: (files: File[]) => void;
  handleRef: (handle: ComposerHandle | null) => void;
  placeholder: string;
  expanded: boolean;
  ariaLabel: string;
  ariaExpanded: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  /** 「换行」用的键：Enter 发送时是 Shift+Enter，组合键发送时 Enter、Shift+Enter 都是换行 */
  newlineOnEnter: boolean;
};

/** 顶层段落里，光标所在「这一行」（上一个软换行之后）的文字 */
function currentLine(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph") return undefined;
  let lineStart = $from.start();
  let breakPos: number | undefined;
  $from.parent.forEach((child, offset) => {
    const position = $from.start() + offset;
    if (child.type.name === "hardBreak" && position < $from.pos) {
      breakPos = position;
      lineStart = position + 1;
    }
  });
  return { text: state.doc.textBetween(lineStart, $from.pos, "\n", "\n"), lineStart, breakPos };
}

/**
 * 软换行之后的那一行开头敲「- 」「1. 」「# 」「> 」「```ts 」时，先在这里断开成新段落，
 * 再交给编辑器自带的格式规则，和在段落开头敲是一样的效果（纯文本里这样写本来就会变成列表、标题）
 */
function splitBeforeBlockMarker(view: EditorView, text: string): boolean {
  if (text !== " ") return false;
  if (swallowListMarker(view)) return true;
  const line = currentLine(view.state);
  if (!line || line.breakPos === undefined) return false;
  if (!/^(#{1,6}|[-*+]|\d+[.)]|>|```[\w-]*)$/.test(line.text)) return false;
  view.dispatch(view.state.tr.delete(line.breakPos, line.breakPos + 1).split(line.breakPos));
  const position = view.state.selection.from;
  const handled = view.someProp("handleTextInput", (handle) =>
    handle(view, position, position, text, () => view.state.tr.insertText(text, position)),
  );
  if (!handled) view.dispatch(view.state.tr.insertText(text, position));
  return true;
}

/** 列表自动续上了新的一项，又手敲了「2. 」「- 」：吃掉重复的标记，不变成「2. 2. 」 */
function swallowListMarker(view: EditorView): boolean {
  const { $from, empty } = view.state.selection;
  if (!empty || $from.depth < 2 || $from.parentOffset !== $from.parent.content.size) return false;
  const list = $from.node(-2);
  if ($from.node(-1).type.name !== "listItem" || $from.index(-1) !== 0) return false;
  const marker = $from.parent.textContent;
  const ordered = /^\d+[.)]$/.test(marker);
  const bullet = /^[-*+]$/.test(marker);
  if (
    !(ordered && list.type.name === "orderedList") &&
    !(bullet && list.type.name === "bulletList")
  ) {
    return false;
  }
  view.dispatch(view.state.tr.delete($from.start(), $from.pos));
  return true;
}

/** 一行只有 ```ts 时换行：变成代码块 */
function fenceToCodeBlock(editor: Editor): boolean {
  const line = currentLine(editor.state);
  const fence = line && /^```([\w-]*)$/.exec(line.text);
  if (!line || !fence) return false;
  const { tr } = editor.state;
  tr.delete(line.lineStart, editor.state.selection.from);
  if (line.breakPos !== undefined) tr.delete(line.breakPos, line.breakPos + 1).split(line.breakPos);
  editor.view.dispatch(tr);
  return editor.commands.setCodeBlock(fence[1] ? { language: fence[1] } : undefined);
}

/**
 * 换行：代码块里插入换行，列表里另起一项（空项再换行就退出列表），引用里连按两次退出引用，
 * 其他地方是软换行（发出去是单个换行，和纯文本输入框一致）
 */
function insertNewline(editor: Editor): boolean {
  if (editor.isActive("codeBlock")) return editor.commands.newlineInCode();
  if (fenceToCodeBlock(editor)) return true;
  const { $from, empty } = editor.state.selection;
  // 最里层的列表项（普通列表或任务列表）
  let item: string | undefined;
  for (let depth = $from.depth; depth > 0 && !item; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") item = name;
  }
  if (item) {
    if (empty && $from.parent.content.size === 0) return editor.commands.liftListItem(item);
    if (editor.commands.splitListItem(item)) return true;
  }
  if (editor.isActive("heading")) return editor.commands.splitBlock();
  if (editor.isActive("blockquote") && empty) {
    if ($from.parent.content.size === 0) return editor.commands.lift("blockquote");
    const atEnd = $from.parentOffset === $from.parent.content.size;
    if (atEnd && $from.nodeBefore?.type.name === "hardBreak") {
      return editor
        .chain()
        .deleteRange({ from: $from.pos - 1, to: $from.pos })
        .splitBlock()
        .lift("blockquote")
        .run();
    }
  }
  return editor.commands.setHardBreak();
}

/** 光标所在段落里、光标之前的文字；行内的换行等占一个字符，位置和文档一一对应 */
function mentionAtCursor(editor: Editor) {
  const { selection } = editor.state;
  if (!selection.empty) return undefined;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return undefined;
  if ($from.marks().some((mark) => mark.type.spec.code)) return undefined;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\n");
  const context = findMentionContext(before, before.length);
  if (!context) return undefined;
  const blockStart = $from.start();
  return { context, from: blockStart + context.start, to: blockStart + context.end };
}

export default function RichComposer(props: Props) {
  const propsRef = useRef(props);
  propsRef.current = props;
  /** 最近一次由编辑器产生的 Markdown；value 和它不同说明是外部改的（翻历史、发送后清空、切房间） */
  const emittedRef = useRef(props.value);
  const mentionRef = useRef<ReturnType<typeof mentionAtCursor>>(undefined);

  const reportMention = (editor: Editor, value: string) => {
    if (editor.view.composing) return;
    mentionRef.current = mentionAtCursor(editor);
    propsRef.current.onMentionContext(value, mentionRef.current?.context);
  };

  const editor = useEditor({
    extensions: [
      ...richComposerExtensions(() => propsRef.current.placeholder),
      Extension.create({
        name: "composerKeys",
        // 先于自带的 Enter（分段）、Shift+Enter（跳出代码块）
        priority: 1000,
        addKeyboardShortcuts() {
          return {
            "Shift-Enter": ({ editor }) => insertNewline(editor),
            Enter: ({ editor }) =>
              propsRef.current.newlineOnEnter && !editor.isActive("codeBlock")
                ? insertNewline(editor)
                : false,
          };
        },
      }),
    ],
    content: props.value,
    contentType: "markdown",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "rich-composer-content message-body",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown(view, event) {
        if (view.composing || event.isComposing || event.keyCode === 229) return false;
        const current = editorRef.current;
        if (!current) return false;
        const { selection, doc } = view.state;
        const length = emittedRef.current.length;
        const atStart = selection.from <= Selection.atStart(doc).from;
        const atEnd = selection.to >= Selection.atEnd(doc).to;
        // 只有在开头 / 末尾才翻历史；中间用 -1 表示，选中一段文字时两端不同
        const caret = atStart ? 0 : atEnd ? length : -1;
        const handled = propsRef.current.onKeyDown(event, {
          selectionStart: selection.empty ? caret : -1,
          selectionEnd: selection.empty ? caret : -2,
          inCode: current.isActive("codeBlock"),
        });
        if (handled) event.preventDefault();
        return handled;
      },
      handleTextInput(view, _from, _to, text) {
        return splitBeforeBlockMarker(view, text);
      },
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return false;
        const files = [...data.files];
        if (files.length) {
          // 截图、复制的图片当附件；复制的文件路径文字仍按文字处理
          propsRef.current.onPasteFiles(files);
          return true;
        }
        const text = data.getData("text/plain");
        const html = data.getData("text/html");
        const current = editorRef.current;
        // 从网页、文档复制的带格式内容交给编辑器按格式粘贴；纯文字（含从编辑器 / 终端复制的代码）按 Markdown 解析
        if (!current || !text || (html && !data.types.includes("vscode-editor-data"))) return false;
        if (current.isActive("codeBlock") || current.isActive("code")) return false;
        if (!/[\n*_`#>[\]|~-]|^\d+\./.test(text)) return false;
        current.commands.insertContent(text, { contentType: "markdown" });
        view.focus();
        return true;
      },
      handleDrop(_view, event) {
        // 拖进来的文件由外层输入框收成附件，编辑器不插入任何东西
        return Boolean((event as DragEvent).dataTransfer?.files.length);
      },
    },
    onUpdate({ editor }) {
      const value = editorMarkdown(editor);
      emittedRef.current = value;
      propsRef.current.onChange(value);
      reportMention(editor, value);
    },
    onSelectionUpdate({ editor }) {
      reportMention(editor, emittedRef.current);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // 外部改了内容：整体换掉，光标放到末尾
  useEffect(() => {
    if (!editor || props.value === emittedRef.current) return;
    emittedRef.current = props.value;
    editor.commands.setContent(props.value, { contentType: "markdown", emitUpdate: false });
    editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from);
    mentionRef.current = undefined;
  }, [editor, props.value]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          class: "rich-composer-content message-body",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": props.ariaLabel,
          "aria-autocomplete": "list",
          "aria-expanded": String(props.ariaExpanded),
          ...(props.ariaControls ? { "aria-controls": props.ariaControls } : {}),
          ...(props.ariaActiveDescendant
            ? { "aria-activedescendant": props.ariaActiveDescendant }
            : {}),
        },
      },
    });
  }, [editor, props.ariaLabel, props.ariaExpanded, props.ariaControls, props.ariaActiveDescendant]);

  // 占位文字跟着主 Agent 变
  useEffect(() => {
    if (editor?.isEmpty) editor.view.dispatch(editor.state.tr.setMeta("placeholder", true));
  }, [editor, props.placeholder]);

  useLayoutEffect(() => {
    if (!editor) return;
    // 纯文本输入框（编辑器加载完之前的占位）有焦点时，把焦点接过来
    const active = document.activeElement;
    const takeFocus = active instanceof HTMLTextAreaElement && active.closest(".composer-input");
    const handle: ComposerHandle = {
      focus: (options) => {
        editor.view.focus();
        if (options?.preventScroll) return;
        editor.commands.scrollIntoView();
      },
      setSelectionRange: (start) => {
        const { doc } = editor.state;
        const target = start <= 0 ? Selection.atStart(doc) : Selection.atEnd(doc);
        editor.commands.setTextSelection(target.from);
      },
      applyMention: (username) => {
        const mention = mentionRef.current;
        if (!mention) return;
        const next = editor.state.doc.textBetween(
          mention.to,
          Math.min(mention.to + 1, editor.state.doc.content.size),
          "\n",
          "\n",
        );
        const text = `@${username}${/\s/u.test(next) ? "" : " "}`;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.insertText(text, mention.from, mention.to);
            return true;
          })
          .run();
        if (/\s/u.test(next)) editor.commands.setTextSelection(mention.from + text.length + 1);
        mentionRef.current = undefined;
      },
    };
    props.handleRef(handle);
    if (takeFocus) {
      editor.commands.focus("end");
    }
    return () => props.handleRef(null);
  }, [editor]);

  return (
    <div className={`rich-composer${props.expanded ? " expanded" : ""}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
