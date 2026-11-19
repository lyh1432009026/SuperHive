import { describe, expect, it } from "vitest";
import { utils, write, type WorkBook } from "xlsx";
import { OfficePreviewError } from "./office-kind";
import {
  SHEET_ROW_LIMIT,
  columnName,
  decodeText,
  quoteFormatLiterals,
  readFrozenPanes,
  readWorkbook,
} from "./sheet-model";

function workbook(sheets: Array<[string, unknown[][]]>): WorkBook {
  const book = utils.book_new();
  for (const [name, rows] of sheets) utils.book_append_sheet(book, utils.aoa_to_sheet(rows), name);
  return book;
}

const bytes = (book: WorkBook, bookType: "xlsx" | "biff8" = "xlsx") =>
  new Uint8Array(write(book, { type: "array", bookType }) as ArrayBuffer);

describe("readWorkbook", () => {
  it("多个工作表；数字按格式显示、右对齐；合并单元格、列宽保留", () => {
    const book = workbook([
      [
        "销售",
        [
          ["华东区销售（合成）", null, null],
          ["日期", "门店", "金额"],
          [new Date(Date.UTC(2026, 9, 1)), "静安店", 1234.5],
        ],
      ],
      ["汇总", [["合计"]]],
    ]);
    const sheet = book.Sheets["销售"]!;
    sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
    sheet["!cols"] = [{ width: 14 }, {}, { wch: 12 }];
    sheet["C3"]!.z = "#,##0.00";
    sheet["A3"]!.z = "yyyy-mm-dd";
    const model = readWorkbook(bytes(book), "xlsx");
    expect(model.sheets.map((item) => item.name)).toEqual(["销售", "汇总"]);
    const first = model.sheet(0);
    expect(first.rows[0]!.cells[0]).toMatchObject({ text: "华东区销售（合成）", colSpan: 3 });
    expect(first.rows[0]!.cells[1]).toBeNull();
    expect(first.rows[2]!.cells[0]).toMatchObject({ text: "2026-10-01", align: "right" });
    expect(first.rows[2]!.cells[2]).toMatchObject({ text: "1,234.50", align: "right" });
    expect(first.columns[0]!.width).toBe(14 * 7 + 5);
    expect(first.truncatedRows).toBe(false);
    expect(model.sheet(1).rows[0]!.cells[0]!.text).toBe("合计");
  });

  it("隐藏的工作表不列出", () => {
    const book = workbook([
      ["可见", [["a"]]],
      ["隐藏", [["b"]]],
    ]);
    book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
    expect(readWorkbook(bytes(book), "xlsx").sheets.map((item) => item.name)).toEqual(["可见"]);
  });

  it(`超过 ${SHEET_ROW_LIMIT} 行只读前面的，并给出总行数`, () => {
    const rows = Array.from({ length: SHEET_ROW_LIMIT + 20 }, (_, index) => [index]);
    const model = readWorkbook(bytes(workbook([["大表", rows]])), "xlsx").sheet(0);
    expect(model.rows).toHaveLength(SHEET_ROW_LIMIT);
    expect(model.truncatedRows).toBe(true);
    expect(model.totalRows).toBeGreaterThan(SHEET_ROW_LIMIT);
  });

  it("旧版 .xls 也能读", () => {
    const model = readWorkbook(bytes(workbook([["旧表", [["x", 1]]]]), "biff8"), "xls");
    expect(model.sheet(0).rows[0]!.cells.map((cell) => cell?.text)).toEqual(["x", "1"]);
  });

  it("CSV：GBK 也能认，第一行冻住，文字不做类型推断", () => {
    const gbk = new Uint8Array([
      // "城市,编号\n上海,007\n" 的 GBK 编码
      0xb3, 0xc7, 0xca, 0xd0, 0x2c, 0xb1, 0xe0, 0xba, 0xc5, 0x0a, 0xc9, 0xcf, 0xba, 0xa3, 0x2c,
      0x30, 0x30, 0x37, 0x0a,
    ]);
    const model = readWorkbook(gbk, "csv").sheet(0);
    expect(model.frozenRows).toBe(1);
    expect(model.rows.map((row) => row.cells.map((cell) => cell?.text))).toEqual([
      ["城市", "编号"],
      ["上海", "007"],
    ]);
    expect(model.rows[1]!.cells[1]!.align).toBe("right");
    expect(model.rows[1]!.cells[0]!.align).toBeUndefined();
  });

  it("读不了的文件报 failed", () => {
    expect(() => readWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), "xlsx")).toThrow(
      OfficePreviewError,
    );
  });
});

describe("表格小工具", () => {
  it("列名 A…Z、AA…", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("数字格式里没加引号的中文和货币符号补上引号", () => {
    expect(quoteFormatLiterals("¥#,##0.00")).toBe('"¥"#,##0.00');
    expect(quoteFormatLiterals('#,##0"元"')).toBe('#,##0"元"');
    expect(quoteFormatLiterals("[$¥-804]#,##0;[红色]-0")).toBe("[$¥-804]#,##0;[红色]-0");
    expect(quoteFormatLiterals("yyyy年m月")).toBe('yyyy"年"m"月"');
  });

  it("UTF-8 去掉 BOM", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("冻结窗格从 workbook 关系里找到对应工作表的 <pane>", () => {
    const text = (value: string) => ({ content: new TextEncoder().encode(value) });
    const files = {
      "xl/workbook.xml": text(
        '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId2"/><sheet name="B" sheetId="2" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": text(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": text(
        '<worksheet><sheetViews><sheetView><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews></worksheet>',
      ),
      "xl/worksheets/sheet2.xml": text(
        '<worksheet><sheetViews><sheetView><pane ySplit="5" state="split"/></sheetView></sheetViews></worksheet>',
      ),
    };
    expect(readFrozenPanes(files)).toEqual([
      { rows: 2, cols: 1 },
      { rows: 0, cols: 0 },
    ]);
    expect(readFrozenPanes(undefined)).toEqual([]);
  });
});
