/**
 * 能直接交给系统默认应用打开的类型：文档、表格、演示、文本、图片、音视频。
 * 其余（脚本、程序、安装包、快捷方式、网页、压缩包等）打开可能会运行代码，只给「在文件夹中显示」。
 */
const OPENABLE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "pages",
  "numbers",
  "key",
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "yaml",
  "yml",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
]);

/** 附件能不能直接用本机默认应用打开（Server 校验和网页显示按钮共用） */
export function canOpenWithDefaultApp(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && OPENABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
