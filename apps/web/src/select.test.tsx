// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./select";

afterEach(cleanup);

const options: SelectOption[] = [
  { value: "", label: "不设置" },
  { value: "alpha", label: "alpha", group: "Agent" },
  { value: "beta", label: "beta", group: "Agent", disabled: true },
  { value: "bravo", label: "bravo", group: "Agent", description: "说明文字" },
  { value: "charlie", label: "charlie", group: "Agent" },
];

function Harness({ onChange = () => undefined }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <label>
        <span>主 Agent</span>
        <Select
          value={value}
          options={options}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      </label>
      <button type="button">后面的按钮</button>
    </>
  );
}

const trigger = () => screen.getByRole("combobox", { name: /主 Agent/ });
const activeLabel = () => {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : undefined;
};

describe("Select", () => {
  it("读屏能读出名称和当前值；点开后列出选项、分组、当前项打勾", () => {
    render(<Harness />);
    expect(trigger().textContent).toContain("不设置");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(list.textContent).toContain("Agent");
    expect(list.textContent).toContain("说明文字");
    expect(screen.getByRole("option", { name: "不设置" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("option", { name: /bravo/ }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toContain("bravo");
    expect(document.activeElement).toBe(trigger());
  });

  it("键盘：↓ 打开、↑↓ 跳过禁用项、Home/End、Enter 选中、首字母跳转", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(activeLabel()).toBe("不设置");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    // beta 是禁用的，直接跳到 bravo
    expect(activeLabel()).toContain("bravo");
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(activeLabel()).toBe("charlie");
    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(activeLabel()).toBe("不设置");
    fireEvent.keyDown(trigger(), { key: "c" });
    expect(activeLabel()).toBe("charlie");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("charlie");
    expect(screen.queryByRole("listbox")).toBeNull();
    // 关着的时候打字直接改值，和原生 select 一样
    fireEvent.keyDown(trigger(), { key: "a" });
    expect(onChange).toHaveBeenLastCalledWith("alpha");
  });

  it("Esc 关闭不改值、焦点留在触发框；点禁用项没反应；Tab 关闭", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: " " });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(trigger(), { key: "Escape" });
    window.removeEventListener("keydown", windowEsc);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
    // Esc 只收起下拉，不会冒泡到外面去关掉整个弹窗
    expect(windowEsc).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "beta" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(trigger(), { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("禁用时打不开", () => {
    render(
      <Select
        aria-label="运行时"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onChange={() => undefined}
        disabled
      />,
    );
    const button = screen.getByRole("combobox", { name: "运行时" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
