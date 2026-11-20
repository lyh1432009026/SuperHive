// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";
import { OFFICE_PREVIEW_LIMIT, OfficePreviewError } from "./office-kind";
import { OfficePreview } from "./office-preview";

/** 懒加载的渲染模块被真正加载过没有：工厂函数只在第一次 import 时执行 */
const loaded = vi.hoisted(() => ({ docx: false, pptx: false }));
const renderDocx = vi.hoisted(() => vi.fn());
const renderPptx = vi.hoisted(() => vi.fn());
vi.mock("./docx-render", () => {
  loaded.docx = true;
  return { renderDocx };
});
vi.mock("./pptx-render", () => {
  loaded.pptx = true;
  return { renderPptx, SLIDE_RENDER_WIDTH: 960 };
});

// jsdom 没有布局：给容器一个宽高，缩放和是否显示缩略图才算得出来
const sizes = { width: 960, height: 600 };
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => sizes.width,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => sizes.height,
  });
});
afterAll(() => {
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
});
afterEach(() => {
  cleanup();
  renderDocx.mockReset();
  renderPptx.mockReset();
});

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const download = <button type="button">下载</button>;

function xlsx() {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ["门店", "销量"],
      ["静安店", 42],
    ]),
    "明细",
  );
  utils.book_append_sheet(book, utils.aoa_to_sheet([["合计", 42]]), "汇总");
  return new Blob([write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer]);
}

