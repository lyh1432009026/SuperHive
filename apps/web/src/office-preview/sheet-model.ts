import { SSF, read, utils, type CellObject, type WorkBook, type WorkSheet } from "xlsx";
import { OfficePreviewError, type OfficeKind } from "./office-kind";

/**
 * 表格：SheetJS（CDN 上的 0.20.3，修过 npm 上 0.18.5 的原型污染和 ReDoS）读 xlsx / xls / csv，
 * 转成一份只有文字和少量样式的数据交给 React 渲染，不经过 HTML，文档里的东西没有机会被当成标签执行。
 * 数字、日期按单元格自己的数字格式显示（SheetJS 的 SSF），合并单元格、列宽、行高、隐藏行列、
 * 冻结窗格都保留；最多读前 SHEET_ROW_LIMIT 行、显示前 SHEET_COL_LIMIT 列。
 */

export const SHEET_ROW_LIMIT = 10_000;
export const SHEET_COL_LIMIT = 200;

const DEFAULT_COL_WIDTH = 72;
const DEFAULT_ROW_HEIGHT = 24;

export type SheetCell = {
  text: string;
  align?: "right" | "center";
  fill?: string;
  colSpan?: number;
  rowSpan?: number;
};

export type SheetRow = {
  /** 原表里的行号（从 0 开始） */
  index: number;
  height: number;
  /** 按可见列排；null 是被合并单元格盖住的格子 */
  cells: Array<SheetCell | null | undefined>;
};

export type SheetModel = {
  name: string;
  columns: Array<{ index: number; width: number }>;
  rows: SheetRow[];
  totalRows: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  frozenRows: number;
  frozenCols: number;
};

export type WorkbookModel = {
  sheets: Array<{ name: string; index: number }>;
  sheet: (index: number) => SheetModel;
};

/** CSV 常见 UTF-8（可能带 BOM），Windows 上导出的中文 CSV 多是 GBK */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

export function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

type ZipEntry = { content?: Uint8Array | number[] };

function zipText(files: Record<string, ZipEntry> | undefined, path: string): string | undefined {
  if (!files) return undefined;
  const entry = files[path] ?? files[`/${path}`];
  if (!entry?.content) return undefined;
  return new TextDecoder().decode(
    entry.content instanceof Uint8Array ? entry.content : Uint8Array.from(entry.content),
  );
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * 冻结窗格 SheetJS 社区版不读，自己从 xlsx 包里找：workbook.xml 里第 i 个工作表的 r:id →
 * 关系文件里的路径 → 这个工作表 XML 里 state="frozen" 的 <pane>
 */
export function readFrozenPanes(
  files: Record<string, ZipEntry> | undefined,
): Array<{ rows: number; cols: number }> {
  const workbook = zipText(files, "xl/workbook.xml");
  const rels = zipText(files, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return [];
  const targets = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target)
      targets.set(
        id,
        target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
      );
  }
  return (workbook.match(/<(?:\w+:)?sheet\b[^>]*>/g) ?? []).map((tag) => {
    const id = /\br:id="([^"]*)"/.exec(tag)?.[1] ?? /\b\w+:id="([^"]*)"/.exec(tag)?.[1];
    const xml = id ? zipText(files, targets.get(id) ?? "") : undefined;
    const pane = xml && /<(?:\w+:)?pane\b[^>]*>/.exec(xml)?.[0];
    if (!pane || !/state="frozen(?:Split)?"/.test(pane)) return { rows: 0, cols: 0 };
    return {
      rows: Math.max(0, Math.floor(Number(attr(pane, "ySplit") ?? 0)) || 0),
      cols: Math.max(0, Math.floor(Number(attr(pane, "xSplit") ?? 0)) || 0),
    };
  });
}

/**
 * 数字格式里没加引号的中文、¥ 这类字符 Excel 认、SSF 不认（整格就没有显示文字了）：
 * 引号和方括号以外的非 ASCII 字符补上引号再格式化一次
 */
