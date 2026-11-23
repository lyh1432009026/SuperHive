// 首页的交互：顶部进度条、左侧分段圆点、逐字上色、词云视差、流程分段点亮、实景窗口的切换和亮点说明、复制命令。
// 所有滚动效果共用一个 rAF 节流的 scroll 处理；减少动态效果时只保留圆点高亮、进度条和点击类交互。

const root = document.querySelector<HTMLElement>("[data-hl]");
if (root) init(root);

function init(root: HTMLElement) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const bar = root.querySelector<HTMLElement>("[data-hl-progress]");
  const statement = root.querySelector<HTMLElement>("[data-hl-statement]");
  const cloudSection = root.querySelector<HTMLElement>("[data-hl-cloud-section]");
  const cloud = root.querySelector<HTMLElement>("[data-hl-cloud]");
  const stagesSection = root.querySelector<HTMLElement>("[data-hl-stages]");
  const stages = [...root.querySelectorAll<HTMLElement>("[data-hl-stage]")];
  const windowEl = root.querySelector<HTMLElement>("[data-hl-window]");

  let litStages = -1;

  /** 元素滚过视口的进度：顶边到达视口某处为 0，底边离开为 1 */
  const progressOf = (element: HTMLElement, start = 0.85, end = 0.35) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.innerHeight;
    const from = viewport * start;
    const to = viewport * end - rect.height;
    return Math.min(1, Math.max(0, (from - rect.top) / (from - to)));
  };

  const update = () => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;

    if (reduce.matches) {
      if (litStages !== stages.length) {
        stages.forEach((stage) => stage.classList.add("is-on"));
        litStages = stages.length;
      }
      cloud?.style.removeProperty("--py");
      windowEl?.style.removeProperty("--tilt");
      return;
    }

    if (cloud && cloudSection) {
      const rect = cloudSection.getBoundingClientRect();
      const centerOffset = rect.top + rect.height / 2 - window.innerHeight / 2;
      cloud.style.setProperty("--py", (centerOffset * -0.12).toFixed(1));
    }

    if (stagesSection && stages.length) {
      const p = progressOf(stagesSection, 0.8, 0.55);
      const count = Math.min(
        stages.length,
        Math.floor(p * (stages.length + 0.5)) + (p > 0 ? 1 : 0),
      );
      if (count !== litStages) {
        stages.forEach((stage, index) => stage.classList.toggle("is-on", index < count));
        stagesSection.style.setProperty(
          "--lit",
          String(Math.max(0, count - 1) / (stages.length - 1)),
        );
        litStages = count;
      }
    }

    if (windowEl) {
      // 首屏窗口：往下滚时从微微后仰回正，只动 transform，不影响布局
      const tilt = Math.min(1, window.scrollY / (window.innerHeight * 0.6));
      windowEl.style.setProperty("--tilt", tilt.toFixed(3));
    }
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  reduce.addEventListener("change", () => {
    litStages = -1;
    schedule();
  });
  root.classList.add("is-ready");
  update();

  // 一句话：进入视口约三成后按时间逐字上色（样式里按 --i 错开），不跟滚动绑定，滚多快都不会卡着灰字
  if (statement) {
    if (reduce.matches || !("IntersectionObserver" in window)) statement.classList.add("is-lit");
    else {
      const lit = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          statement.classList.add("is-lit");
          lit.disconnect();
        },
        { threshold: 0.35 },
      );
      lit.observe(statement);
    }
  }

  // 左侧圆点：哪一段占据视口中线就点亮哪一个
  const dots = new Map(
    [...root.querySelectorAll<HTMLAnchorElement>("[data-hl-dot]")].map((dot) => [
      dot.dataset.hlDot!,
      dot,
    ]),
  );
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const current = [...dots.keys()].find((id) => visible.has(id));
      dots.forEach((dot, id) => {
        if (id === current) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      });
      root.classList.toggle("has-section", Boolean(current));
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  dots.forEach((_, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });

  setupWindow(root);
  setupCopy(root);
}

function setupWindow(root: HTMLElement) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-hl-tab]")];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-hl-panel]")];
  const closeSpots = (except?: HTMLButtonElement) => {
    root
      .querySelectorAll<HTMLButtonElement>(".hl-spot > button[aria-expanded='true']")
      .forEach((button) => {
        if (button === except) return;
        button.setAttribute("aria-expanded", "false");
        document.getElementById(button.getAttribute("aria-controls")!)!.hidden = true;
      });
  };
  const select = (tab: HTMLButtonElement, focus = false) => {
    closeSpots();
    tabs.forEach((item) => {
      const on = item === tab;
      item.setAttribute("aria-selected", String(on));
      item.tabIndex = on ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.hlPanel !== tab.dataset.hlTab;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      select(tabs[(index + step + tabs.length) % tabs.length], true);
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".hl-spot > button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = button.getAttribute("aria-expanded") !== "true";
      closeSpots(button);
      button.setAttribute("aria-expanded", String(open));
      document.getElementById(button.getAttribute("aria-controls")!)!.hidden = !open;
      root.querySelector("[data-hl-window]")?.classList.add("was-explored");
    });
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as Element).closest?.(".hl-spot")) closeSpots();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = root.querySelector<HTMLButtonElement>(".hl-spot > button[aria-expanded='true']");
    closeSpots();
    open?.focus();
  });
}

function setupCopy(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    const label = button.textContent!.trim();
    let timer = 0;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy!);
        button.textContent = button.dataset.copied!;
        button.classList.add("is-copied");
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          button.textContent = label;
          button.classList.remove("is-copied");
        }, 1600);
      } catch {
        // 剪贴板不可用（非安全上下文等）时什么都不做，命令本身可以手动选中
      }
    });
  });
}
