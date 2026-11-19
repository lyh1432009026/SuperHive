import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { t } from "../i18n";
import { formatBytes } from "../workspace-diff";
import {
  OFFICE_PREVIEW_LIMIT,
  OfficePreviewError,
  checkOfficeBytes,
  officeKind,
  type OfficeProblem,
} from "./office-kind";

/**
 * Word / Excel / PowerPoint / CSV 的网页内预览，聊天附件、「产物」面板、「代码」面板共用。
 * 文件只在浏览器里解析，不上传到任何第三方；三种渲染库都按需懒加载，不进首屏包。
 * 渲染出来的 HTML 放进无脚本、无网络的隔离 iframe（见 isolated-frame.tsx），表格直接用 React 渲染文字。
 */

const DocxView = lazy(() => import("./docx-view"));
const PptxView = lazy(() => import("./pptx-view"));
const SheetView = lazy(() => import("./sheet-view"));

type State =
  | { status: "loading" }
  | { status: "ready"; bytes: Uint8Array }
  | { status: "error"; problem: OfficeProblem; detail?: string | undefined };

/** 老一些的环境里 Blob 没有 arrayBuffer()，退回 FileReader */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

function problemOf(cause: unknown): { problem: OfficeProblem; detail?: string } {
  if (cause instanceof OfficePreviewError)
    return {
      problem: cause.problem,
      detail: cause.message !== cause.problem ? cause.message : undefined,
    };
  return { problem: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** 懒加载的分块下载失败、渲染时抛错，都落到「无法预览 + 下载」 */
class ViewBoundary extends Component<
  { onError: (cause: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function OfficeProblemNotice({
  problem,
  detail,
  download,
}: {
  problem: OfficeProblem;
  detail?: string | undefined;
  download?: ReactNode;
}) {
  const message = {
    "too-large": t("文件超过 {0}，不在页面里预览。", { 0: formatBytes(OFFICE_PREVIEW_LIMIT) }),
    encrypted: t("文件设了打开密码或已加密，无法在页面里预览。"),
    invalid: t("文件内容和扩展名对不上：可能已损坏，或是旧版 Office 格式（.doc / .ppt）。"),
    failed: t("无法解析这个文件，可能已损坏，或用到了暂不支持的格式。"),
  }[problem];
  return (
    <div className="office-preview-problem" role="alert">
      <p>
        <strong>{message}</strong>
      </p>
      <p className="office-preview-muted">{t("请下载后用本机的 Office 或 WPS 打开。")}</p>
      {detail && problem === "failed" && (
        <p className="office-preview-detail" title={detail}>
          {detail.slice(0, 200)}
        </p>
      )}
      {download}
    </div>
  );
}

export function OfficePreview({
  name,
  size,
  source,
  load,
  download,
  compact = false,
}: {
  /** 文件名，按扩展名选渲染方式 */
  name: string;
  /** 已知的大小：超限时不去下载 */
  size?: number | undefined;
  /** 这份文件（含版本）的标识，变了才重新读 */
  source: string;
  /** 取文件内容；只在需要时调用 */
  load: () => Promise<Blob | ArrayBuffer>;
  /** 出错时一并给出的下载按钮 */
  download?: ReactNode;
  compact?: boolean;
}) {
  const kind = officeKind(name);
  const [state, setState] = useState<State>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!kind) {
      setState({ status: "error", problem: "invalid" });
      return;
    }
    if (size !== undefined && size > OFFICE_PREVIEW_LIMIT) {
      setState({ status: "error", problem: "too-large" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    loadRef
      .current()
      .then(async (data) => {
        if (!(data instanceof ArrayBuffer) && data.size > OFFICE_PREVIEW_LIMIT)
          throw new OfficePreviewError("too-large");
        const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : await readBlob(data));
        checkOfficeBytes(kind, bytes);
        if (alive) setState({ status: "ready", bytes });
      })
      .catch((cause: unknown) => {
        if (alive) setState({ status: "error", ...problemOf(cause) });
      });
    return () => {
      alive = false;
    };
  }, [kind, size, source]);
  const onError = useCallback((cause: unknown) => {
    setState({ status: "error", ...problemOf(cause) });
  }, []);

  let body: ReactNode;
  if (state.status === "error")
    body = (
      <OfficeProblemNotice problem={state.problem} detail={state.detail} download={download} />
    );
  else if (state.status === "loading" || !kind)
    body = (
      <p className="office-preview-status" role="status">
        {t("正在读取文件…")}
      </p>
    );
  else {
    const props = { bytes: state.bytes, name, compact, onError };
    body = (
      <ViewBoundary key={source} onError={onError}>
        <Suspense
          fallback={
            <p className="office-preview-status" role="status">
              {t("正在加载预览组件…")}
            </p>
          }
        >
          {kind === "docx" ? (
            <DocxView {...props} />
          ) : kind === "pptx" ? (
            <PptxView {...props} />
          ) : (
            <SheetView {...props} kind={kind} />
          )}
        </Suspense>
      </ViewBoundary>
    );
  }
  return (
    <div
      className={`office-preview ${kind ?? ""}${compact ? " compact" : ""}`}
      data-state={state.status}
    >
      {body}
    </div>
  );
}
