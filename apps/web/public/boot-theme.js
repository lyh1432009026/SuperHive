// 首屏之前按上次选的主题给 html 打 data-theme，加载占位和页面底色一开始就是对的，不先白一下再变黑。
// 必须是同源的外部脚本（CSP 不放行内联脚本）；React 起来后由 App 接管。
/* global window, document, localStorage */
(function () {
  try {
    var saved = localStorage.getItem("superhive.theme");
    var dark =
      saved === "dark" ||
      (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch {
    /* 读不到存储就按系统走，CSS 里有 prefers-color-scheme 兜底 */
  }
})();
