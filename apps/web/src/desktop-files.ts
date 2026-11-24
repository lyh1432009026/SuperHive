/**
 * 桌面端选附件：把系统选文件窗口读回来的文件变成 File，交给现有的上传队列；
 * 超出上传上限没读的，用和网页选文件时同样的话提示。
 */
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments";
import type { DesktopPickedFile } from "./desktop-bridge";
import { t } from "./i18n";

export function pickedToFiles(picked: readonly DesktopPickedFile[]): {
  files: File[];
  notice?: string;
} {
  const files: File[] = [];
  let notice: string | undefined;
  for (const item of picked) {
    if (item.data) {
      files.push(
        new File([item.data as Uint8Array<ArrayBuffer>], item.name, { type: item.type ?? "" }),
      );
      continue;
    }
    if (item.skipped === "too-large")
      notice = t("{0} 超过 20 MB，没有加入", { 0: item.name || t("这个文件") });
    else if (item.skipped === "total") notice = t("一条消息的附件合计不能超过 50 MB");
    else if (item.skipped === "count")
      notice = t("一条消息最多 {0} 个附件，多出的没有加入", { 0: MAX_ATTACHMENTS_PER_MESSAGE });
  }
  return { files, ...(notice ? { notice } : {}) };
}
