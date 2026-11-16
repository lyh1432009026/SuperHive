import type { ChildProcess } from "node:child_process";

/**
 * 本进程拉起的运行时子进程（Claude、Codex app-server、ACP……）。
 * Bridge 意外退出时这些子进程不会跟着死：例如 Claude 可能把手上这一步做完才发现输出管道断了。
 * 执行意图里记下它们的 PID，重启后还有活着的，就说明旧回合可能仍在执行，不能自动重跑。
 */
const live = new Set<number>();
const listeners = new Set<(pid: number) => void>();

export function trackRuntimeProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  live.add(pid);
  child.once("exit", () => live.delete(pid));
  child.once("error", () => live.delete(pid));
  for (const listener of listeners) listener(pid);
}

export function liveRuntimePids(): number[] {
  return [...live];
}

/** 有新的运行时子进程启动时通知；返回取消订阅的函数 */
export function onRuntimeSpawn(listener: (pid: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 这些进程里还有没退出的吗（PID 被系统复用时也会算作活着：宁可交给人，也不重复执行） */
export function anyProcessAlive(pids: readonly number[]): boolean {
  return pids.some((pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
}
