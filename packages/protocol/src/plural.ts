/**
 * 英文单复数：网页的 {0|one|other} 和服务端文案目录的 { one, other } 都用它选写法，规则一致。
 * 走 Intl.PluralRules（1 是 one，0、1.5、2 都是 other），不手写 === 1。
 */
const englishRules = new Intl.PluralRules("en");

export function isEnglishSingular(count: unknown): boolean {
  const value = Number(count);
  return Number.isFinite(value) && englishRules.select(value) === "one";
}
