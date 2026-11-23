import { readFileSync, writeFileSync } from "node:fs";

export type Bounds = { x: number; y: number; width: number; height: number };
export type WindowState = Bounds & { maximized?: boolean; fullScreen?: boolean };

export const DEFAULT_SIZE = { width: 1280, height: 820 };
export const MIN_SIZE = { width: 720, height: 480 };

export function loadWindowState(file: string): WindowState | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
    if (
      ![value.x, value.y, value.width, value.height].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      )
    ) {
      return undefined;
    }
    return value as WindowState;
  } catch {
    return undefined;
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {
    /* 存不下来不影响使用 */
  }
}

function overlapArea(a: Bounds, b: Bounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * 恢复上次的位置大小：拔掉外接显示器、换了分辨率后，窗口不能落在看不见的地方。
 * 和任一屏幕的工作区重叠不到 1/4 就放回主屏居中；比工作区大就缩到工作区以内。
 */
export function restoreBounds(
  saved: WindowState | undefined,
  workAreas: Bounds[],
): Partial<WindowState> {
  if (!saved || workAreas.length === 0) return { ...DEFAULT_SIZE };
  const width = Math.max(MIN_SIZE.width, saved.width);
  const height = Math.max(MIN_SIZE.height, saved.height);
  const candidate = { x: saved.x, y: saved.y, width, height };
  const best = workAreas
    .map((area) => ({ area, overlap: overlapArea(candidate, area) }))
    .sort((a, b) => b.overlap - a.overlap)[0]!;
  if (best.overlap < (width * height) / 4) {
    const area = workAreas[0]!;
    const w = Math.min(width, area.width);
    const h = Math.min(height, area.height);
    return {
      width: w,
      height: h,
      x: Math.round(area.x + (area.width - w) / 2),
      y: Math.round(area.y + (area.height - h) / 2),
      ...(saved.maximized ? { maximized: true } : {}),
    };
  }
  const area = best.area;
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return {
    width: w,
    height: h,
    x: Math.min(Math.max(candidate.x, area.x), area.x + area.width - w),
    y: Math.min(Math.max(candidate.y, area.y), area.y + area.height - h),
    ...(saved.maximized ? { maximized: true } : {}),
  };
}
