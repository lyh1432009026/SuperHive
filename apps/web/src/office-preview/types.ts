/** 各格式视图共用的入参：拿到的是已经读进内存、过了大小和文件头检查的字节 */
export type OfficeViewProps = {
  bytes: Uint8Array;
  name: string;
  /** 嵌在详情栏、diff 两侧这类窄小区域里：少些工具栏、留白更小 */
  compact: boolean;
  /** 解析或渲染失败；传 OfficePreviewError 时按原因提示 */
  onError: (cause: unknown) => void;
};
