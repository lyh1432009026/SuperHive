import { lazy, useState } from "react";

// Markdown 渲染器（react-markdown + highlight.js）体积较大，拆成独立 chunk 且在应用启动时
// 立即预加载：不阻塞首屏解析，又通常能赶在 WebSocket 快照到达前就绪，避免消息先以纯文本闪现
const messageMarkdownModule = import("./message-markdown");
type MessageMarkdownComponent = (typeof import("./message-markdown"))["MessageMarkdown"];
// 模块下载完成后同步渲染：React.lazy 第一次使用时总会挂起一轮（即使模块早已就绪），
// 先显示纯文本占位再换成 Markdown，会让消息列表在刷新时多一次重排和高度跳变
let loadedMessageMarkdown: MessageMarkdownComponent | undefined;
void messageMarkdownModule.then((module) => {
  loadedMessageMarkdown = module.MessageMarkdown;
});
const LazyMessageMarkdown = lazy(() =>
  messageMarkdownModule.then((module) => ({ default: module.MessageMarkdown })),
);
export function MessageMarkdown(props: Parameters<MessageMarkdownComponent>[0]) {
  // 每个实例挂载时选定一次，避免模块就绪后组件类型改变导致整条消息重新挂载
  const [Component] = useState<MessageMarkdownComponent | typeof LazyMessageMarkdown>(
    () => loadedMessageMarkdown ?? LazyMessageMarkdown,
  );
  return <Component {...props} />;
}
