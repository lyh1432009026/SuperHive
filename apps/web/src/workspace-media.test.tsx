// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DownloadButton,
  MediaCompare,
  MediaView,
  WorkspaceRevealContext,
  changeSides,
  mediaKind,
  type RawUrlApi,
} from "./workspace-media";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function fakeApi(options: { inline?: boolean; fail?: string } = {}) {
  const api = vi.fn(async (_path: string, query: Record<string, string | undefined> = {}) => {
    if (options.fail) throw new Error(options.fail);
    return {
      url: `/api/rooms/general/workspace/raw?t=${query.ref ?? "worktree"}-${query.path}${query.download ? "-dl" : ""}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      size: 2048,
      contentType: "image/png",
      inline: options.inline ?? !query.download,
    };
  });
  return Object.assign(api, { base: "http://hive.test" }) as typeof api & RawUrlApi;
}

describe("mediaKind / changeSides", () => {
  it("按扩展名分出图片、视频、音频、PDF，其余不预览", () => {
    expect(mediaKind("a/logo.PNG")).toBe("image");
    expect(mediaKind("icon.svg")).toBe("image");
    expect(mediaKind("clip.mov")).toBe("video");
    expect(mediaKind("song.flac")).toBe("audio");
    expect(mediaKind("doc.pdf")).toBe("pdf");
    expect(mediaKind("page.html")).toBeUndefined();
    expect(mediaKind("Makefile")).toBeUndefined();
  });

  it("各种改动两边取哪个版本；新增只有改后、删除只有改前", () => {
    expect(changeSides({ mode: "staged" })).toEqual({ before: "HEAD", after: "index" });
    expect(changeSides({ mode: "unstaged" })).toEqual({ before: "index", after: "worktree" });
    expect(changeSides({ mode: "untracked", status: "?" })).toEqual({ after: "worktree" });
    expect(changeSides({ mode: "commit", commit: "abc1234" })).toEqual({
      before: "parent:abc1234",
      after: "abc1234",
    });
    expect(changeSides({ mode: "commit", commit: "abc1234", status: "A" })).toEqual({
      after: "abc1234",
    });
    expect(changeSides({ mode: "base", base: "main", status: "D" })).toEqual({
      before: "base:main",
    });
  });
});

describe("MediaView", () => {
  it("图片：用临时链接作 src，显示尺寸大小类型，点开用看图器", async () => {
    const api = fakeApi();
    render(<MediaView api={api} source="workspace" path="img/logo.png" />);
    const image = await screen.findByRole<HTMLImageElement>("img", { name: "logo.png" });
    expect(image.src).toBe(
      "http://hive.test/api/rooms/general/workspace/raw?t=worktree-img/logo.png",
    );
    expect(api).toHaveBeenCalledWith("/raw-url", {
      source: "workspace",
      path: "img/logo.png",
      ref: "worktree",
      reveal: undefined,
    });
    Object.defineProperty(image, "naturalWidth", { value: 640 });
    Object.defineProperty(image, "naturalHeight", { value: 480 });
    fireEvent.load(image);
    expect(screen.getByText("640 × 480 · 2.0 KB · PNG")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "放大查看 logo.png" }));
    const viewer = screen.getByRole("dialog", { name: "logo.png" });
    expect(within(viewer).getByRole<HTMLImageElement>("img").src).toBe(image.src);
  });

  it("视频、音频用原生播放器，PDF 内嵌", async () => {
    const api = fakeApi();
    const { container, rerender } = render(
      <MediaView api={api} source="workspace" path="clip.mp4" />,
    );
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    const video = container.querySelector("video")!;
    expect(video.controls).toBe(true);
    expect(video.getAttribute("src")).toContain("worktree-clip.mp4");
    rerender(<MediaView api={api} source="workspace" path="song.mp3" />);
    await waitFor(() => expect(container.querySelector("audio[controls]")).toBeTruthy());
    rerender(<MediaView api={api} source="workspace" path="doc.pdf" />);
    await waitFor(() =>
      expect(
        container.querySelector('object[type="application/pdf"]')?.getAttribute("data"),
      ).toContain("worktree-doc.pdf"),
    );
  });

  it("太大或浏览器显示不了时给下载按钮；取链接失败显示原因", async () => {
    render(<MediaView api={fakeApi({ inline: false })} source="workspace" path="huge.mp4" />);
    expect(await screen.findByText("文件太大，不在页面里显示。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
    cleanup();
    const { container } = render(<MediaView api={fakeApi()} source="workspace" path="x.png" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("浏览器无法显示这个文件。")).toBeTruthy();
    cleanup();
    render(<MediaView api={fakeApi({ fail: "预览链接已过期" })} source="workspace" path="x.png" />);
    expect((await screen.findByRole("alert")).textContent).toContain("预览链接已过期");
  });
});

describe("DownloadButton", () => {
  it("点的时候才签下载链接，按附件下载", async () => {
    const api = fakeApi();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<DownloadButton api={api} source="workspace" path="dist/app.bin" ref="HEAD" />);
    expect(api).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(api).toHaveBeenCalledWith("/raw-url", {
      source: "workspace",
      path: "dist/app.bin",
      ref: "HEAD",
      download: "1",
    });
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.href).toContain("HEAD-dist/app.bin-dl");
    expect(anchor.download).toBe("app.bin");
  });
});

describe("本机房主在访达里显示", () => {
  it("工作区当前文件直接在文件夹里显示，不签下载链接；git 里的旧版本仍然下载", async () => {
    const api = fakeApi();
    const reveal = vi.fn(async () => undefined);
    const { rerender } = render(
      <WorkspaceRevealContext.Provider value={reveal}>
        <DownloadButton api={api} source="wt-1" path="dist/app.bin" />
      </WorkspaceRevealContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /在(访达|文件夹)中显示/ }));
    expect(reveal).toHaveBeenCalledWith("wt-1", "dist/app.bin");
    expect(api).not.toHaveBeenCalled();
    rerender(
      <WorkspaceRevealContext.Provider value={reveal}>
        <DownloadButton api={api} source="wt-1" path="dist/app.bin" ref="HEAD" />
      </WorkspaceRevealContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
  });

  it("显示失败时给出原因", async () => {
    const reveal = vi.fn(async () => {
      throw new Error("文件不存在");
    });
    render(
      <WorkspaceRevealContext.Provider value={reveal}>
        <DownloadButton api={fakeApi()} source="workspace" path="a.bin" />
      </WorkspaceRevealContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /在(访达|文件夹)中显示/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("文件不存在");
  });
});

describe("MediaCompare", () => {
  it("图片改动并排显示改前改后，可切到滑动对比并记住", async () => {
    const api = fakeApi();
    render(
      <MediaCompare
        api={api}
        source="workspace"
        path="logo.png"
        oldPath="old-logo.png"
        before="HEAD"
        after="index"
      />,
    );
    expect(await screen.findByText("改前")).toBeTruthy();
    expect(screen.getByText("改后")).toBeTruthy();
    const images = await screen.findAllByRole<HTMLImageElement>("img");
    expect(images.map((image) => image.src)).toEqual([
      expect.stringContaining("HEAD-old-logo.png"),
      expect.stringContaining("index-logo.png"),
    ]);
    await userEvent.click(screen.getByRole("radio", { name: "滑动对比" }));
    expect(localStorage.getItem("superhive.workspace-image-compare")).toBe("slider");
    const slider = await screen.findByRole<HTMLInputElement>("slider", {
      name: "左边是改前，右边是改后；拖动调整分界",
    });
    fireEvent.change(slider, { target: { value: "30" } });
    const after = screen.getByRole("img", { name: "改后" }).parentElement!;
    expect(after.style.clipPath).toBe("inset(0 0 0 30%)");
  });

  it("新增的只显示改后，删除的只显示改前，不给对照切换", async () => {
    const api = fakeApi();
    const { rerender } = render(
      <MediaCompare api={api} source="workspace" path="new.png" after="worktree" />,
    );
    expect(await screen.findByText("新增")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "滑动对比" })).toBeNull();
    rerender(<MediaCompare api={api} source="workspace" path="gone.png" before="HEAD" />);
    expect(await screen.findByText("已删除")).toBeTruthy();
  });

  it("视频改动给两个播放器", async () => {
    const { container } = render(
      <MediaCompare
        api={fakeApi()}
        source="workspace"
        path="clip.webm"
        before="HEAD"
        after="worktree"
      />,
    );
    await waitFor(() => expect(container.querySelectorAll("video[controls]")).toHaveLength(2));
  });
});
