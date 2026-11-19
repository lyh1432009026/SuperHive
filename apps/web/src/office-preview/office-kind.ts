/**
 * Office 文档预览：按扩展名认类型、限大小、先看文件头认出加密文件。
 * 这一份不依赖任何渲染库，首屏就能用；真正的解析和渲染在懒加载的分块里。
 */

export type OfficeKind = "docx" | "xlsx" | "xls" | "csv" | "pptx";

/** 超过这个大小不在页面里解析：浏览器里解压、排版几十 MB 的文档会卡住整个页面 */
export const OFFICE_PREVIEW_LIMIT = 50 * 1024 * 1024;

const KINDS: Record<string, OfficeKind> = {
  docx: "docx",
  docm: "docx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  xls: "xls",
  csv: "csv",
  tsv: "csv",
  pptx: "pptx",
  pptm: "pptx",
};

export function officeKind(name: string): OfficeKind | undefined {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? KINDS[base.slice(dot + 1)] : undefined;
}

/** CSV 本身是文本：代码面板里还能切回源码，diff 默认看文本 */
export function isTextOffice(kind: OfficeKind | undefined): boolean {
  return kind === "csv";
}

export type OfficeProblem = "too-large" | "encrypted" | "invalid" | "failed";

/** 解析或渲染失败时带上原因，界面按原因给提示 */
export class OfficePreviewError extends Error {
  constructor(
    readonly problem: OfficeProblem,
    message?: string,
  ) {
    super(message ?? problem);
    this.name = "OfficePreviewError";
  }
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** OLE 复合文档：旧版 .xls / .doc / .ppt，也是加了密码的 docx / xlsx / pptx 的外壳 */
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * 交给渲染库之前先看文件头：docx / xlsx / pptx 必须是 zip；是 OLE 复合文档的，几乎都是设了打开密码
 * （Office 加密后把整个 zip 包进 OLE 的 EncryptedPackage），极少数是改了扩展名的旧版二进制文件，
 * 两种都没法在浏览器里打开，统一提示加密或格式不支持。.xls 本来就是 OLE，加密要等解析时才知道。
 */
export function checkOfficeBytes(kind: OfficeKind, bytes: Uint8Array): void {
  if (bytes.byteLength > OFFICE_PREVIEW_LIMIT) throw new OfficePreviewError("too-large");
  if (kind === "csv" || kind === "xls") return;
  if (startsWith(bytes, CFB)) throw new OfficePreviewError("encrypted");
  if (!startsWith(bytes, ZIP)) throw new OfficePreviewError("invalid");
}
