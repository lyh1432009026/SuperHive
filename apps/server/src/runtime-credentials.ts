import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  serverText,
  zhText,
  type RuntimeCredentialField,
  type RuntimeCredentialFieldInfo,
  type RuntimeCredentialProvider,
  type RuntimeCredentials,
  type ServerText,
  type UpdateRuntimeCredentialsRequest,
} from "@superhive/protocol";
import { HiveError } from "./database.js";

/**
 * 运行时（Claude Code、Codex）的接口地址和密钥，直接读写 CLI 自己的全局配置：
 * - Claude Code：$CLAUDE_CONFIG_DIR/settings.json（默认 ~/.claude）的 env.ANTHROPIC_BASE_URL、
 *   env.ANTHROPIC_AUTH_TOKEN（已有 ANTHROPIC_API_KEY 时改它）；
 * - Codex：$CODEX_HOME/config.toml（默认 ~/.codex）里当前 model_provider 小节的 base_url、
 *   experimental_bearer_token；用内置 OpenAI 或 requires_openai_auth 时密钥在 auth.json 的 OPENAI_API_KEY。
 * 终端里的 CLI 读的是同一份文件，所以会一起变。
 *
 * 写之前把原文件备份到同目录（权限 600，只留最近几份），写临时文件 fsync 后改名替换，保持原文件权限；
 * 一次要改两个文件时，后一个失败就把前一个还原。值只经这里读写，不进日志和错误信息。
 */

export type RuntimeCredentialsOptions = {
  home?: string;
  /** 默认 $CLAUDE_CONFIG_DIR 或 ~/.claude */
  claudeDir?: string;
  /** 默认 $CODEX_HOME 或 ~/.codex */
  codexHome?: string;
  now?: () => number;
  /** 测试注入：模拟写入中途失败 */
  writeFile?: (fd: number, content: string) => void;
};

const BACKUP_KEEP = 5;
const BACKUP_TAG = ".superhive-bak-";

type Located = {
  info: RuntimeCredentialFieldInfo;
  value: string | undefined;
  /** 改这一项要动的文件和改法；undefined 表示不能改 */
  edit?: { file: string; apply: (content: string, value: string) => string };
};

type Snapshot = { files: string[]; baseUrl: Located; apiKey: Located };

