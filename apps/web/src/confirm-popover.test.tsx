// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmPopover } from "./confirm-popover";

afterEach(cleanup);

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>
        危险操作
      </button>
      <button type="button">别处</button>
      {open && (
        <ConfirmPopover
          ariaLabel="确认危险操作"
          message="确定吗？"
          confirmLabel="确认"
          cancelLabel="取消"
          anchorRef={anchorRef}
          onConfirm={() => {
            onConfirm();
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

describe("ConfirmPopover", () => {
  it("opens over the anchor without touching layout, focuses confirm, and closes on Esc or outside click", () => {
    const onConfirm = vi.fn();
    const { container } = render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "危险操作" }));
    const popover = screen.getByRole("dialog", { name: "确认危险操作" });
    // 渲染到 body，不插进锚点所在的布局里，不会推动页面
    expect(container.contains(popover)).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确认" }));

    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "危险操作" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "别处" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "危险操作" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
