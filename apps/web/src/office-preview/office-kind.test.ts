import { describe, expect, it } from "vitest";
import {
  OFFICE_PREVIEW_LIMIT,
  OfficePreviewError,
  checkOfficeBytes,
  isTextOffice,
  officeKind,
} from "./office-kind";

const problem = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof OfficePreviewError ? error.problem : "other";
  }
  return undefined;
};

describe("officeKind", () => {
  it("按扩展名认出 Word / Excel / PowerPoint / CSV，其余不算", () => {
    expect(officeKind("报告.DOCX")).toBe("docx");
    expect(officeKind("a/b/sales.xlsx")).toBe("xlsx");
    expect(officeKind("old.xls")).toBe("xls");
    expect(officeKind("data.tsv")).toBe("csv");
    expect(officeKind("deck.pptm")).toBe("pptx");
    expect(officeKind("legacy.doc")).toBeUndefined();
    expect(officeKind("slides.ppt")).toBeUndefined();
    expect(officeKind(".xlsx")).toBeUndefined();
    expect(officeKind("readme")).toBeUndefined();
    expect(isTextOffice("csv")).toBe(true);
    expect(isTextOffice("xlsx")).toBe(false);
  });
});

describe("checkOfficeBytes", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
  it("docx / xlsx / pptx 必须是 zip；OLE 外壳当作加密，其他当作内容不对", () => {
    expect(problem(() => checkOfficeBytes("docx", zip))).toBeUndefined();
    expect(problem(() => checkOfficeBytes("pptx", ole))).toBe("encrypted");
    expect(problem(() => checkOfficeBytes("xlsx", new TextEncoder().encode("<html>")))).toBe(
      "invalid",
    );
  });
  it(".xls 本来就是 OLE、CSV 是文本，不在这里拦", () => {
    expect(problem(() => checkOfficeBytes("xls", ole))).toBeUndefined();
    expect(problem(() => checkOfficeBytes("csv", new TextEncoder().encode("a,b")))).toBeUndefined();
  });
  it("超过上限一律不解析", () => {
    const big = { byteLength: OFFICE_PREVIEW_LIMIT + 1 } as Uint8Array;
    expect(problem(() => checkOfficeBytes("csv", big))).toBe("too-large");
  });
});
