import { useEffect, useState } from "react";

/** 当前界面主题下某个 CSS 变量的值；切换明暗主题时跟着变（iframe 里用不了页面的变量，只能传值进去） */
export function useThemeValue(name: string, fallback: string): string {
  const read = () => {
    if (typeof document === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, [name, fallback]);
  return value;
}

/** 量容器宽高：缩放文档和幻灯片要跟着面板宽度走 */
export function useElementSize<T extends HTMLElement>(): [
  (element: T | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