export function quoteFormatLiterals(format: string): string {
  return format
    .split(/("[^"]*"|\[[^\]]*\])/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[^ -~]+/g, (run) => `"${run}"`)))
    .join("");
}

function cellText(cell: CellObject): string {
  if (cell.w !== undefined) return cell.w;
  if (cell.z !== undefined && (typeof cell.v === "number" || cell.v instanceof Date)) {
    try {
      return SSF.format(quoteFormatLiterals(String(cell.z)), cell.v);
    } catch {
      // 格式还是认不出就显示原值
    }
  }
  if (cell.v instanceof Date) return cell.v.toLocaleString();
  if (cell.v === undefined || cell.v === null) return "";
  return String(cell.v);
}

const HEX = /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i;

function cellFill(cell: CellObject): string | undefined {
  const style = cell.s as { patternType?: string; fgColor?: { rgb?: string } } | undefined;
  if (style?.patternType !== "solid") return undefined;
  const match = HEX.exec(style.fgColor?.rgb ?? "");
  return match ? `#${match[1]}` : undefined;
}

/** CSV 里都是文字；长得像数字的照样右对齐 */
const NUMERIC_TEXT = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

function toSheetModel(
  sheet: WorkSheet,
  name: string,
  frozen: { rows: number; cols: number },
  textOnly = false,
): SheetModel {
  const range = utils.decode_range(sheet["!ref"] ?? "A1:A1");
  const full = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1:A1");
  const data = (sheet["!data"] ?? []) as Array<Array<CellObject | undefined> | undefined>;
  const lastRow = Math.min(range.e.r, SHEET_ROW_LIMIT - 1);
  const lastCol = Math.min(range.e.c, SHEET_COL_LIMIT - 1);
  const colInfo = sheet["!cols"] ?? [];
  const rowInfo = sheet["!rows"] ?? [];

  const columns: SheetModel["columns"] = [];
  const colPosition = new Map<number, number>();
  for (let c = 0; c <= lastCol; c += 1) {
    const info = colInfo[c];
    if (info?.hidden) continue;
    // width 是 Excel 的字符宽度（默认字体的数字宽约 7px）；没有时退回 SheetJS 按 6px 算的 wpx
    const width = info?.width
      ? info.width * 7 + 5
      : (info?.wpx ?? (info?.wch ? info.wch * 7 + 5 : DEFAULT_COL_WIDTH));
    colPosition.set(c, columns.length);
    columns.push({ index: c, width: Math.round(Math.max(24, Math.min(600, width))) });
  }
  const rowIndexes: number[] = [];
  const rowPosition = new Map<number, number>();
  for (let r = 0; r <= lastRow; r += 1) {
    if (rowInfo[r]?.hidden) continue;
    rowPosition.set(r, rowIndexes.length);
    rowIndexes.push(r);
  }

  const rows: SheetRow[] = rowIndexes.map((r) => {
    const info = rowInfo[r];
    const height = info?.hpx ?? (info?.hpt ? (info.hpt * 4) / 3 : DEFAULT_ROW_HEIGHT);
    const source = data[r];
    return {
      index: r,
      height: Math.round(Math.max(18, Math.min(240, height))),
      cells: columns.map(({ index }) => {
        const cell = source?.[index];
        if (!cell) return undefined;
        const value: SheetCell = { text: cellText(cell) };
        if (cell.t === "n" || cell.t === "d") value.align = "right";
        else if (textOnly && NUMERIC_TEXT.test(value.text.trim())) value.align = "right";
        else if (cell.t === "b" || cell.t === "e") value.align = "center";
        const fill = cellFill(cell);
        if (fill) value.fill = fill;
        return value;
      }),
    };
  });

  // 合并单元格：左上角那格按可见行列数跨过去，其余格子标成被盖住
  for (const merge of sheet["!merges"] ?? []) {
    const visibleRows: number[] = [];
    for (let r = merge.s.r; r <= Math.min(merge.e.r, lastRow); r += 1)
      if (rowPosition.has(r)) visibleRows.push(r);
    const visibleCols = columns.filter((col) => col.index >= merge.s.c && col.index <= merge.e.c);
    if (visibleRows.length === 0 || visibleCols.length === 0) continue;
    const top = rowPosition.get(visibleRows[0]!)!;
    const left = colPosition.get(visibleCols[0]!.index)!;
    for (let r = 0; r < visibleRows.length; r += 1)
      for (let c = 0; c < visibleCols.length; c += 1) rows[top + r]!.cells[left + c] = null;
    const origin: SheetCell = rows[top]!.cells[left] ?? { text: "" };
    const source = data[visibleRows[0]!]?.[visibleCols[0]!.index];
    const merged: SheetCell = source ? { ...origin, text: cellText(source) } : { text: "" };
    const fill = source ? cellFill(source) : undefined;
    if (fill) merged.fill = fill;
    if (source?.t === "n" || source?.t === "d") merged.align = "right";
    if (visibleCols.length > 1) merged.colSpan = visibleCols.length;
    if (visibleRows.length > 1) merged.rowSpan = visibleRows.length;
    rows[top]!.cells[left] = merged;
  }

  const countVisible = (limit: number, positions: Map<number, number>) => {
    let count = 0;
    for (const key of positions.keys()) if (key < limit) count += 1;
    return count;
  };
  return {
    name,
    columns,
    rows,
    totalRows: full.e.r + 1,
    truncatedRows: full.e.r > lastRow,
    truncatedCols: range.e.c > lastCol,
    frozenRows: Math.min(countVisible(frozen.rows, rowPosition), 10),
    frozenCols: Math.min(countVisible(frozen.cols, colPosition), 5),
  };
}

function isPasswordError(cause: unknown): boolean {
  return /password|encrypt/i.test(cause instanceof Error ? cause.message : String(cause));
}

export function readWorkbook(bytes: Uint8Array, kind: OfficeKind): WorkbookModel {
  let workbook: WorkBook;
  try {
    workbook =
      kind === "csv"
        ? read(decodeText(bytes), {
            type: "string",
            raw: true,
            dense: true,
            sheetRows: SHEET_ROW_LIMIT + 1,
          })
        : read(bytes, {
            type: "array",
            dense: true,
            cellDates: true,
            cellStyles: true,
            cellHTML: false,
            sheetRows: SHEET_ROW_LIMIT + 1,
            bookFiles: true,
            bookVBA: false,
          });
  } catch (cause) {
    throw new OfficePreviewError(
      isPasswordError(cause) ? "encrypted" : "failed",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!workbook.SheetNames.length) throw new OfficePreviewError("failed", "no sheets");
  const frozen =
    kind === "csv" ? [] : readFrozenPanes((workbook as { files?: Record<string, ZipEntry> }).files);
  const hidden = workbook.Workbook?.Sheets ?? [];
  let sheets = workbook.SheetNames.map((name, index) => ({ name, index })).filter(
    ({ index }) => !hidden[index]?.Hidden,
  );
  if (sheets.length === 0) sheets = workbook.SheetNames.map((name, index) => ({ name, index }));
  const cache = new Map<number, SheetModel>();
  return {
    sheets,
    sheet(index) {
      let model = cache.get(index);
      if (!model) {
        const name = workbook.SheetNames[index]!;
        // CSV 第一行一般是表头，冻住
        const panes =
          kind === "csv" ? { rows: 1, cols: 0 } : (frozen[index] ?? { rows: 0, cols: 0 });
        model = toSheetModel(workbook.Sheets[name]!, name, panes, kind === "csv");
        cache.set(index, model);
      }
      return model;
    },
  };
}