describe("OfficePreview 各格式", () => {
  it("表格：按需加载，工作表用 tab 切换，表头带列名", async () => {
    render(<OfficePreview name="销售.xlsx" source="x" load={async () => xlsx()} />);
    const table = await screen.findByRole("table", { name: "明细" }, { timeout: 5000 });
    expect(within(table).getByRole("columnheader", { name: "A" })).toBeTruthy();
    expect(table.textContent).toContain("静安店");
    fireEvent.click(screen.getByRole("tab", { name: "汇总" }));
    expect((await screen.findByRole("table", { name: "汇总" })).textContent).toContain("合计");
    // 打开表格不会加载 Word / PowerPoint 的渲染库
    expect(loaded.docx).toBe(false);
    expect(loaded.pptx).toBe(false);
  });

  it("CSV：同一个表格视图", async () => {
    render(
      <OfficePreview
        name="w.csv"
        source="c"
        load={async () => new Blob(["城市,温度\n上海,18.5\n"])}
      />,
    );
    const table = await screen.findByRole("table", { name: "Sheet1" }, { timeout: 5000 });
    expect(table.textContent).toContain("18.5");
  });

  it("Word：放进无脚本、无网络的 iframe，显示页数和缩放", async () => {
    renderDocx.mockResolvedValue({ body: "<p>正文</p>", pageWidth: 2000, pages: 3 });
    render(<OfficePreview name="报告.docx" source="d" load={async () => ZIP.buffer} />);
    const frame = await screen.findByTitle<HTMLIFrameElement>("报告.docx", {}, { timeout: 5000 });
    expect(loaded.docx).toBe(true);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<p>正文</p>");
    expect(doc).toContain("html{zoom:0.45}");
    expect(screen.getByText(/共 3 页 · 45%/)).toBeTruthy();
  });

  it("PowerPoint：逐页显示，按钮、方向键翻页，宽时有缩略图，可全屏", async () => {
    renderPptx.mockResolvedValue(
      [1, 2, 3].map((index) => ({ body: `<div>第${index}页</div>`, width: 960, height: 540 })),
    );
    render(<OfficePreview name="方案.pptx" source="p" load={async () => ZIP.buffer} />);
    const region = await screen.findByRole("region", { name: "方案.pptx" }, { timeout: 5000 });
    expect(loaded.pptx).toBe(true);
    expect(region.textContent).toContain("1 / 3");
    // 幻灯片区出现后，舞台和缩略图还要等量完容器宽度的下一次渲染才有，负载高时会晚一拍
    await within(region).findByTitle("方案.pptx 第 1 页", {}, { timeout: 5000 });
    const thumbs = await within(region).findByRole("navigation", { name: "幻灯片缩略图" });
    const stage = () =>
      region.querySelector<HTMLIFrameElement>(".office-pptx-stage iframe")!.getAttribute("srcdoc")!;
    expect(stage()).toContain("第1页");
    fireEvent.click(within(region).getByRole("button", { name: "下一页" }));
    expect(region.textContent).toContain("2 / 3");
    expect(stage()).toContain("第2页");
    fireEvent.keyDown(region, { key: "End" });
    expect(region.textContent).toContain("3 / 3");
    expect(within(region).getByRole<HTMLButtonElement>("button", { name: "下一页" }).disabled).toBe(
      true,
    );
    fireEvent.click(within(thumbs).getByRole("button", { name: "第 1 页" }));
    expect(region.textContent).toContain("1 / 3");
    for (const frame of region.querySelectorAll("iframe"))
      expect(frame.getAttribute("sandbox")).toBe("");

    const requestFullscreen = vi.fn(async () => undefined);
    Object.assign(HTMLElement.prototype, { requestFullscreen });
    cleanup();
    render(<OfficePreview name="方案.pptx" source="p2" load={async () => ZIP.buffer} />);
    fireEvent.click(await screen.findByRole("button", { name: "全屏放映" }, { timeout: 5000 }));
    expect(requestFullscreen).toHaveBeenCalled();
  });

  it("窄的时候不放缩略图", async () => {
    sizes.width = 400;
    try {
      renderPptx.mockResolvedValue([
        { body: "<div>a</div>", width: 960, height: 540 },
        { body: "<div>b</div>", width: 960, height: 540 },
      ]);
      render(<OfficePreview name="窄.pptx" source="n" load={async () => ZIP.buffer} />);
      const region = await screen.findByRole("region", { name: "窄.pptx" }, { timeout: 5000 });
      // 等量完宽度、舞台出来以后再断言，免得在量之前就判定「没有缩略图」
      await within(region).findByTitle("窄.pptx 第 1 页", {}, { timeout: 5000 });
      expect(screen.queryByRole("navigation", { name: "幻灯片缩略图" })).toBeNull();
    } finally {
      sizes.width = 960;
    }
  });

  it("换一个文件重新读", async () => {
    const load = vi.fn(async () => xlsx());
    const { rerender } = render(<OfficePreview name="a.xlsx" source="v1" load={load} />);
    await screen.findByRole("table", { name: "明细" }, { timeout: 5000 });
    rerender(<OfficePreview name="a.xlsx" source="v1" load={load} />);
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<OfficePreview name="a.xlsx" source="v2" load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe("OfficePreview 出错的几种情况", () => {
  it("已知超过上限：不去下载，提示并给出下载按钮", () => {
    const load = vi.fn();
    render(
      <OfficePreview
        name="巨大.xlsx"
        size={OFFICE_PREVIEW_LIMIT + 1}
        source="a"
        load={load}
        download={download}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("文件超过 50.0 MB，不在页面里预览。");
    expect(within(alert).getByRole("button", { name: "下载" })).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  it("下载下来才发现超限也拦住", async () => {
    const big = { size: OFFICE_PREVIEW_LIMIT + 1 } as Blob;
    Object.setPrototypeOf(big, Blob.prototype);
    render(<OfficePreview name="a.docx" source="a" load={async () => big} />);
    expect((await screen.findByRole("alert")).textContent).toContain("文件超过");
  });

  it("加密文件（OLE 外壳）提示加密", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    render(<OfficePreview name="机密.pptx" source="a" load={async () => ole.buffer} />);
    expect((await screen.findByRole("alert")).textContent).toContain("文件设了打开密码或已加密");
    expect(renderPptx).not.toHaveBeenCalled();
  });

  it("内容和扩展名对不上", async () => {
    render(
      <OfficePreview
        name="假的.docx"
        source="a"
        load={async () => new Blob(["<html>not a docx</html>"])}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("文件内容和扩展名对不上");
  });

  it("读取失败和渲染失败都落到「无法解析」并带原因", async () => {
    render(
      <OfficePreview
        name="a.xlsx"
        source="a"
        load={async () => {
          throw new Error("网络断了");
        }}
        download={download}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法解析这个文件");
    expect(alert.textContent).toContain("网络断了");
    cleanup();

    renderDocx.mockRejectedValue(new OfficePreviewError("failed", "坏掉的 document.xml"));
    render(<OfficePreview name="坏.docx" source="b" load={async () => ZIP.buffer} />);
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
      "坏掉的 document.xml",
    );
  });
});