/** 打码：密钥只露头尾各 4 位；地址只露协议、主机名开头和结尾 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(Math.max(value.length, 4));
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.host;
    const shown =
      host.length <= 8 ? `${host.slice(0, 2)}••••` : `${host.slice(0, 4)}••••${host.slice(-4)}`;
    return `${url.protocol}//${shown}${url.pathname !== "/" || url.search ? "/…" : ""}`;
  } catch {
    return maskSecret(value);
  }
}

function fieldInfo(
  field: RuntimeCredentialField,
  value: string | undefined,
  location: string,
  editable: boolean,
  note?: ServerText,
): RuntimeCredentialFieldInfo {
  return {
    set: Boolean(value),
    masked: value ? (field === "baseUrl" ? maskUrl(value) : maskSecret(value)) : null,
    editable,
    location,
    ...(note ? { note: zhText(note), noteText: note } : {}),
  };
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function unreadable(file: string, reason: string): HiveError {
  return new HiveError(
    "RUNTIME_CREDENTIALS_UNREADABLE",
    serverText("error.runtimeCredentials.unreadable", { file, reason }),
  );
}

function readJson(file: string, display: string): Record<string, unknown> {
  const text = readText(file);
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // 不把解析错误原文带出去：里面可能有值的片段
    throw unreadable(display, "JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unreadable(display, "JSON");
  }
  return value as Record<string, unknown>;
}

/** JSON 文件按原缩进写回：只改 path 指到的那个字符串 */
function setJson(content: string, keys: string[], value: string): string {
  const data = content.trim() ? (JSON.parse(content) as Record<string, unknown>) : {};
  let target = data;
  for (const key of keys.slice(0, -1)) {
    const next = target[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
  const indent = /^\{\s*\n([ \t]+)"/.exec(content)?.[1] ?? "  ";
  return `${JSON.stringify(data, null, indent)}\n`;
}

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

type TomlString = { value: string; end: number } | "complex";

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
type TomlTable = { header: number; end: number; entries: Map<string, TomlEntry> };

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
const KEY_LINE =
  /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=\s*/;

/** 按表头分段；root 用空字符串。[[数组表]] 和认不出的表头不收，里面的键也不算 */
function scanToml(content: string): Map<string, TomlTable> {
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

function tomlKey(keys: string[]): string {
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

function tomlValue(
  tables: Map<string, TomlTable>,
  table: string[],
  key: string,
): TomlString | undefined {
  return tables.get(table.length ? tomlKey(table) : "")?.entries.get(tomlKey([key]))?.value;
}

/* ---------- 文件写入 ---------- */

type Write = { file: string; content: string };

export class RuntimeCredentialStore {
  private readonly home: string;
  private readonly claudeDir: string;
  private readonly codexHome: string;
  private readonly now: () => number;
  private readonly writeContent: (fd: number, content: string) => void;

  constructor(options: RuntimeCredentialsOptions = {}) {
    this.home = options.home ?? homedir();
    this.claudeDir =
      options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(this.home, ".claude");
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(this.home, ".codex");
    this.now = options.now ?? Date.now;
    this.writeContent = options.writeFile ?? ((fd, content) => writeSync(fd, content));
  }

  private display(file: string): string {
    return file.startsWith(this.home + path.sep) ? `~${file.slice(this.home.length)}` : file;
  }

  list(): RuntimeCredentials[] {
    return (["claude", "codex"] as const).map((provider) => this.get(provider));
  }

  get(provider: RuntimeCredentialProvider): RuntimeCredentials {
    const snapshot = this.snapshot(provider);
    return {
      provider,
      files: snapshot.files,
      baseUrl: snapshot.baseUrl.info,
      apiKey: snapshot.apiKey.info,
    };
  }

  /** 完整值：只在本机房主确认后调用 */
  reveal(provider: RuntimeCredentialProvider, field: RuntimeCredentialField): string | null {
    return this.snapshot(provider)[field].value ?? null;
  }

  update(
    provider: RuntimeCredentialProvider,
    input: UpdateRuntimeCredentialsRequest,
  ): RuntimeCredentials {
    const fields = (["baseUrl", "apiKey"] as const).filter((field) => input[field] !== undefined);
    // 按文件合并：同一个文件改两项只写一次
    const pending = new Map<string, string>();
    for (const field of fields) {
      const located = this.snapshot(provider, pending)[field];
      if (!located.edit) {
        const reason = located.info.noteText ?? serverText("runtimeCredentials.note.complex");
        throw new HiveError(
          "RUNTIME_CREDENTIALS_NOT_EDITABLE",
          serverText("error.runtimeCredentials.notEditable", { field, reason }),
        );
      }
      const { file, apply } = located.edit;
      const current = pending.get(file) ?? readText(file) ?? "";
      let next: string;
      try {
        next = apply(current, input[field]!);
      } catch {
        throw unreadable(this.display(file), "TOML");
      }
      pending.set(file, next);
    }
    this.commit([...pending].map(([file, content]) => ({ file, content })));
    return this.get(provider);
  }

  private snapshot(provider: RuntimeCredentialProvider, pending?: Map<string, string>): Snapshot {
    return provider === "claude" ? this.claude(pending) : this.codex(pending);
  }

  private claude(pending?: Map<string, string>): Snapshot {
    const file = path.join(this.claudeDir, "settings.json");
    const display = this.display(file);
    const text = pending?.get(file);
    const data =
      text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : readJson(file, display);
    const env =
      typeof data.env === "object" && data.env !== null && !Array.isArray(data.env)
        ? (data.env as Record<string, unknown>)
        : {};
    const str = (key: string) => (typeof env[key] === "string" ? (env[key] as string) : undefined);
    // 已经在用 ANTHROPIC_API_KEY 就改它；否则用 ANTHROPIC_AUTH_TOKEN（Bearer，不会在启动时再问一次是否信任这个 key）
    const keyName =
      str("ANTHROPIC_API_KEY") && !str("ANTHROPIC_AUTH_TOKEN")
        ? "ANTHROPIC_API_KEY"
        : "ANTHROPIC_AUTH_TOKEN";
    const located = (field: RuntimeCredentialField, name: string): Located => ({
      info: fieldInfo(field, str(name), `${display} → env.${name}`, true),
      value: str(name),
      edit: { file, apply: (content, value) => setJson(content, ["env", name], value) },
    });
    return {
      files: [display],
      baseUrl: located("baseUrl", "ANTHROPIC_BASE_URL"),
      apiKey: located("apiKey", keyName),
    };
  }

  private codex(pending?: Map<string, string>): Snapshot {
    const configFile = path.join(this.codexHome, "config.toml");
    const authFile = path.join(this.codexHome, "auth.json");
    const configDisplay = this.display(configFile);
    const authDisplay = this.display(authFile);
    const tables = scanToml(pending?.get(configFile) ?? readText(configFile) ?? "");
    const providerValue = tomlValue(tables, [], "model_provider");
    const complex = serverText("runtimeCredentials.note.complex");
    const readOnly = (
      field: RuntimeCredentialField,
      location: string,
      note: ServerText,
      value?: string,
    ): Located => ({ info: fieldInfo(field, value, location, false, note), value });

    const authJson = (): Located => {
      const authText = pending?.get(authFile);
      const auth =
        authText !== undefined
          ? (JSON.parse(authText) as Record<string, unknown>)
          : readJson(authFile, authDisplay);
      const value = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : undefined;
      const location = `${authDisplay} → OPENAI_API_KEY`;
      // 用 ChatGPT 账号登录（有 tokens 没有 key）时不往里塞 key，免得改掉登录方式
      if (!value && auth.tokens) {
        return readOnly("apiKey", location, serverText("runtimeCredentials.note.chatgpt"));
      }
      return {
        info: fieldInfo("apiKey", value, location, true),
        value,
        edit: {
          file: authFile,
          apply: (content, next) => setJson(content, ["OPENAI_API_KEY"], next),
        },
      };
    };

    if (providerValue === "complex") {
      return {
        files: [configDisplay],
        baseUrl: readOnly("baseUrl", `${configDisplay} → model_provider`, complex),
        apiKey: readOnly("apiKey", `${configDisplay} → model_provider`, complex),
      };
    }
    const id = providerValue?.value ?? "openai";
    const table = ["model_providers", id];
    const section = tables.get(tomlKey(table));
    if (!section) {
      // 内置 provider（openai 等）：地址不能改，密钥在 auth.json
      return {
        files: [configDisplay, authDisplay],
        baseUrl: readOnly(
          "baseUrl",
          `${configDisplay} → model_provider = "${id}"`,
          serverText("runtimeCredentials.note.builtin"),
        ),
        apiKey: authJson(),
      };
    }
    const where = (key: string) => `${configDisplay} → [model_providers.${id}] ${key}`;
    const string = (key: string) => {
      const value = section.entries.get(tomlKey([key]))?.value;
      return value === undefined ? undefined : value;
    };
    const editToml = (key: string) => ({
      file: configFile,
      apply: (content: string, value: string) => setTomlString(content, table, key, value),
    });

    const base = string("base_url");
    const baseUrl: Located =
      base === "complex"
        ? readOnly("baseUrl", where("base_url"), complex)
        : {
            info: fieldInfo("baseUrl", base?.value, where("base_url"), true),
            value: base?.value,
            edit: editToml("base_url"),
          };

    const token = string("experimental_bearer_token");
    const envKey = string("env_key");
    const requiresAuth = section.entries.get(tomlKey(["requires_openai_auth"]));
    let apiKey: Located;
    if (token === "complex") {
      apiKey = readOnly("apiKey", where("experimental_bearer_token"), complex);
    } else if (token) {
      apiKey = {
        info: fieldInfo("apiKey", token.value, where("experimental_bearer_token"), true),
        value: token.value,
        edit: editToml("experimental_bearer_token"),
      };
    } else if (envKey) {
      apiKey =
        envKey === "complex"
          ? readOnly("apiKey", where("env_key"), complex)
          : readOnly(
              "apiKey",
              where("env_key"),
              serverText("runtimeCredentials.note.envKey", { name: envKey.value }),
            );
    } else if (
      requiresAuth &&
      /=\s*true\b/.test(this.line(configFile, requiresAuth.line, pending))
    ) {
      apiKey = authJson();
    } else {
      apiKey = {
        info: fieldInfo("apiKey", undefined, where("experimental_bearer_token"), true),
        value: undefined,
        edit: editToml("experimental_bearer_token"),
      };
    }
    return { files: [configDisplay, authDisplay], baseUrl, apiKey };
  }

  private line(file: string, index: number, pending?: Map<string, string>): string {
    return (pending?.get(file) ?? readText(file) ?? "").split("\n")[index] ?? "";
  }

  /** 逐个文件备份并原子替换；中途失败把已经换掉的还原回去 */
  private commit(writes: Write[]) {
    const done: Array<{ target: string; original: string | undefined; mode: number }> = [];
    try {
      for (const { file, content } of writes) {
        const target = resolveTarget(file);
        const original = readText(target);
        const mode = original === undefined ? 0o600 : statSync(target).mode & 0o777;
        if (original !== undefined) this.backup(target);
        this.replace(target, content, mode);
        done.push({ target, original, mode });
      }
    } catch (error) {
      for (const { target, original, mode } of done.reverse()) {
        try {
          if (original === undefined) unlinkSync(target);
          else this.replace(target, original, mode);
        } catch {
          // 还原也失败时备份文件还在，错误照常报出去
        }
      }
      if (error instanceof HiveError) throw error;
      const file = writes[done.length]?.file ?? writes[0]!.file;
      const reason = (error as NodeJS.ErrnoException).code ?? "write error";
      throw new HiveError(
        "RUNTIME_CREDENTIALS_WRITE_FAILED",
        serverText("error.runtimeCredentials.writeFailed", { file: this.display(file), reason }),
      );
    }
  }

  private backup(target: string) {
    const backup = `${target}${BACKUP_TAG}${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    // 备份里也是密钥：不管原文件什么权限，备份只给自己读；同一毫秒内重复备份时覆盖
    const fd = openSync(backup, "w", 0o600);
    try {
      this.writeContent(fd, readFileSync(target, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(backup, 0o600);
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}${BACKUP_TAG}`;
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // 清不掉旧备份不影响这次写入
      }
    }
  }

  private replace(target: string, content: string, mode: number) {
    const temp = `${target}.superhive-tmp-${randomBytes(6).toString("hex")}`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", mode);
      this.writeContent(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能还没建出来
      }
      throw error;
    }
  }
}

/** 配置文件是符号链接（比如放在 dotfiles 仓库里）时写到链接指向的文件，链接本身保留 */
function resolveTarget(file: string): string {
  try {
    if (lstatSync(file).isSymbolicLink()) return realpathSync(file);
  } catch {
    // 文件还不存在
  }
  return file;
}
