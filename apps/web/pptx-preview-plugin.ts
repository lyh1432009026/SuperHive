import type { Plugin } from "vite";

/**
 * 构建时给 pptx-preview 1.0.7 打两处补丁（开发时的依赖预构建、正式构建都要过这一道）：
 * - 幻灯片里的文字原来用 innerHTML 写进页面，文字里要是写着 <img onerror=…> 就会被当成标签；
 *   改成 textContent（和 zwork 的 patches/pptx-preview@1.0.7.patch 同一处修法）。
 * - 图表用 ECharts 画，带约 1 秒的入场动画；我们排完版就序列化成静态 HTML，动画会被截在第一帧
 *   （只有坐标轴没有柱子），所以关掉动画。系列没写颜色、跟着主题走时库给的是空色，
 *   柱子画成透明的；补上 Office 默认的六个强调色。
 * 升级后找不到原文就直接报错，免得补丁悄悄失效。
 */
const FILE = /[\\/]pptx-preview[\\/]dist[\\/]pptx-preview\.es\.js$/;
const PATCHES: Array<[string, string]> = [
  ['s.innerHTML="string"==typeof c?c:""', 's.textContent="string"==typeof c?c:""'],
  ['{renderer:"svg"});t.setOption(i)', '{renderer:"svg"});t.setOption(__superhiveChartOption(i))'],
];

/** 注入到 pptx-preview 模块开头，给上面第二处替换用 */
const HELPER = `function __superhiveChartOption(o){var d=["#4472C4","#ED7D31","#A5A5A5","#FFC000","#5B9BD5","#70AD47"],c=Array.isArray(o.color)?o.color:[],n=Math.max(c.length,Array.isArray(o.series)?o.series.length:0,1),r=[];for(var k=0;k<n;k++){var v=c[k];r.push(typeof v==="string"&&v&&v!=="none"?v:d[k%d.length])}return Object.assign({},o,{animation:!1,color:r})}\n`;

export function patchPptxPreview(code: string): string {
  let patched = code;
  for (const [from, to] of PATCHES) {
    if (patched.includes(to) && !patched.includes(from)) continue;
    const count = patched.split(from).length - 1;
    if (count !== 1)
      throw new Error(
        `pptx-preview 的代码变了：要替换的「${from}」出现了 ${count} 次。先核对再更新 pptx-preview-plugin.ts`,
      );
    patched = patched.replace(from, to);
  }
  return patched.includes("function __superhiveChartOption") ? patched : HELPER + patched;
}

export function pptxPreviewPatches(): Plugin {
  return {
    name: "superhive:pptx-preview-patches",
    enforce: "pre",
    transform(code, id) {
      if (!FILE.test(id.split("?")[0]!)) return undefined;
      return { code: patchPptxPreview(code), map: null };
    },
  };
}
