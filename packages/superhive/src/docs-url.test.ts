import { describe, expect, it } from "vitest";
// 这个包不依赖 protocol；测试直接读源码核对两边的地址一致
import { DOCS_BASE_URL } from "../../protocol/src/docs-links.js";
import { DOCS_URL } from "./docs-url.js";

describe("DOCS_URL", () => {
  it("和网页用的文档地址一致", () => {
    expect(DOCS_URL).toBe(DOCS_BASE_URL);
  });
});
