import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { isAlias, isCollection, isNode, isScalar, parseDocument, visit, type YAMLMap } from "yaml";

/**
 * 按格式就地改配置文件里的一个字符串值：只动目标那一处，注释、顺序、缩进和其他键原样保留。
 * 认不出或改不安全的写法一律抛错（调用方当作「只读，请手动修改」），绝不整份重写。
 */

/* ---------- TOML：只按行处理需要的几项，其余原样保留（注释、顺序、格式都不动） ---------- */

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** 解析点分键（a.b."c.d"）；认不出时返回 undefined */
export function parseDottedKey(source: string): string[] | undefined {
  const parts: string[] = [];
  let rest = source.trim();
  for (;;) {
    let part: string | undefined;
    if (rest.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (!match) return undefined;
      try {
        part = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return undefined;
      }
      rest = rest.slice(match[0].length);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) return undefined;
      part = rest.slice(1, end);
      rest = rest.slice(end + 1);
    } else {
      const match = BARE_KEY.exec(rest);
      if (!match) return undefined;
      part = match[0];
      rest = rest.slice(match[0].length);
    }
    parts.push(part);
    rest = rest.trimStart();
    if (!rest) return parts;
    if (!rest.startsWith(".")) return undefined;
    rest = rest.slice(1).trimStart();
  }
}

export type TomlString = { value: string; end: number } | "complex";

/** 读一行里键后面的字符串值；多行字符串、数组、内联表等返回 complex */
function parseTomlString(source: string, start: number): TomlString {
  const rest = source.slice(start);
  if (rest.startsWith('"""') || rest.startsWith("'''")) return "complex";
  if (rest.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (!match) return "complex";
    try {
      return { value: JSON.parse(`"${match[1]}"`) as string, end: start + match[0].length };
    } catch {
      return "complex";
    }
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end < 0) return "complex";
    return { value: rest.slice(1, end), end: start + end + 1 };
  }
  return "complex";
}

type TomlEntry = { line: number; value: TomlString; prefixEnd: number };
export type TomlTable = { header: number; end: number; entries: Map<string, TomlEntry> };

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
const KEY_LINE =
  /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=\s*/;

