// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "./app-dialog";

afterEach(cleanup);

const srcDir = import.meta.dirname;
const stylesDir = path.join(srcDir, "styles");

function cssRules(css: string) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.replace(/\s+/g, " ").trim(),
    body: match[2]!,
  }));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

describe("AppDialog 内容区内边距只由外壳给", () => {
  // 外壳的内容区，以及各面板通过 bodyClassName 加在内容区上的类
  const bodyClasses = new Set(["app-dialog-body"]);
  for (const file of sourceFiles(srcDir)) {
    for (const match of readFileSync(file, "utf8").matchAll(/bodyClassName="([^"]+)"/g))
      for (const name of match[1]!.split(/\s+/)) bodyClasses.add(name);
  }

  const offenders = (predicate: (rule: { selector: string; body: string }) => boolean) =>
    readdirSync(stylesDir)
      .filter((name) => name.endsWith(".css") && name !== "app-dialog.css")
      .flatMap((name) =>
        cssRules(readFileSync(path.join(stylesDir, name), "utf8"))
          .filter(predicate)
          .map((rule) => `${name}: ${rule.selector}`),
      );

  it("找得到用了外壳的面板的内容区类名", () => {
    expect([...bodyClasses]).toEqual(
      expect.arrayContaining(["schedules-dialog-body", "incidents-dialog-body"]),
    );
  });

  it("别的样式表不改弹窗内容区的左右内边距（只能改上下）", () => {
    const horizontalPadding =
      /(^|[;\s])padding(-left|-right|-inline|-inline-start|-inline-end)?\s*:/;
    const found = offenders(
      (rule) =>
        [...bodyClasses].some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector)) &&
        horizontalPadding.test(rule.body),
    );
    expect(found).toEqual([]);
  });

  it("别的样式表不改外壳的内边距变量", () => {
    expect(offenders((rule) => /--dialog-inset\s*:/.test(rule.body))).toEqual([]);
  });

  it("面板都通过 AppDialog 用外壳，不手写外壳的结构", () => {
    const handWritten = sourceFiles(srcDir)
      .filter((file) => path.basename(file) !== "app-dialog.tsx")
      .filter((file) =>
        /className=\{?["`][^"`]*\b(app-dialog(-layer|-body|-header|-scrim)?|activity-(layer|panel|body))\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(srcDir, file));
    expect(handWritten).toEqual([]);
  });
});

function Harness({
  onClose,
  onKeyDown,
}: {
  onClose?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {open && (
        <AppDialog
          size="lg"
          title="定时任务"
          tools={<button type="button">筛选</button>}
          footer={<input ref={inputRef} aria-label="底部输入" />}
          {...(onKeyDown ? { onKeyDown } : {})}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <p>内容</p>
        </AppDialog>
      )}
    </>
  );
}

describe("AppDialog", () => {
  it("居中模态弹窗：标题作名称、按尺寸档加类名，打开时聚焦弹窗，关闭后焦点回到入口", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "定时任务" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.classList.contains("lg")).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.querySelector(".app-dialog-body")?.textContent).toBe("内容");
    expect(dialog.querySelector(".app-dialog-footer")).not.toBeNull();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("点遮罩或关闭按钮都会关", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const [scrim] = screen.getAllByRole("button", { name: "关闭" });
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.querySelector(".app-dialog-close")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Tab 在弹窗里循环", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "筛选" });
    const last = screen.getByRole("textbox", { name: "底部输入" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("面板自己处理了按键（preventDefault）或输入法正在选字时，Esc 不关弹窗", () => {
    const onClose = vi.fn();
    render(
      <Harness
        onClose={onClose}
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.shiftKey) event.preventDefault();
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape", shiftKey: true });
    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
