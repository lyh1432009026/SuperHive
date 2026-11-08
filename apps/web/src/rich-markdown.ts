import { Editor, Extension, type AnyExtension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { Marked, Tokenizer, type Tokens } from "marked";
import { HardBreak } from "@tiptap/extension-hard-break";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseNode } from "@tiptap/pm/model";

/** 和 draft-highlight.ts、服务端一致：邮箱里的 @ 不算提及 */
const mentionPattern = /(?<![A-Za-z0-9_.])@[\p{L}\p{N}_.-]+/gu;

/**
 * 输入框里写的就是要发出去的 Markdown，不做「防误解析」的转义：
 * 默认的序列化会把 rd_x 写成 rd\_x、把 < 写成 &lt;，@rd-claude_2 这种提及就被拆坏了。
 * 换行和消息展示（remark-breaks）一致：单个换行就是换行。
 */
const PlainMarkdownText = Extension.create({
  name: "plainMarkdownText",
  // 排在 Markdown 扩展之后执行（它在 onBeforeCreate 里才建好 editor.markdown）
  priority: 10,
  onBeforeCreate() {
    const manager = this.editor.markdown as unknown as {
      encodeTextForMarkdown: (text: string) => string;
    };
    if (manager) manager.encodeTextForMarkdown = (text: string) => text;
  },
});

/**
 * 解析和导出要对称：导出不转义，解析时就不能吃掉原文里的东西。
 * - 消息展示不渲染 HTML，所以 <div>、<br> 这类写法在输入框里也只是普通文字，不然翻历史、粘贴时会被吞掉；
 * - 反斜杠原样保留（C:\Users\rd\_x、正则 \d+\.），不当成转义去掉；
 * - &amp;、&lt; 原样保留（编辑器会把文字里的实体解码，先把 & 写成 &amp; 抵消掉）；
 * - 只有 ~~ 才是删除线，「价格 ~100~200 元」不变。
 */
function createMarked() {
  const instance = new Marked({ gfm: true, breaks: true });
  instance.use({
    tokenizer: {
      html(source) {
        const token = Tokenizer.prototype.html.call(this, source) as Tokens.HTML | undefined;
        if (!token) return undefined;
        const text = token.raw.replace(/\n+$/, "");
        const paragraph = {
          type: "paragraph",
          raw: token.raw,
          text,
          tokens: this.lexer.inline(text),
        };
        return paragraph as unknown as Tokens.HTML;
      },
      escape(source) {
        const token = Tokenizer.prototype.escape.call(this, source) as Tokens.Escape | undefined;
        if (!token) return undefined;
        return { ...token, text: token.raw };
      },
      inlineText(source) {
        const token = Tokenizer.prototype.inlineText.call(this, source) as Tokens.Text | undefined;
        if (!token) return undefined;
        return { ...token, text: token.text.replace(/&/g, "&amp;") };
      },
      del(source, maskedSource, previousCharacter) {
        const token = Tokenizer.prototype.del.call(
          this,
          source,
          maskedSource,
          previousCharacter,
        ) as Tokens.Del | undefined;
        if (!token) return undefined;
        if (token.raw.startsWith("~~")) return token;
        return { type: "text", raw: "~", text: "~" } as unknown as Tokens.Del;
      },
      tag(source) {
        const token = Tokenizer.prototype.tag.call(this, source) as Tokens.Tag | undefined;
        if (!token) return undefined;
        return { type: "text", raw: token.raw, text: token.raw } as unknown as Tokens.Tag;
      },
    },
  });
  return instance;
}

const mentionHighlightKey = new PluginKey("mentionHighlight");

function mentionDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, position, parent) => {
    if (!node.isText || !node.text) return;
    if (parent?.type.spec.code || node.marks.some((mark) => mark.type.spec.code)) return;
    for (const match of node.text.matchAll(mentionPattern)) {
      const from = position + match.index;
      decorations.push(
        Decoration.inline(from, from + match[0].length, { class: "composer-mention" }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** 给正文里的 @成员 上色，和发出去后的样子一致 */
const MentionHighlight = Extension.create({
  name: "mentionHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mentionHighlightKey,
        state: {
          init: (_, state) => mentionDecorations(state.doc),
          apply: (transaction, current) =>
            transaction.docChanged ? mentionDecorations(transaction.doc) : current,
        },
        props: {
          decorations(state) {
            return mentionHighlightKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});

export function richComposerExtensions(placeholder: () => string): AnyExtension[] {
  return [
    StarterKit.configure({
      // 链接只在发出去后可点；输入框里点链接会跳走，正在写的内容就丢了
      link: { openOnClick: false, autolink: false, linkOnPaste: true },
      hardBreak: false,
      // Markdown 没有下划线
      underline: false,
      undoRedo: { depth: 200 },
      trailingNode: false,
    }),
    HardBreak.extend({
      renderMarkdown: () => "\n",
      // Shift+Enter 在 RichComposer 里统一处理（代码块、列表里另有行为）
      addKeyboardShortcuts: () => ({}),
    }).configure({ keepMarks: true }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
    Markdown.configure({ marked: createMarked() as never }),
    PlainMarkdownText,
    MentionHighlight,
  ];
}

/** 编辑器内容转成要发送的 Markdown：块之间空一行，去掉末尾多余的换行 */
export function editorMarkdown(editor: Editor): string {
  if (editor.isEmpty) return "";
  return editor.getMarkdown().replace(/^\n+|\n+$/g, "");
}
