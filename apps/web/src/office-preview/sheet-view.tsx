import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { useElementSize } from "./hooks";
import { OfficePreviewError } from "./office-kind";
import {
  SHEET_COL_LIMIT,
  SHEET_ROW_LIMIT,
  columnName,
  readWorkbook,
  type SheetModel,
  type SheetRow,
  type WorkbookModel,
} from "./sheet-model";
import type { OfficeViewProps } from "./types";

const ROW_HEADER_WIDTH = 48;
const LETTER_ROW_HEIGHT = 24;
/** 视口上下各多渲染这么多像素的行，快速滚动时不露白 */
const OVERSCAN = 400;

/**
 * 只渲染视口附近的行。行高各不相同，用前缀和定位；被合并单元格跨进视口的行，
 * 要从合并的起点那行开始渲染，否则跨行的格子会缺一块。
 */
export function visibleWindow(
  offsets: number[],
  mergeTop: number[],
  scrollTop: number,
  viewport: number,
): [number, number] {
  const count = offsets.length - 1;
  if (count <= 0) return [0, 0];
  const top = Math.max(0, scrollTop - OVERSCAN);
  const bottom = scrollTop + viewport + OVERSCAN;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= top) low = middle;
    else high = middle - 1;
  }
  const start = Math.min(low, mergeTop[low] ?? low);
  let end = low;
  while (end < count && offsets[end]! < bottom) end += 1;
  return [start, end];
}

function Cell({
  cell,
  style,
}: {
  cell: SheetRow["cells"][number];
  style?: CSSProperties | undefined;
}) {
  if (cell === null) return null;
  const merged: CSSProperties = { ...style };
  if (cell?.fill) merged.background = cell.fill;
  if (cell?.align) merged.textAlign = cell.align;
  return (
    <td
      colSpan={cell?.colSpan}
      rowSpan={cell?.rowSpan}
      style={Object.keys(merged).length ? merged : undefined}
      className={cell?.fill ? "filled" : undefined}
    >
      {cell?.text}
    </td>
  );
}

