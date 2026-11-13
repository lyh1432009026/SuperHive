// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerAttachments,
  MessageAttachments,
  formatBytes,
  nameForPastedFile,
  useAttachmentQueue,
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

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
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