/** 按表头分段；root 用空字符串。[[数组表]] 和认不出的表头不收，里面的键也不算 */
export function scanToml(content: string): Map<string, TomlTable> {
  const lines = content.split("\n");
  const tables = new Map<string, TomlTable>();
  let current: TomlTable | undefined = { header: -1, end: lines.length, entries: new Map() };
  tables.set("", current);
  let multiline: string | undefined;
  lines.forEach((line, index) => {
    if (multiline) {
      if (line.includes(multiline)) multiline = undefined;
      return;
    }
    if (/^\s*\[\[/.test(line)) {
      if (current) current.end = index;
      current = undefined;
      return;
    }
    const header = HEADER.exec(line);
    if (header) {
      if (current) current.end = index;
      const keys = parseDottedKey(header[1]!);
      current = keys ? { header: index, end: lines.length, entries: new Map() } : undefined;
      if (current && keys) tables.set(JSON.stringify(keys), current);
      return;
    }
    const key = KEY_LINE.exec(line);
    if (!key) return;
    const value = parseTomlString(line, key[0].length);
    const triple = /^("""|''')/.exec(line.slice(key[0].length))?.[1];
    if (triple && !line.slice(key[0].length + 3).includes(triple)) multiline = triple;
    const keys = parseDottedKey(key[2]!);
    if (current && keys) {
      current.entries.set(JSON.stringify(keys), { line: index, value, prefixEnd: key[0].length });
    }
  });
  return tables;
}

export function tomlKey(keys: string[]): string {
  return JSON.stringify(keys);
}

function tomlQuote(value: string): string {
  return JSON.stringify(value);
}

/** 把表 table 里的 key 设成字符串 value：已有就替换那一行的值（保留行尾注释），没有就加在小节末尾 */
export function setTomlString(
  content: string,
  table: string[],
  key: string,
  value: string,
): string {
  const tables = scanToml(content);
  const section = tables.get(table.length ? tomlKey(table) : "");
  if (!section) throw new Error("table not found");
  const lines = content.split("\n");
  const entry = section.entries.get(tomlKey([key]));
  if (entry) {
    if (entry.value === "complex") throw new Error("complex value");
    const line = lines[entry.line]!;
    lines[entry.line] =
      `${line.slice(0, entry.prefixEnd)}${tomlQuote(value)}${line.slice(entry.value.end)}`;
    return lines.join("\n");
  }
  // 插在小节最后一个非空行后面
  let at = section.end;
  while (at - 1 > section.header && !lines[at - 1]!.trim()) at -= 1;
  lines.splice(
    at,
    0,
    `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlQuote(key)} = ${tomlQuote(value)}`,
  );
  return lines.join("\n");
}

export function tomlValue(
  tables: Map<string, TomlTable>,
  table: string[],
  key: string,
): TomlString | undefined {
  return tables.get(table.length ? tomlKey(table) : "")?.entries.get(tomlKey([key]))?.value;
}

/* ---------- JSON / JSONC：jsonc-parser 只改目标路径，注释和其余格式不动 ---------- */

export type JsonPath = Array<string | number>;

/** 解析 JSON / JSONC（允许注释和尾逗号）；有语法错误（例如 JSON5 的不带引号的键）时返回 undefined */
export function parseJsonc(content: string): unknown {
  if (!content.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length ? undefined : value;
}

/** 原文件的缩进：用第一处缩进的空白，没有就两个空格 */
function indentOf(content: string): { insertSpaces: boolean; tabSize: number } {
  const indent = /\n([ \t]+)\S/.exec(content)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: indent?.length ?? 2 };
}

/** 把 path 处的值设成字符串 value；中间缺的对象会建出来 */
export function setJsoncString(content: string, path: JsonPath, value: string): string {
  const base = content.trim() ? content : "{}\n";
  if (parseJsonc(base) === undefined) throw new Error("invalid JSON");
  const edits = modify(base, path, value, { formattingOptions: { ...indentOf(base), eol: "\n" } });
  const next = applyEdits(base, edits);
  // 改完再读一遍：目标处确实是新值，否则不写
  let current: unknown = parseJsonc(next);
  for (const key of path) {
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string | number, unknown>)[key]
        : undefined;
  }
  if (current !== value) throw new Error("edit not applied");
  return next;
}

/* ---------- YAML（omp 的 models.yml）：按节点的源码位置替换，改完重新解析核对 ---------- */

/** 有锚点、别名、显式标签或 flow 写法（{a: b}、[a]）的文档不改：按行改容易把引用关系改坏 */
export function yamlUnsafe(content: string): boolean {
  const document = parseDocument(content, { keepSourceTokens: true });
  if (document.errors.length) return true;
  let unsafe = false;
  visit(document, {
    Alias() {
      unsafe = true;
      return visit.BREAK;
    },
    Node(_, node) {
      if (node.anchor || node.tag || (isCollection(node) && node.flow)) {
        unsafe = true;
        return visit.BREAK;
      }
      return undefined;
    },
    Pair(_, pair) {
      // 合并键 <<:
      if (isScalar(pair.key) && pair.key.value === "<<") {
        unsafe = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return unsafe;
}

export function parseYaml(content: string): unknown {
  const document = parseDocument(content);
  if (document.errors.length) return undefined;
  return document.toJS() ?? {};
}

/**
 * 把 path（全是映射键）处的值设成字符串 value：已有就替换那个标量的源码，
 * 没有就在它所在映射的最后一项后面加一行。改完重新解析，除这一处外内容必须完全一样。
 */
export function setYamlString(content: string, path: string[], value: string): string {
  if (yamlUnsafe(content)) throw new Error("unsafe YAML");
  const document = parseDocument(content);
  const quoted = JSON.stringify(value);
  const key = path.at(-1)!;
  const parent = path.length > 1 ? document.getIn(path.slice(0, -1), true) : document.contents;
  if (!isNode(parent) || isAlias(parent) || !("items" in parent)) throw new Error("no mapping");
  const map = parent as YAMLMap;
  const existing = map.get(key, true);
  let next: string;
  if (existing !== undefined) {
    if (!isScalar(existing) || !existing.range) throw new Error("not a scalar");
    // 块标量（| >）跨多行，替换容易改坏
    if (existing.type === "BLOCK_LITERAL" || existing.type === "BLOCK_FOLDED") {
      throw new Error("block scalar");
    }
    const [start, end] = existing.range;
    next = `${content.slice(0, start)}${quoted}${content.slice(end)}`;
  } else {
    const last = map.items.at(-1);
    const firstKey = map.items[0]?.key;
    if (!last || !isNode(firstKey) || !firstKey.range) throw new Error("empty mapping");
    const lineStart = content.lastIndexOf("\n", firstKey.range[0] - 1) + 1;
    const indent = content.slice(lineStart, firstKey.range[0]);
    if (indent.trim()) throw new Error("unexpected layout");
    const lastNode = isNode(last.value) ? last.value : last.key;
    const after = isNode(lastNode) && lastNode.range ? lastNode.range[1] : -1;
    if (after < 0) throw new Error("unexpected layout");
    const lineEnd = content[after - 1] === "\n" ? after - 1 : content.indexOf("\n", after);
    const line = `${indent}${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}: ${quoted}`;
    next =
      lineEnd < 0
        ? `${content}\n${line}\n`
        : `${content.slice(0, lineEnd + 1)}${line}\n${content.slice(lineEnd + 1)}`;
  }
  const expected = parseYaml(content) as Record<string, unknown>;
  let target = expected;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[key] = value;
  if (JSON.stringify(parseYaml(next)) !== JSON.stringify(expected))
    throw new Error("edit mismatch");
  return next;
}
