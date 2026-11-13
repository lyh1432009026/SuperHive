import { isMacPlatform, keyCombo, keyParts } from "./shortcuts";

/**
 * 快捷键的显示：每个键一个键帽（⌘ ↵ / Ctrl Enter），和快捷键帮助里的写法一致。
 * 读屏读整串（⌘↵ / Ctrl+Enter），键帽本身不重复读
 */
export function KeyCombo({ keys, className }: { keys: string[]; className?: string }) {
  const mac = isMacPlatform();
  return (
    <span
      className={`key-combo${className ? ` ${className}` : ""}`}
      aria-label={keyCombo(keys, mac)}
    >
      {keyParts(keys, mac).map((part, index) => (
        <kbd key={index} aria-hidden="true" className={part.length === 1 ? "symbol" : undefined}>
          {part}
        </kbd>
      ))}
    </span>
  );
}