function SheetTable({ sheet }: { sheet: SheetModel }) {
  const [measure, size] = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0, left: 0 });
    setScrollTop(0);
  }, [sheet]);

  const frozen = useMemo(() => sheet.rows.slice(0, sheet.frozenRows), [sheet]);
  const body = useMemo(() => sheet.rows.slice(sheet.frozenRows), [sheet]);
  const { offsets, mergeTop } = useMemo(() => {
    const offsets = [0];
    for (const row of body) offsets.push(offsets[offsets.length - 1]! + row.height);
    // 每行被哪个合并单元格盖住时，那个合并从第几行开始
    const mergeTop = body.map((_, index) => index);
    body.forEach((row, index) => {
      row.cells.forEach((cell) => {
        if (cell?.rowSpan)
          for (let r = index + 1; r < Math.min(body.length, index + cell.rowSpan); r += 1)
            mergeTop[r] = Math.min(mergeTop[r]!, index);
      });
    });
    return { offsets, mergeTop };
  }, [body]);

  const frozenHeight = frozen.reduce((sum, row) => sum + row.height, 0);
  const [start, end] = visibleWindow(
    offsets,
    mergeTop,
    Math.max(0, scrollTop - LETTER_ROW_HEIGHT - frozenHeight),
    size.height || 600,
  );
  // 冻结的列：左边固定，偏移是行号列加前面几列的宽度
  const stickyLeft = useMemo(() => {
    const lefts: number[] = [];
    let left = ROW_HEADER_WIDTH;
    for (let c = 0; c < sheet.frozenCols; c += 1) {
      lefts.push(left);
      left += sheet.columns[c]!.width;
    }
    return lefts;
  }, [sheet]);
  const cellStyle = (position: number, top?: number): CSSProperties | undefined => {
    const style: CSSProperties = {};
    if (position < stickyLeft.length) {
      style.position = "sticky";
      style.left = stickyLeft[position];
      style.zIndex = top === undefined ? 1 : 3;
    }
    if (top !== undefined) {
      style.position = "sticky";
      style.top = top;
      style.zIndex = style.zIndex ?? 2;
    }
    return Object.keys(style).length ? style : undefined;
  };
  const width = ROW_HEADER_WIDTH + sheet.columns.reduce((sum, column) => sum + column.width, 0);

  const renderRow = (row: SheetRow, top?: number) => (
    <tr
      key={row.index}
      style={{ height: row.height }}
      className={top === undefined ? undefined : "frozen"}
    >
      <th scope="row" className="office-sheet-rownum" style={{ top }}>
        {row.index + 1}
      </th>
      {row.cells.map((cell, position) =>
        cell === null ? null : <Cell key={position} cell={cell} style={cellStyle(position, top)} />,
      )}
    </tr>
  );

  let frozenTop = LETTER_ROW_HEIGHT;
  return (
    <div
      className="office-sheet-scroll"
      ref={(element) => {
        scrollRef.current = element;
        measure(element);
      }}
      onScroll={(event) => {
        const value = event.currentTarget.scrollTop;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setScrollTop(value));
      }}
      tabIndex={0}
    >
      <table className="office-sheet-table" style={{ width }} aria-label={sheet.name}>
        <colgroup>
          <col style={{ width: ROW_HEADER_WIDTH }} />
          {sheet.columns.map((column) => (
            <col key={column.index} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="office-sheet-letters" style={{ height: LETTER_ROW_HEIGHT }}>
            <th className="office-sheet-corner" aria-hidden="true" />
            {sheet.columns.map((column, position) => (
              <th
                key={column.index}
                scope="col"
                style={
                  position < stickyLeft.length
                    ? { left: stickyLeft[position], zIndex: 4 }
                    : undefined
                }
              >
                {columnName(column.index)}
              </th>
            ))}
          </tr>
          {frozen.map((row) => {
            const top = frozenTop;
            frozenTop += row.height;
            return renderRow(row, top);
          })}
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true" style={{ height: offsets[start] }} />}
          {body.slice(start, end).map((row) => renderRow(row))}
          {end < body.length && (
            <tr aria-hidden="true" style={{ height: offsets[body.length]! - offsets[end]! }} />
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function SheetView({
  bytes,
  name,
  compact,
  onError,
  kind,
}: OfficeViewProps & {
  kind: "xlsx" | "xls" | "csv";
}) {
  const [book, setBook] = useState<{ bytes: Uint8Array; value: WorkbookModel }>();
  const [active, setActive] = useState(0);
  useEffect(() => {
    // 让「正在读取」先画出来再做同步解析
    const timer = setTimeout(() => {
      try {
        const value = readWorkbook(bytes, kind);
        setActive(value.sheets[0]!.index);
        setBook({ bytes, value });
      } catch (cause) {
        onError(cause);
      }
    }, 16);
    return () => clearTimeout(timer);
  }, [bytes, kind, onError]);
  const workbook = book?.bytes === bytes ? book.value : undefined;
  const [sheet, setSheet] = useState<SheetModel>();
  useEffect(() => {
    if (!workbook) return;
    try {
      setSheet(workbook.sheet(active));
    } catch (cause) {
      onError(cause instanceof OfficePreviewError ? cause : new OfficePreviewError("failed"));
    }
  }, [workbook, active, onError]);

  if (!workbook || !sheet)
    return (
      <p className="office-preview-status" role="status">
        {t("正在读取表格…")}
      </p>
    );
  const notices: string[] = [];
  if (sheet.truncatedRows)
    notices.push(
      sheet.totalRows > SHEET_ROW_LIMIT + 1
        ? t("仅显示前 {0} 行（共 {1} 行）", {
            0: SHEET_ROW_LIMIT.toLocaleString(),
            1: sheet.totalRows.toLocaleString(),
          })
        : t("仅显示前 {0} 行", { 0: SHEET_ROW_LIMIT.toLocaleString() }),
    );
  if (sheet.truncatedCols)
    notices.push(t("仅显示前 {0} 列", { 0: SHEET_COL_LIMIT.toLocaleString() }));
  return (
    <div className={`office-sheet${compact ? " compact" : ""}`} aria-label={name}>
      {sheet.rows.length === 0 || sheet.columns.length === 0 ? (
        <p className="office-preview-status">{t("这个工作表是空的。")}</p>
      ) : (
        <SheetTable sheet={sheet} />
      )}
      {notices.length > 0 && (
        <p className="office-sheet-notice" role="note">
          {notices.join(" · ")} {t("完整内容请下载查看。")}
        </p>
      )}
      {workbook.sheets.length > 1 && (
        <div className="office-sheet-tabs" role="tablist" aria-label={t("工作表")}>
          {workbook.sheets.map((item) => (
            <button
              type="button"
              role="tab"
              key={item.index}
              aria-selected={item.index === active}
              className={item.index === active ? "active" : ""}
              onClick={() => setActive(item.index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
