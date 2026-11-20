// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";
import {
  ComposerAttachments,
  FilePreview,
  MessageAttachments,
  formatBytes,
  nameForPastedFile,
  previewKind,
  useAttachmentQueue,
  wheelZoomFactor,
  type QueuedAttachment,
} from "./attachments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 记录发出的上传请求，由测试决定何时完成 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = {
    onprogress: null as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | undefined;
  aborted = false;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe("附件上传队列", () => {
  it("凭证放在请求头里；上传完成后才交出附件 ID；失败可重试", () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    );
    const { result } = renderHook(() =>
      useAttachmentQueue({ base: "http://hive", token: "secret", roomId: "general" }),
    );
    act(() => {
      result.current.add([new File(["hello"], "a.txt", { type: "text/plain" })]);
    });
    const request = FakeXhr.instances[0]!;
    expect(request.url).toBe("http://hive/api/rooms/general/attachments");
    expect(request.url).not.toContain("secret");
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(result.current.uploading).toBe(true);
    expect(result.current.readyIds).toEqual([]);

    act(() => request.respond(500, { error: "磁盘满了" }));
    expect(result.current.failed).toBe(true);
    expect(result.current.items[0]?.error).toBe("磁盘满了");

    act(() => result.current.retry(result.current.items[0]!.localId));
    const second = FakeXhr.instances[1]!;
    act(() => second.respond(201, { id: "att-1", name: "a.txt", kind: "text" }));
    expect(result.current.readyIds).toEqual(["att-1"]);
    expect(result.current.failed).toBe(false);
  });

  it("超过单个文件或件数上限的不加入，并给出提示", () => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const { result } = renderHook(() =>
      useAttachmentQueue({ base: "http://hive", token: "t", roomId: "general" }),
    );
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    let notice: string | undefined;
    act(() => {
      notice = result.current.add([big]);
    });
    expect(notice).toContain("超过 20 MB");
    expect(result.current.items).toHaveLength(0);
    act(() => {
      notice = result.current.add(
        Array.from({ length: 12 }, (_, index) => new File(["x"], `f${index}.txt`)),
      );
    });
    expect(result.current.items).toHaveLength(10);
    expect(notice).toContain("最多 10 个");
  });
});

describe("待发附件", () => {
  it("显示进度、失败原因，可移除与重试", () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const file = new File(["x"], "notes.md");
    const items: QueuedAttachment[] = [
      { localId: "1", file, name: "notes.md", size: 2048, status: "uploading", progress: 0.4 },
      {
        localId: "2",
        file,
        name: "bad.md",
        size: 10,
        status: "error",
        progress: 0,
        error: "没有上传权限",
      },
    ];
    render(<ComposerAttachments items={items} onRemove={onRemove} onRetry={onRetry} />);
    expect(screen.getByText("上传中 40%")).toBeTruthy();
    expect(screen.getByText("没有上传权限")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试上传 bad.md" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 notes.md" }));
    expect(onRetry).toHaveBeenCalledWith("2");
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("剪贴板截图起一个可读的名字；普通文件名保留", () => {
    expect(nameForPastedFile(new File(["x"], "image.png", { type: "image/png" }), 0)).toMatch(
      /^粘贴图片-\d{8}-\d{6}\.png$/,
    );
    expect(nameForPastedFile(new File(["x"], "设计稿.jpg", { type: "image/jpeg" }), 0)).toBe(
      "设计稿.jpg",
    );
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("图片查看器", () => {
  it("同一条消息的多张图可以用方向键切换，并能放大缩小与复位", async () => {
    let made = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["x"], { type: "image/png" }))),
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:${++made}` }));
    const image = (id: string, name: string) => ({
      id,
      name,
      kind: "image" as const,
      mime: "image/png",
      size: 10,
      sha256: "0".repeat(64),
    });
    render(
      <MessageAttachments
        attachments={[
          image("00000000-0000-4000-8000-0000000000f1", "a.png"),
          image("00000000-0000-4000-8000-0000000000f2", "b.png"),
          image("00000000-0000-4000-8000-0000000000f3", "c.png"),
        ]}
        base="http://hive"
        token="t"
      />,
    );
    const first = await screen.findByRole("button", { name: "查看图片 a.png" });
    await vi.waitFor(() => expect(first).toHaveProperty("disabled", false));
    fireEvent.click(first);
    const viewer = await screen.findByRole("dialog", { name: "a.png" });
    expect(viewer.textContent).toContain("1 / 3");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "b.png" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    // 第一张往前是最后一张
    expect(await screen.findByRole("dialog", { name: "c.png" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("150%");
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("225%");
    fireEvent.keyDown(window, { key: "0" });
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("100%");
    // 100% 是整张放进可视区；还能再缩小到一半
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("50%");
    expect(screen.getByRole("button", { name: "缩小" })).toHaveProperty("disabled", true);

    // 触控板捏合是一串带 ctrlKey 的小 wheel 事件：按滚动量平滑缩放，并拦住浏览器自己的页面缩放
    fireEvent.keyDown(window, { key: "0" });
    for (let i = 0; i < 10; i += 1) {
      expect(fireEvent.wheel(viewerOf("c.png"), { deltaY: -2, ctrlKey: true })).toBe(false);
    }
    expect(screen.getByRole("button", { name: "复位缩放" }).textContent).toBe("113%");

    // 快速连续捏合（一帧里好几个事件）：以指针为中心累乘，指针下那一点始终不动，不会来回抖
    fireEvent.keyDown(window, { key: "0" });
    act(() => {
      for (let i = 0; i < 30; i += 1) {
        fireEvent.wheel(viewerOf("c.png"), {
          deltaY: -5,
          ctrlKey: true,
          clientX: 100,
          clientY: 40,
        });
      }
    });
    const zoomed = viewerOf("c.png").querySelector("img")!;
    const [, x, y, scale] = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.]+)\)/
      .exec(zoomed.style.transform)!
      .map(Number);
    // jsdom 里舞台中心在 (0, 0)：指针点 (100, 40) 缩放后仍在原处 ⇒ 平移 = 指针 × (1 - 倍数)
    expect(x).toBeCloseTo(100 * (1 - scale!), 3);
    expect(y).toBeCloseTo(40 * (1 - scale!), 3);
    expect(zoomed.classList.contains("wheeling")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const viewerOf = (name: string) => screen.getByRole("dialog", { name });

describe("滚轮缩放倍数", () => {
  it("按滚动量连续缩放：捏合的小事件缩得慢，鼠标滚轮一格约 1.2 倍，单次有上限", () => {
    expect(wheelZoomFactor({ deltaY: -2, deltaMode: 0, ctrlKey: true })).toBeCloseTo(1.012, 3);
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(1.197, 3);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1);
    // Firefox 按行滚动：3 行折算成 48px
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(1.09, 2);
    expect(wheelZoomFactor({ deltaY: -2000, deltaMode: 0, ctrlKey: true })).toBeCloseTo(
      Math.exp(0.22),
      5,
    );
  });
});

describe("文件预览", () => {
  const file = (id: string, name: string, kind: "text" | "file", mime: string) => ({
    id,
    name,
    kind,
    mime,
    size: 20,
    sha256: "0".repeat(64),
  });

  it("Markdown、代码和 PDF 在页面内预览，其他文件照旧下载", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# 对比报告\n\n结论在这里")),
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
    render(
      <MessageAttachments
        attachments={[
          file("00000000-0000-4000-8000-0000000000a1", "report.md", "text", "text/markdown"),
          file("00000000-0000-4000-8000-0000000000a2", "spec.pdf", "file", "application/pdf"),
          file("00000000-0000-4000-8000-0000000000a3", "data.zip", "file", "application/zip"),
        ]}
        base="http://hive"
        token="t"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 report.md" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 report.md" });
    // Markdown 渲染器按需加载，机器忙时第一次可能要多等一会
    expect(
      await screen.findByRole("heading", { name: "对比报告" }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("结论在这里");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览 spec.pdf" }));
    await vi.waitFor(() => expect(document.querySelector("iframe.file-preview-pdf")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // 不能预览的照旧是下载
    expect(screen.getByRole("button", { name: "下载 data.zip" })).toBeTruthy();
  });

  it("预览顶部能停到右侧栏：弹窗关掉交给 onDock；停靠时不是弹窗、不接管 Esc，能放大回弹窗", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# 方案\n\n正文")),
    );
    const report = file("00000000-0000-4000-8000-0000000000d9", "plan.md", "text", "text/markdown");
    const onDock = vi.fn();
    const { unmount } = render(
      <MessageAttachments attachments={[report]} base="http://hive" token="t" onDock={onDock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 plan.md" }));
    await screen.findByRole("dialog", { name: "预览 plan.md" });
    fireEvent.click(screen.getByRole("button", { name: "在右侧栏打开" }));
    expect(onDock).toHaveBeenCalledWith(report);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    // 不给 onDock 就没有这个按钮（例如代码面板里的预览）
    render(<MessageAttachments attachments={[report]} base="http://hive" token="t" />);
    fireEvent.click(screen.getByRole("button", { name: "预览 plan.md" }));
    await screen.findByRole("dialog", { name: "预览 plan.md" });
    expect(screen.queryByRole("button", { name: "在右侧栏打开" })).toBeNull();
    cleanup();

    const onClose = vi.fn();
    const onUndock = vi.fn();
    render(
      <FilePreview
        attachment={report}
        base="http://hive"
        token="t"
        docked
        onClose={onClose}
        onUndock={onUndock}
        notice={<button type="button">有新版本</button>}
      />,
    );
    expect(await screen.findByRole("heading", { name: "方案" }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "有新版本" })).toBeTruthy();
    // 停靠时只有「放大成弹窗」，没有铺满窗口的放大
    expect(screen.queryByRole("button", { name: "放大预览" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放大成弹窗" }));
    expect(onUndock).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏预览" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("记住上次在右侧栏看：之后点文件直接停到右侧栏，放大成弹窗改回弹窗，关掉不算改", async () => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("# 方案\n\n正文")),
    );
    const report = file("00000000-0000-4000-8000-0000000000da", "plan.md", "text", "text/markdown");
    const onDock = vi.fn();
    render(
      <MessageAttachments attachments={[report]} base="http://hive" token="t" onDock={onDock} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 plan.md" }));
    await screen.findByRole("dialog", { name: "预览 plan.md" });
    fireEvent.click(screen.getByRole("button", { name: "在右侧栏打开" }));
    expect(localStorage.getItem("superhive.preview-docked")).toBe("1");

    // 再点文件：不弹窗，直接交给 onDock
    onDock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "预览 plan.md" }));
    expect(onDock).toHaveBeenCalledWith(report);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    // 没有右侧栏可停（不给 onDock）时照旧弹窗
    render(<MessageAttachments attachments={[report]} base="http://hive" token="t" />);
    fireEvent.click(screen.getByRole("button", { name: "预览 plan.md" }));
    await screen.findByRole("dialog", { name: "预览 plan.md" });
    cleanup();

    const onClose = vi.fn();
    render(
      <FilePreview
        attachment={report}
        base="http://hive"
        token="t"
        docked
        onClose={onClose}
        onUndock={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭侧栏预览" }));
    expect(localStorage.getItem("superhive.preview-docked")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "放大成弹窗" }));
    expect(localStorage.getItem("superhive.preview-docked")).toBeNull();
  });

  it("音视频在页面内播放：老附件只记了 octet-stream 也按扩展名认出来，并按正确的类型交给播放器", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob([new Uint8Array([0, 0, 0, 0x18])]))),
    );
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return `blob:media-${blobs.length}`;
        },
        revokeObjectURL: () => {},
      }),
    );
    render(
      <MessageAttachments
        attachments={[
          file(
            "00000000-0000-4000-8000-0000000000c1",
            "bird.mp4",
            "file",
            "application/octet-stream",
          ),
          file("00000000-0000-4000-8000-0000000000c2", "voice.mp3", "file", "audio/mpeg"),
        ]}
        base="http://hive"
        token="t"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 bird.mp4" }));
    const video = await vi.waitFor(() => {
      const element = document.querySelector<HTMLVideoElement>("video.file-preview-video");
      if (!element) throw new Error("no video");
      return element;
    });
    expect(video.getAttribute("src")).toMatch(/^blob:media-/);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(blobs.at(-1)?.type).toBe("video/mp4");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "预览 voice.mp3" }));
    await vi.waitFor(() =>
      expect(document.querySelector(".file-preview-audio audio")).toBeTruthy(),
    );
  });

  it("PDF 在页面内预览：老附件只记了 octet-stream 也按扩展名认出来，按 application/pdf 交给查看器", async () => {
    const blobs: Blob[] = [];
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(new Blob(["%PDF-1.4"], { type: "application/octet-stream" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return `blob:pdf-${blobs.length}`;
        },
        revokeObjectURL: () => {},
      }),
    );
    render(
      <MessageAttachments
        attachments={[
          file(
            "00000000-0000-4000-8000-0000000000d1",
            "old.PDF",
            "file",
            "application/octet-stream",
          ),
        ]}
        base="http://hive"
        token="t"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 old.PDF" }));
    const frame = await vi.waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>("iframe.file-preview-pdf");
      if (!element) throw new Error("no pdf frame");
      return element;
    });
    expect(frame.getAttribute("src")).toBe(`blob:pdf-${blobs.length}`);
    expect(blobs.at(-1)?.type).toBe("application/pdf");
    // 只向服务端取一次文件，不再 fetch(blob:)：生产环境 CSP 的 connect-src 不含 blob:
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://hive/api/attachments/00000000-0000-4000-8000-0000000000d1",
    ]);
  });

  it("Office 文档在页面内预览；超过大小上限的不下载，提示并给出下载", async () => {
    const book = utils.book_new();
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([
        ["城市", "温度"],
        ["上海", 18.5],
      ]),
      "天气",
    );
    const xlsx = write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(xlsx),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x" }));
    const huge = {
      ...file(
        "00000000-0000-4000-8000-0000000000e2",
        "huge.pptx",
        "file",
        "application/octet-stream",
      ),
      size: 60 * 1024 * 1024,
    };
    render(
      <MessageAttachments
        attachments={[
          file(
            "00000000-0000-4000-8000-0000000000e1",
            "weather.xlsx",
            "file",
            "application/octet-stream",
          ),
          huge,
        ]}
        base="http://hive"
        token="t"
      />,
    );
    expect(previewKind(huge)).toBe("office");
    fireEvent.click(screen.getByRole("button", { name: "预览 weather.xlsx" }));
    const dialog = await screen.findByRole("dialog", { name: "预览 weather.xlsx" });
    // 表格渲染器按需加载，机器忙时第一次可能要多等一会
    const table = await within(dialog).findByRole("table", { name: "天气" }, { timeout: 10_000 });
    expect(table.textContent).toContain("18.5");
    // 文件只取一次，交给 OfficePreview，不再按文本读
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "预览 huge.pptx" }));
    const second = await screen.findByRole("dialog", { name: "预览 huge.pptx" });
    const alert = within(second).getByRole("alert");
    expect(alert.textContent).toContain("文件超过 50.0 MB");
    expect(within(alert).getByRole("button", { name: "下载" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("HTML 默认显示渲染后的页面（sandbox iframe、不同源），可切到源码，新窗口打开会重新申请预览链接", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/preview")) {
          return new Response(
            JSON.stringify({ url: `/api/attachment-previews/tok${calls.length}` }),
          );
        }
        return new Response("<h1>Hello</h1>");
      }),
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
    const opened = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => opened);
    vi.stubGlobal("open", open);
    render(
      <MessageAttachments
        attachments={[
          file("00000000-0000-4000-8000-0000000000b1", "page.html", "text", "text/plain"),
        ]}
        base="http://hive"
        token="t"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "预览 page.html" }));
    const frame = await vi.waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>("iframe.file-preview-page");
      if (!element) throw new Error("no iframe");
      return element;
    });
    expect(frame.getAttribute("src")).toMatch(/^http:\/\/hive\/api\/attachment-previews\/tok/);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-forms allow-modals",
    );
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(calls).toContainEqual({
      url: "http://hive/api/attachments/00000000-0000-4000-8000-0000000000b1/preview",
      method: "POST",
    });

    // 切到源码：按 html 高亮的代码
    fireEvent.click(screen.getByRole("radio", { name: "源码" }));
    expect(document.querySelector("iframe.file-preview-page")).toBeNull();
    await vi.waitFor(() =>
      expect(document.querySelector(".file-preview-text code")?.textContent).toContain("<h1>"),
    );

    // 新窗口打开：同步开窗、切断 opener，再换一个新的预览链接跳过去
    const before = calls.filter((call) => call.url.endsWith("/preview")).length;
    fireEvent.click(screen.getByRole("button", { name: "新窗口打开" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(opened.opener).toBeNull();
    await vi.waitFor(() =>
      expect(opened.location.href).toMatch(/^http:\/\/hive\/api\/attachment-previews\/tok/),
    );
    expect(calls.filter((call) => call.url.endsWith("/preview")).length).toBe(before + 1);

    // 放大：铺满窗口，选择记在本机，再点还原
    const backdrop = () => document.querySelector(".file-preview-backdrop")!;
    expect(backdrop().classList.contains("maximized")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "放大预览" }));
    expect(backdrop().classList.contains("maximized")).toBe(true);
    expect(localStorage.getItem("superhive.preview-maximized")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "还原大小" }));
    expect(backdrop().classList.contains("maximized")).toBe(false);
    expect(localStorage.getItem("superhive.preview-maximized")).toBeNull();
  });
});
