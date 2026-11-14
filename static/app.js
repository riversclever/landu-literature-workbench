/* 澜读 · 文献工作台 — front-end application */
(function () {
  "use strict";

  const md = window.LitMarkdown;
  const esc = md.escapeHtml;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const icon = (name, extra = "") =>
    '<svg class="icon ' + extra + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';

  const PROVIDERS = {
    deepseek: { label: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    qwen: { label: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    zhipu: { label: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus" },
    openai: { label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
    ollama: { label: "本地 Ollama", base: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b" },
    custom: { label: "自定义", base: "", model: "" },
  };

  const FOCUS_LABELS = {
    standard: "综合精读",
    methods: "方法细读",
    writing: "写作借鉴",
    reviewer: "审稿人视角",
  };

  const FOCUS_HINTS = {
    standard: "全覆盖：问题、创新、方法、证据、结论与局限",
    methods: "只写方法维度：设计、质控、统计、复现清单",
    writing: "只写写作维度：结构、论证、图表、句式",
    reviewer: "只写审稿维度：效度、证据、风险、意见",
  };

  const STATUS_LABELS = { unread: "待读", reading: "在读", read: "已读" };

  const CATEGORY_COLORS = ["#4f7b67", "#a46b3f", "#5b7d97", "#8a7a45", "#8a5a72", "#6e7f5a", "#96704b", "#5f6f8f"];
  const CATEGORY_SUGGESTIONS = ["管网入渗", "水质与沉积物", "监测与建模", "城市可持续性", "方法/工具"];

  const MODE_PROMPTS = {
    meeting:
      "请基于这篇论文，生成一份 10–15 分钟组会汇报提纲。包含 slide 结构、每页要点、建议展示的图表、2–3 分钟开场讲法，以及导师和同学最可能追问的 4 个问题。",
    wechat:
      "请把这篇论文写成一篇课题组公众号的文献解读初稿，面向非细分方向的读者。保留关键证据、研究方法和结论边界，给出 3 个克制标题，并标注配图建议。",
    reviewer:
      "请以严格但建设性的审稿人身份审读这篇论文：概括贡献，给出总体判断，列出 major/minor concerns，并说明需要补充哪些实验或分析。",
    methods:
      "请整理一份方法复现清单，覆盖数据与材料、仪器与参数、质控与统计、模型设置，以及原文缺失但复现必需的信息，并指出复现风险最高的环节。",
  };

  const App = {
    papers: [],
    stats: { total: 0, unread: 0, reading: 0, read: 0, with_card: 0, starred: 0, tags: [], categories: [], uncategorized: 0 },
    settings: {},
    selected: new Set(),
    route: { name: "boot" },
    library: { q: "", status: "all", tag: "", category: "", starred: false, withCard: false, sort: "recent" },
    paperData: null,
    pages: null,
    pagesPaperId: null,
    pdfPageByPaper: {},
    cardFocus: {},
    cardTask: null,
    chatTask: null,
    compareTask: null,
    comparisons: [],
    compareFocus: "",
    drafts: {},
    chatDisplayMessages: [],
    modal: null,
    modalReturnFocus: null,
    uploading: false,
    noteTimer: null,
    notesPending: false,
    notesSaving: false,
    takeawayTimer: null,
    takeawayPending: false,
    takeawaySaving: false,
    takeawayDrafting: false,
    autoTakeawayTried: new Set(),
    zoteroTimer: null,
    scanTimer: null,
    routeSeq: 0,
    selectionPopover: null,
    pendingEvidence: null,
    evidenceTimer: null,
    evidenceSeq: 0,
    demoBusy: false,
    deleting: false,
    trashCount: 0,
    categoryColor: "",
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindGlobalEvents();
    ensureSelectionBar();
    try {
      await refreshState();
    } catch (error) {
      renderBootError(error.message || "无法连接本地服务");
      return;
    }
    window.addEventListener("hashchange", renderRoute);
    if (!location.hash) history.replaceState(null, "", "#/library");
    await renderRoute();
    maybeShowOnboarding();
  }

  // ─────────────────────────────────────────────────────────────
  // Utilities & API
  // ─────────────────────────────────────────────────────────────

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function aiReady() {
    const settings = App.settings || {};
    if (settings.api_key_set) return true;
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(settings.base_url || ""));
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function formatAuthors(authors, max) {
    const list = Array.isArray(authors) ? authors.filter(Boolean) : [];
    if (!list.length) return "作者信息未识别";
    const limit = max || 3;
    return list.slice(0, limit).join("、") + (list.length > limit ? " 等" : "");
  }

  function plainSummary(paper) {
    let text = paper.summary || paper.abstract || "";
    text = String(text).replace(/\[p\.\d+\]/gi, "").replace(/\[\*\*|\[\#/g, "[").replace(/\s+/g, " ").trim();
    return text;
  }

  function providerLabel(provider) {
    return (PROVIDERS[provider] || PROVIDERS.custom).label;
  }

  async function api(path, options) {
    const opts = Object.assign({ method: "GET" }, options || {});
    opts.headers = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof Blob) && !(opts.body instanceof File)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch(path, opts);
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch (_) { /* ignore */ }
      const error = new Error((payload && payload.error) || "请求失败（HTTP " + response.status + "）");
      error.code = payload && payload.code;
      error.status = response.status;
      throw error;
    }
    if (contentType.indexOf("application/json") !== -1) return response.json();
    return response.text();
  }

  async function streamSSE(path, payload, onEvent, signal) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      let message = "请求失败（HTTP " + response.status + "）";
      let code = "http";
      try {
        const data = await response.json();
        message = data.error || message;
        code = data.code || code;
      } catch (_) { /* ignore */ }
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    if (!response.body) throw new Error("浏览器不支持流式响应");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = chunk.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length) {
          const raw = dataLines.join("\n");
          if (raw && raw !== "[DONE]") {
            try { onEvent(JSON.parse(raw)); } catch (_) { /* ignore malformed events */ }
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  async function refreshState(silent) {
    const data = await api("/api/state");
    App.papers = data.papers || [];
    App.stats = data.stats || {};
    App.settings = data.settings || {};
    App.trashCount = Number(data.trash_count || 0);
    const ids = new Set(App.papers.map((paper) => paper.id));
    Array.from(App.selected).forEach((id) => { if (!ids.has(id)) App.selected.delete(id); });
    renderSidebar();
    if (!silent) updateNav();
  }

  function setTopbar(title) {
    const el = $("#topbar-title");
    if (el) el.textContent = title;
  }

  function toast(message, type, timeout) {
    const root = $("#toast-root");
    if (!root) return;
    const icons = { success: "check", error: "alert", info: "sparkles" };
    const el = document.createElement("div");
    el.className = "toast " + (type || "info");
    el.innerHTML = icon(icons[type] || "sparkles") + "<div>" + esc(message) + "</div>" +
      '<button class="toast-close" type="button" aria-label="关闭">×</button>';
    root.appendChild(el);
    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    };
    el.querySelector(".toast-close").addEventListener("click", remove);
    setTimeout(remove, timeout || 4300);
    while (root.children.length > 4) root.firstElementChild.remove();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制", "success", 2200);
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); toast("已复制", "success", 2200); }
      catch (error) { toast("复制失败，请手动选择文本", "error"); }
      area.remove();
    }
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function safeFilename(name) {
    return String(name || "文献").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
  }

  function currentPaperId() {
    return App.paperData && App.paperData.paper ? App.paperData.paper.id : null;
  }

  function pdfUrl(paperId, page) {
    const suffix = page ? "#page=" + page + "&zoom=page-width" : "#zoom=page-width";
    return "/api/papers/" + encodeURIComponent(paperId) + "/file" + suffix;
  }

  function categoryList() {
    return Array.isArray(App.stats.categories) ? App.stats.categories : [];
  }

  function categoryMap() {
    const map = new Map();
    categoryList().forEach((category) => map.set(category.id, category));
    return map;
  }

  function categoryById(categoryId) {
    return categoryList().find((category) => category.id === categoryId) || null;
  }

  function categoryDot(color, extraClass) {
    return '<span class="category-dot ' + (extraClass || "") + '" style="background:' + esc(color || "#8e9b94") + '"></span>';
  }

  function categoryChipHtml(category) {
    return '<a class="category-chip" href="#/library?cat=' + encodeURIComponent(category.id) +
      '" title="分类：' + esc(category.name) + '">' + categoryDot(category.color) +
      '<span class="category-chip-name">' + esc(category.name) + "</span></a>";
  }

  function categoryColorButtons(selected) {
    const current = String(selected || CATEGORY_COLORS[0]).toLowerCase();
    return '<div class="category-colors">' + CATEGORY_COLORS.map((color, index) =>
      '<button type="button" class="category-color' + (color === current ? " active" : "") +
      '" data-color="' + color + '" style="--swatch:' + color + '" aria-label="颜色 ' + (index + 1) + '"></button>'
    ).join("") + "</div>";
  }

  function bindCategoryColors(root, input) {
    if (!root || !input) return;
    $$("[data-color]", root).forEach((button) => {
      button.addEventListener("click", () => {
        input.value = button.dataset.color || CATEGORY_COLORS[0];
        $$("[data-color]", root).forEach((item) => item.classList.toggle("active", item === button));
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Global bindings
  // ─────────────────────────────────────────────────────────────

  function bindGlobalEvents() {
    $("#upload-btn").addEventListener("click", () => $("#file-input").click());
    $("#zotero-btn").addEventListener("click", openZoteroModal);
    $("#api-status").addEventListener("click", () => { location.hash = "#/settings"; });
    $("#menu-toggle").addEventListener("click", openSidebar);
    $("#sidebar-scrim").addEventListener("click", closeSidebar);
    $("#file-input").addEventListener("change", (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (files.length) uploadFiles(files);
    });

    document.addEventListener("click", (event) => {
      const uploadTrigger = event.target.closest("[data-upload]");
      if (uploadTrigger) {
        event.preventDefault();
        $("#file-input").click();
        return;
      }
      const obsidianTrigger = event.target.closest("[data-obsidian-export]");
      if (obsidianTrigger) {
        event.preventDefault();
        openObsidianExportModal();
        return;
      }
      const categoryManagerTrigger = event.target.closest("[data-manage-categories]");
      if (categoryManagerTrigger) {
        event.preventDefault();
        openCategoryManager();
        return;
      }
      const cite = event.target.closest(".cite-chip");
      if (cite && cite.dataset.page) {
        event.preventDefault();
        const paperId = cite.dataset.paperId || currentPaperId();
        const page = Number(cite.dataset.page);
        if (paperId && page > 0) {
          const claimEl = cite.closest("li, p, td, th, blockquote");
          const claim = claimEl ? claimEl.innerText : "";
          App.pendingEvidence = { paperId, page, claim, ts: Date.now() };
          hideSelectionPopover();
          if (App.route.name === "paper" && App.route.id === paperId && App.route.tab === "source") {
            history.replaceState(null, "", "#/paper/" + paperId + "/source?page=" + page);
            highlightEvidenceInSource(page, claim);
          } else {
            location.hash = "#/paper/" + paperId + "/source?page=" + page;
          }
        }
      }
    });

    document.addEventListener("mouseup", handleSourceSelection);
    document.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".sel-popover")) hideSelectionPopover();
    });
    window.addEventListener("scroll", hideSelectionPopover, { passive: true });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (App.modal) { closeModal(); return; }
        hideSelectionPopover();
        closeSidebar();
        return;
      }
      if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        const search = $("#library-search");
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    });

    setupDropZone();

    window.addEventListener("beforeunload", (event) => {
      if (App.cardTask && App.cardTask.status === "streaming" ||
          App.chatTask && App.chatTask.status === "streaming" ||
          App.compareTask && App.compareTask.status === "streaming") {
        event.preventDefault();
        event.returnValue = "";
      }
      if (App.notesPending && App.paperData) {
        const payload = new Blob([JSON.stringify({ notes: App.paperData.notes || "" })], { type: "application/json" });
        navigator.sendBeacon("/api/papers/" + encodeURIComponent(App.paperData.paper.id) + "/notes", payload);
      }
      if (App.takeawayPending && App.paperData) {
        const payload = new Blob([JSON.stringify({ takeaways: App.paperData.takeaways || "" })], { type: "application/json" });
        navigator.sendBeacon("/api/papers/" + encodeURIComponent(App.paperData.paper.id) + "/takeaways", payload);
      }
    });

    window.addEventListener("unhandledrejection", (event) => {
      if (event.reason && event.reason.name !== "AbortError") {
        console.error(event.reason);
      }
    });
  }

  function setupDropZone() {
    const overlay = $("#drop-overlay");
    let depth = 0;
    const hasFiles = (event) => {
      const types = event.dataTransfer && event.dataTransfer.types;
      return types && Array.from(types).indexOf("Files") !== -1;
    };
    window.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      overlay.classList.add("visible");
      overlay.setAttribute("aria-hidden", "false");
    });
    window.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    });
    window.addEventListener("dragleave", (event) => {
      if (!hasFiles(event) && !event.dataTransfer) return;
      depth = Math.max(0, depth - 1);
      if (!depth) {
        overlay.classList.remove("visible");
        overlay.setAttribute("aria-hidden", "true");
      }
    });
    window.addEventListener("drop", (event) => {
      if (!event.dataTransfer) return;
      const files = Array.from(event.dataTransfer.files || []);
      if (!files.length) return;
      event.preventDefault();
      depth = 0;
      overlay.classList.remove("visible");
      overlay.setAttribute("aria-hidden", "true");
      uploadFiles(files);
    });
  }

  function openSidebar() {
    $("#sidebar").classList.add("open");
    $("#sidebar-scrim").classList.add("visible");
  }

  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#sidebar-scrim").classList.remove("visible");
  }

  // ─────────────────────────────────────────────────────────────
  // Routing & sidebar
  // ─────────────────────────────────────────────────────────────

  function parseRoute() {
    const raw = (location.hash || "#/library").slice(1);
    const [pathPart, queryPart] = raw.split("?");
    const parts = pathPart.split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    });
    const query = new URLSearchParams(queryPart || "");
    if (!parts.length || parts[0] === "library") return { name: "library", query };
    if (parts[0] === "paper" && parts[1]) {
      return {
        name: "paper",
        id: parts[1],
        tab: ["card", "chat", "source", "notes", "pdf"].indexOf(parts[2]) !== -1 ? parts[2] : "card",
        query,
      };
    }
    if (parts[0] === "compare" && parts[1]) return { name: "compare-detail", id: parts[1], query };
    if (parts[0] === "compare") return { name: "compare", query };
    if (parts[0] === "trash") return { name: "trash", query };
    if (parts[0] === "settings") return { name: "settings", query };
    return { name: "notfound", query };
  }

  async function renderRoute() {
    const seq = ++App.routeSeq;
    await flushNotes();
    await flushTakeaways();
    if (seq !== App.routeSeq) return;
    hideSelectionPopover();
    closeSidebar();
    const route = parseRoute();
    const previous = App.route;
    App.route = route;
    updateNav();
    updateSelectionBar();

    const tabOnly = previous.name === "paper" && route.name === "paper" &&
      previous.id === route.id && previous.tab !== route.tab;

    if (route.name === "library") {
      applyLibraryQuery(route.query);
      setTopbar("文献库");
      renderLibrary();
      document.title = "文献库 · 澜读";
    } else if (route.name === "paper") {
      await renderPaperRoute(route, seq);
    } else if (route.name === "compare") {
      setTopbar("多篇对比");
      await renderComparePage(seq);
      document.title = "多篇对比 · 澜读";
    } else if (route.name === "compare-detail") {
      setTopbar("对比综述");
      await renderCompareDetail(route, seq);
      document.title = "对比综述 · 澜读";
    } else if (route.name === "trash") {
      setTopbar("回收站");
      await renderTrashPage(seq);
      document.title = "回收站 · 澜读";
    } else if (route.name === "settings") {
      setTopbar("设置");
      renderSettings();
      document.title = "设置 · 澜读";
    } else {
      setTopbar("未找到");
      renderNotFound();
    }
    if (!tabOnly) window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    updateNav();
    updateSelectionBar();
  }

  function applyLibraryQuery(query) {
    App.library.status = query.get("status") || "all";
    App.library.tag = query.get("tag") || "";
    App.library.category = query.get("cat") || "";
    App.library.starred = query.get("starred") === "1";
    App.library.withCard = query.get("card") === "1";
    if (!["unread", "reading", "read"].includes(App.library.status)) App.library.status = "all";
    const validCategory = App.library.category === "__uncategorized__" || categoryById(App.library.category);
    if (!validCategory) App.library.category = "";
  }

  function updateNav() {
    const route = App.route;
    const libraryActive = route.name === "library" || route.name === "paper";
    const compareActive = route.name === "compare" || route.name === "compare-detail";
    $$("[data-nav]").forEach((link) => {
      const name = link.dataset.nav;
      const active = (name === "library" && libraryActive) ||
        (name === "compare" && compareActive) ||
        (name === "trash" && route.name === "trash") ||
        (name === "settings" && route.name === "settings");
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $$("[data-status]").forEach((link) => {
      const active = route.name === "library" && App.library.status === link.dataset.status &&
        !App.library.tag && !App.library.category && !App.library.starred && !App.library.withCard;
      link.classList.toggle("active", active);
    });
    $$("#tag-nav .side-link").forEach((link) => {
      const active = route.name === "library" && link.dataset.tag === App.library.tag;
      link.classList.toggle("active", active);
    });
    $$("#category-nav [data-category]").forEach((link) => {
      const active = route.name === "library" && link.dataset.category === App.library.category;
      link.classList.toggle("active", active);
    });
  }

  function renderSidebar() {
    const stats = App.stats || {};
    const total = $("#nav-total");
    if (total) total.textContent = stats.total || 0;
    const trashTotal = $("#nav-trash-count");
    if (trashTotal) trashTotal.textContent = App.trashCount || 0;
    $$("[data-count]").forEach((el) => {
      el.textContent = stats[el.dataset.count] || 0;
    });

    const categoryNav = $("#category-nav");
    if (categoryNav) {
      const categories = Array.isArray(stats.categories) ? stats.categories : [];
      if (categories.length) {
        categoryNav.innerHTML = categories.map((category) =>
          '<a class="side-link category-link" href="#/library?cat=' + encodeURIComponent(category.id) +
          '" data-category="' + esc(category.id) + '" title="' + esc(category.name) + '">' + categoryDot(category.color) +
          '<span class="category-name">' + esc(category.name) + '</span><span class="side-count">' + (category.count || 0) + "</span></a>"
        ).join("") +
          '<a class="side-link category-link" href="#/library?cat=__uncategorized__" data-category="__uncategorized__">' +
          '<span class="category-dot uncategorized"></span><span>未分类</span>' +
          '<span class="side-count">' + (stats.uncategorized || 0) + "</span></a>";
      } else {
        categoryNav.innerHTML = '<button type="button" class="category-empty" data-manage-categories>' +
          "按研究方向分类 · 新建</button>";
      }
    }

    const tagNav = $("#tag-nav");
    if (tagNav) {
      const tags = (stats.tags || []).slice(0, 9);
      tagNav.innerHTML = tags.length
        ? tags.map(([tag, count]) => (
          '<a class="side-link" href="#/library?tag=' + encodeURIComponent(tag) + '" data-tag="' + esc(tag) + '">' +
          '<span class="tag-pip"></span><span>' + esc(tag) + '</span>' +
          '<span class="side-count">' + count + "</span></a>"
        )).join("")
        : '<div class="tag-empty">题录标签会出现在这里</div>';
    }

    const dot = $("#api-dot");
    const label = $("#api-label");
    const statusButton = $("#api-status");
    if (dot && label && statusButton) {
      const ready = aiReady();
      dot.className = "status-dot " + (ready ? "ok" : "warn");
      statusButton.classList.toggle("configured", ready);
      if (ready) {
        label.textContent = providerLabel(App.settings.provider) + " · " + (App.settings.model || "已配置");
      } else {
        label.textContent = "AI 尚未配置";
      }
    }
    updateNav();
  }

  function renderBootError(message) {
    const view = $("#view");
    setTopbar("连接失败");
    view.innerHTML =
      '<div class="page"><div class="empty-state">' +
      '<div class="empty-art">' + icon("alert") + "</div>" +
      "<h3>本地服务没有响应</h3>" +
      "<p>" + esc(message) + "。请确认启动窗口仍在运行，然后重试。</p>" +
      '<div class="empty-actions"><button class="btn btn-primary" id="boot-retry">重新连接</button></div>' +
      "</div></div>";
    $("#boot-retry").addEventListener("click", async () => {
      try {
        await refreshState();
        await renderRoute();
      } catch (error) {
        toast(error.message, "error");
      }
    });
  }

  function renderNotFound() {
    $("#view").innerHTML =
      '<div class="page"><div class="empty-state">' +
      '<div class="empty-art">' + icon("layers") + "</div>" +
      "<h3>这里没有内容</h3><p>链接可能已经失效，回到文献库继续阅读吧。</p>" +
      '<div class="empty-actions"><a class="btn btn-primary" href="#/library">回到文献库</a></div>' +
      "</div></div>";
  }

  // ─────────────────────────────────────────────────────────────
  // Library
  // ─────────────────────────────────────────────────────────────

  function libraryEmptyArt() {
    return '<svg viewBox="0 0 240 150" fill="none" aria-hidden="true">' +
      '<path d="M32 113c20-12 34-12 54 0s34 12 54 0 34-12 64-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".38"/>' +
      '<path d="M17 128c23-13 39-13 62 0s39 13 62 0 39-13 75-1" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".2"/>' +
      '<path d="M70 70c0-20 9-35 27-45 15 7 26 20 26 38v45H84c-9 0-14-6-14-14z" stroke="currentColor" stroke-width="1.5" opacity=".55"/>' +
      '<path d="M170 63c0-15-7-27-21-35-11 6-19 16-19 30v50h28c8 0 12-5 12-12z" stroke="currentColor" stroke-width="1.5" opacity=".45"/>' +
      '<path d="M123 63v43M104 77l-18-9M143 72l17-9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".5"/>' +
      '<circle cx="123" cy="32" r="3" fill="currentColor" opacity=".45"/>' +
      '<path d="M119 132h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".35"/>' +
      "</svg>";
  }

  function filteredPapers() {
    let items = App.papers.slice();
    const filter = App.library;
    const knownCategories = categoryMap();
    if (filter.status !== "all") items = items.filter((paper) => (paper.status || "unread") === filter.status);
    if (filter.tag) items = items.filter((paper) => (paper.tags || []).indexOf(filter.tag) !== -1);
    if (filter.category === "__uncategorized__") {
      items = items.filter((paper) => !(paper.categories || []).some((categoryId) => knownCategories.has(categoryId)));
    } else if (filter.category) {
      items = items.filter((paper) => (paper.categories || []).indexOf(filter.category) !== -1);
    }
    if (filter.starred) items = items.filter((paper) => paper.starred);
    if (filter.withCard) items = items.filter((paper) => paper.card_updated_at);
    const query = filter.q.trim().toLowerCase();
    if (query) {
      items = items.filter((paper) => {
        const haystack = [
          paper.title, paper.venue, paper.year, paper.summary, paper.abstract,
          (paper.authors || []).join(" "), (paper.tags || []).join(" "),
          (paper.categories || []).map((categoryId) => (knownCategories.get(categoryId) || {}).name || "").join(" "),
        ].join(" ").toLowerCase();
        return haystack.indexOf(query) !== -1;
      });
    }
    if (filter.sort === "year") {
      items.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || String(a.title).localeCompare(String(b.title), "zh"));
    } else if (filter.sort === "title") {
      items.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh"));
    } else {
      items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    }
    return items;
  }

  function renderLibrary() {
    const view = $("#view");
    if (!App.papers.length) {
      const setupNotice = !aiReady()
        ? '<div class="notice">' + icon("sparkles") +
          "<span>AI 还没有配置。解析、阅读和 Zotero 导入都可以先做；生成精读卡与追问需要先完成模型设置。</span>" +
          '<a href="#/settings">去配置</a></div>'
        : "";
      view.innerHTML =
        '<div class="page">' + libraryHero(true) + setupNotice +
        '<section class="starter-panel">' +
        '<div class="starter-head"><div class="kicker">START HERE / 开始使用</div>' +
        "<h2>一条从 PDF 到可用知识的路径</h2>" +
        "<p>不是再做一个 PDF 阅读器，而是让每篇论文都留下可检索、可追问、可横向比较的结构化理解。</p></div>" +
        '<div class="starter-steps">' +
        '<div class="starter-step"><span class="step-no">01 / 导入</span><h3>放入文献</h3><p>拖入文本版 PDF，或从本机 Zotero 直接读取题录和全文。重复文献会自动识别。</p></div>' +
        '<div class="starter-step"><span class="step-no">02 / 精读</span><h3>拆开论文</h3><p>AI 提取核心问题、真实创新、研究设计、关键证据与局限，每条判断尽量落到页码。</p></div>' +
        '<div class="starter-step"><span class="step-no">03 / 使用</span><h3>追问与综合</h3><p>沿页码回原文追问，生成组会提纲和公众号初稿，也可以把几篇论文放在一起比较。</p></div>' +
        "</div>" +
        '<div class="starter-actions"><button type="button" class="btn btn-primary" data-upload>' + icon("upload") + "上传第一篇文献</button>" +
        '<button type="button" class="btn" id="empty-zotero">' + icon("layers") + "从 Zotero 导入</button>" +
        '<button type="button" class="btn btn-quiet" id="empty-demo">' + icon("sparkles") + "先看看示例</button>" +
        '<a class="btn btn-quiet" href="#/settings">' + icon("gear") + "配置模型</a></div>" +
        "</section></div>";
      bindLibraryHero();
      const zotero = $("#empty-zotero");
      if (zotero) zotero.addEventListener("click", openZoteroModal);
      const demo = $("#empty-demo");
      if (demo) demo.addEventListener("click", () => importDemo(true));
      updateNav();
      return;
    }
    const filtered = filteredPapers();
    const notice = !aiReady()
      ? '<div class="notice">' + icon("sparkles") +
        "<span>AI 还没有配置。上传、解析和阅读原文都可正常使用；生成精读卡与追问需要先完成模型设置。</span>" +
        '<a href="#/settings">去配置</a></div>'
      : "";
    view.innerHTML =
      '<div class="page">' +
      libraryHero(false) +
      notice +
      "<div class=\"library-toolbar\">" +
      '<div class="filter-chips" id="filter-chips">' +
      libraryChips() +
      "</div>" +
      '<div class="toolbar-spacer"></div>' +
      '<div class="toolbar-right">' +
      '<label class="search-field">' + icon("search") +
      '<input id="library-search" type="search" placeholder="搜索标题、作者、期刊、分类或标签" value="' + esc(App.library.q) + '" aria-label="搜索文献">' +
      "</label>" +
      '<select class="sort-select" id="library-sort" aria-label="排序">' +
      option("recent", "最近添加", App.library.sort) +
      option("year", "发表年份", App.library.sort) +
      option("title", "标题", App.library.sort) +
      "</select>" +
      "</div></div>" +
      '<div class="result-line"><span id="result-count">' + resultCountText(filtered.length) + "</span>" +
      '<span class="select-tools"><span class="select-hint">勾选文献可对比或批量删除</span>' +
      '<button type="button" class="select-visible" id="select-visible">全选当前</button></span></div>' +
      '<div class="paper-list" id="paper-list">' + paperListHTML(filtered) + "</div>" +
      "</div>";
    bindLibraryHero();
    bindLibraryInteractions();
    updateNav();
    updateSelectionBar();
    updateSelectVisibleLabel();
  }

  function libraryHero(isEmpty) {
    const stats = App.stats || {};
    return '<section class="hero">' +
      '<div class="hero-copy">' +
      '<div class="kicker">LIBRARY / ' + (isEmpty ? "开始阅读" : "文献库") + "</div>" +
      '<h1 class="hero-title">把一篇论文，<br><em>读成自己的知识。</em></h1>' +
      '<p class="hero-lede">AI 先替你拆开问题、方法、证据与局限；每一条判断都能沿着页码回到原文。这里不做泛泛摘要，只做可以带进组会和论文里的精读。</p>' +
      '<div class="hero-stats">' +
      '<div class="hero-stat"><strong>' + (stats.total || 0) + "</strong><span>篇在库</span></div>" +
      '<div class="hero-stat"><strong>' + (stats.with_card || 0) + "</strong><span>篇已精读</span></div>" +
      '<div class="hero-stat"><strong>' + (stats.reading || 0) + "</strong><span>篇在读</span></div>" +
      "</div></div>" +
      '<div class="upload-panel" id="upload-panel" role="button" tabindex="0" aria-label="上传 PDF 文献">' +
      '<div class="upload-icon">' + icon("upload") + "</div>" +
      '<div class="upload-copy">拖入 PDF，或<span>点击上传</span></div>' +
      '<div class="upload-hint">文本版英文期刊效果最好。上传后自动补全题录，并可一键生成带页码证据的精读卡。</div>' +
      '<div class="upload-cta">' + (isEmpty ? "导入第一篇文献" : "继续扩充文献库") + " " + icon("arrow-left", "rotate-180") + "</div>" +
      "</div></section>";
  }

  function resultCountText(count) {
    if (App.library.q) return "找到 " + count + " 篇";
    return "共 " + count + " 篇";
  }

  function option(value, label, current) {
    return '<option value="' + esc(value) + '"' + (current === value ? " selected" : "") + ">" + esc(label) + "</option>";
  }

  function libraryChips() {
    const stats = App.stats || {};
    const filter = App.library;
    const chips = [
      { key: "all", label: "全部", count: stats.total || 0 },
      { key: "unread", label: "待读", count: stats.unread || 0 },
      { key: "reading", label: "在读", count: stats.reading || 0 },
      { key: "read", label: "已读", count: stats.read || 0 },
      { key: "card", label: "有精读卡", count: stats.with_card || 0 },
      { key: "starred", label: "星标", count: stats.starred || 0 },
    ];
    let html = chips.map((chip) => {
      let active = false;
      if (chip.key === "all") active = filter.status === "all" && !filter.starred && !filter.withCard && !filter.tag && !filter.category;
      else if (["unread", "reading", "read"].indexOf(chip.key) !== -1) {
        active = filter.status === chip.key && !filter.starred && !filter.withCard && !filter.tag && !filter.category;
      } else if (chip.key === "card") active = !!filter.withCard && !filter.category;
      else if (chip.key === "starred") active = !!filter.starred && !filter.category;
      return '<button type="button" class="chip' + (active ? " active" : "") + '" data-filter="' + chip.key + '">' +
        esc(chip.label) + '<span class="count">' + (chip.count || 0) + "</span></button>";
    }).join("");
    if (filter.category) {
      if (filter.category === "__uncategorized__") {
        html += '<button type="button" class="chip active" data-filter="clear-category">未分类' +
          ' <span aria-hidden="true">×</span></button>';
      } else {
        const category = categoryById(filter.category);
        if (category) {
          html += '<button type="button" class="chip active category-filter-chip" data-filter="clear-category">' +
            categoryDot(category.color) + esc(category.name) + ' <span aria-hidden="true">×</span></button>';
        }
      }
    }
    if (filter.tag) {
      html += '<button type="button" class="chip active" data-filter="clear-tag">#' + esc(filter.tag) +
        ' <span aria-hidden="true">×</span></button>';
    }
    return html;
  }

  function paperListHTML(items) {
    if (!items.length) {
      return '<div class="empty-state" style="min-height:240px">' +
        '<div class="empty-art" style="width:150px">' + libraryEmptyArt() + "</div>" +
        "<h3>没有匹配的文献</h3><p>换一个筛选条件或搜索词试试。</p>" +
        '<div class="empty-actions"><button class="btn btn-sm" data-clear-filters>清除筛选</button></div>' +
        "</div>";
    }
    return items.map(paperRowHTML).join("");
  }

  function paperRowHTML(paper) {
    const selected = App.selected.has(paper.id);
    const activeTask = App.cardTask && App.cardTask.paperId === paper.id && App.cardTask.status === "streaming";
    const summary = plainSummary(paper);
    const tags = (paper.tags || []).slice(0, 5);
    const knownCategories = categoryMap();
    const categories = (paper.categories || []).map((categoryId) => knownCategories.get(categoryId)).filter(Boolean);
    const demoTag = paper.demo ? '<span class="tag demo-tag">示例</span>' : "";
    const metaParts = [
      esc(formatAuthors(paper.authors, 3)),
      (paper.venue ? '<span class="venue">' + esc(paper.venue) + "</span>" : ""),
      esc(paper.year || "年份未知"),
      esc((paper.page_count || "?") + " 页"),
    ].filter(Boolean);
    return '<article class="paper-row' + (selected ? " selected" : "") + '" data-paper-id="' + esc(paper.id) + '">' +
      '<label class="paper-check" title="选择文献（可对比或批量删除）">' +
      '<input type="checkbox" data-select-paper' + (selected ? " checked" : "") + ' aria-label="选择这篇文献"></label>' +
      '<div class="paper-main">' +
      '<a class="paper-title" href="#/paper/' + esc(paper.id) + '/card">' + esc(paper.title || "未命名文献") + "</a>" +
      '<div class="paper-meta">' + metaParts.join('<span class="sep">·</span>') + "</div>" +
      '<p class="paper-summary' + (summary ? "" : " placeholder") + '">' +
      esc(summary || "尚未生成精读卡。打开后可让 AI 拆解核心问题、方法、证据与结论。") + "</p>" +
      (categories.length ? '<div class="paper-categories">' + categories.map(categoryChipHtml).join("") + "</div>" : "") +
      (demoTag || tags.length ? '<div class="paper-tags">' + demoTag + tags.map((tag) =>
        '<a class="tag" href="#/library?tag=' + encodeURIComponent(tag) + '">' + esc(tag) + "</a>").join("") + "</div>" : "") +
      "</div>" +
      '<div class="paper-side">' +
      '<span class="status-pill ' + esc(paper.status || "unread") + '">' + esc(STATUS_LABELS[paper.status] || "待读") + "</span>" +
      (activeTask
        ? '<span class="card-state"><span class="spinner" style="width:11px;height:11px;border-width:1px"></span>生成中</span>'
        : paper.card_updated_at
          ? '<span class="card-state">' + icon("sparkles") + "精读卡</span>"
          : '<span class="card-state pending">待精读</span>') +
      '<button type="button" class="category-row-btn' + (categories.length ? " active" : "") + '" data-categorize="' + esc(paper.id) + '" title="设置分类" aria-label="设置分类">' +
      icon("layers") + "<span>分类</span></button>" +
      '<button type="button" class="star-btn' + (paper.starred ? " active" : "") + '" data-star="' + esc(paper.id) + '" aria-label="' +
      (paper.starred ? "取消星标" : "加入星标") + '" aria-pressed="' + (paper.starred ? "true" : "false") + '">' + icon("star") + "</button>" +
      "</div></article>";
  }

  function bindLibraryHero() {
    const panel = $("#upload-panel");
    if (panel) {
      panel.addEventListener("click", () => $("#file-input").click());
      panel.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          $("#file-input").click();
        }
      });
    }
  }

  function bindLibraryInteractions() {
    const chips = $("#filter-chips");
    if (chips) {
      chips.addEventListener("click", (event) => {
        const button = event.target.closest("[data-filter]");
        if (!button) return;
        const key = button.dataset.filter;
        if (key === "clear-tag") {
          App.library.tag = "";
        } else if (key === "clear-category") {
          App.library.category = "";
        } else if (key === "all") {
          App.library.status = "all"; App.library.tag = ""; App.library.category = ""; App.library.starred = false; App.library.withCard = false;
        } else if (key === "card") {
          App.library.status = "all"; App.library.tag = ""; App.library.category = ""; App.library.starred = false; App.library.withCard = true;
        } else if (key === "starred") {
          App.library.status = "all"; App.library.tag = ""; App.library.category = ""; App.library.starred = true; App.library.withCard = false;
        } else {
          App.library.status = key; App.library.tag = ""; App.library.category = ""; App.library.starred = false; App.library.withCard = false;
        }
        replaceLibraryHash();
        renderLibrary();
      });
    }
    const search = $("#library-search");
    if (search) {
      search.addEventListener("input", debounce(() => {
        App.library.q = search.value;
        updatePaperList();
      }, 140));
    }
    const sort = $("#library-sort");
    if (sort) sort.addEventListener("change", () => {
      App.library.sort = sort.value;
      updatePaperList();
    });

    const list = $("#paper-list");
    if (list) {
      list.addEventListener("click", (event) => {
        const star = event.target.closest("[data-star]");
        if (star) {
          event.preventDefault();
          event.stopPropagation();
          toggleStar(star.dataset.star);
          return;
        }
        const categorize = event.target.closest("[data-categorize]");
        if (categorize) {
          event.preventDefault();
          event.stopPropagation();
          openCategoryAssignModal(categorize.dataset.categorize);
          return;
        }
        const tag = event.target.closest("a.tag");
        if (tag) return;
        if (event.target.closest("a.category-chip")) return;
        if (event.target.closest(".paper-check")) return;
        const row = event.target.closest(".paper-row");
        if (row) {
          event.preventDefault();
          location.hash = "#/paper/" + row.dataset.paperId + "/card";
        }
      });
      list.addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-select-paper]");
        if (!checkbox) return;
        const row = checkbox.closest(".paper-row");
        const id = row.dataset.paperId;
        if (checkbox.checked) {
          App.selected.add(id);
          row.classList.add("selected");
        } else {
          App.selected.delete(id);
          row.classList.remove("selected");
        }
        updateSelectionBar();
        updateSelectVisibleLabel();
      });
    }
    const selectVisible = $("#select-visible");
    if (selectVisible) selectVisible.addEventListener("click", toggleVisibleSelection);
    const clearFilters = $("[data-clear-filters]");
    if (clearFilters) {
      clearFilters.addEventListener("click", () => {
        App.library = { q: "", status: "all", tag: "", category: "", starred: false, withCard: false, sort: App.library.sort };
        replaceLibraryHash();
        renderLibrary();
      });
    }
  }

  function updatePaperList() {
    const list = $("#paper-list");
    if (!list) return;
    const filtered = filteredPapers();
    list.innerHTML = paperListHTML(filtered);
    const count = $("#result-count");
    if (count) count.textContent = resultCountText(filtered.length);
    const search = $("#library-search");
    if (search && search.value !== App.library.q) search.value = App.library.q;
    updateSelectionBar();
    updateSelectVisibleLabel();
  }

  function updateSelectVisibleLabel() {
    const button = $("#select-visible");
    if (!button) return;
    const items = filteredPapers();
    const allSelected = items.length > 0 && items.every((paper) => App.selected.has(paper.id));
    button.textContent = allSelected ? "取消全选" : "全选当前";
    button.disabled = !items.length || App.deleting;
  }

  function toggleVisibleSelection() {
    const items = filteredPapers();
    if (!items.length || App.deleting) return;
    const allSelected = items.every((paper) => App.selected.has(paper.id));
    items.forEach((paper) => {
      if (allSelected) App.selected.delete(paper.id);
      else App.selected.add(paper.id);
    });
    updatePaperList();
  }

  function replaceLibraryHash() {
    const params = new URLSearchParams();
    if (App.library.status !== "all") params.set("status", App.library.status);
    if (App.library.tag) params.set("tag", App.library.tag);
    if (App.library.category) params.set("cat", App.library.category);
    if (App.library.starred) params.set("starred", "1");
    if (App.library.withCard) params.set("card", "1");
    const suffix = params.toString();
    history.replaceState(null, "", "#/library" + (suffix ? "?" + suffix : ""));
  }

  async function toggleStar(paperId) {
    const paper = App.papers.find((item) => item.id === paperId);
    if (!paper) return;
    const next = !paper.starred;
    paper.starred = next;
    try {
      await api("/api/papers/" + paperId, { method: "PATCH", body: { starred: next } });
      if (App.paperData && App.paperData.paper.id === paperId) App.paperData.paper.starred = next;
      await refreshState(true);
      updateStarButtons(paperId, next);
      updatePaperList();
      if (App.route.name === "paper" && currentPaperId() === paperId) updateDetailStar(next);
    } catch (error) {
      paper.starred = !next;
      toast(error.message, "error");
    }
  }

  function updateStarButtons(paperId, starred) {
    $$('[data-star="' + paperId + '"]').forEach((button) => {
      button.classList.toggle("active", starred);
      button.setAttribute("aria-pressed", starred ? "true" : "false");
      button.setAttribute("aria-label", starred ? "取消星标" : "加入星标");
    });
  }

  function updateDetailStar(starred) {
    const button = $("#detail-star");
    if (!button) return;
    button.classList.toggle("active", starred);
    button.innerHTML = icon("star");
    button.setAttribute("aria-pressed", starred ? "true" : "false");
  }

  // ─────────────────────────────────────────────────────────────
  // Selection bar
  // ─────────────────────────────────────────────────────────────

  function ensureSelectionBar() {
    if ($("#selection-bar")) return;
    const bar = document.createElement("div");
    bar.id = "selection-bar";
    bar.className = "selection-bar";
    bar.innerHTML =
      '<span class="sel-count"><strong id="sel-count-num">0</strong>篇已选 <span id="sel-count-hint"></span></span>' +
      '<button type="button" class="btn btn-sm" id="sel-category">' + icon("layers") + "分类</button>" +
      '<button type="button" class="btn btn-sm sel-delete" id="sel-delete">' + icon("trash") + "删除</button>" +
      '<button type="button" class="btn btn-primary" id="sel-compare">开始对比</button>' +
      '<button type="button" class="clear-sel" id="sel-clear">取消</button>';
    document.body.appendChild(bar);
    $("#sel-clear").addEventListener("click", () => {
      if (App.deleting) return;
      App.selected.clear();
      if (App.route.name === "library") renderLibrary();
      updateSelectionBar();
    });
    const categoryButton = $("#sel-category");
    if (categoryButton) categoryButton.addEventListener("click", openBulkCategoryAssignModal);
    $("#sel-delete").addEventListener("click", bulkDeleteSelected);
    $("#sel-compare").addEventListener("click", () => {
      if (App.selected.size < 2) {
        toast("至少选择 2 篇文献", "info");
        return;
      }
      if (App.selected.size > 5) {
        toast("对比最多 5 篇，请先取消多余的选择", "info");
        return;
      }
      location.hash = "#/compare";
    });
  }

  function updateSelectionBar() {
    const bar = $("#selection-bar");
    if (!bar) return;
    const count = App.selected.size;
    const visible = App.route.name === "library" && count > 0;
    bar.classList.toggle("visible", visible);
    const num = $("#sel-count-num");
    const hint = $("#sel-count-hint");
    const compareButton = $("#sel-compare");
    const deleteButton = $("#sel-delete");
    const categoryButton = $("#sel-category");
    if (num) num.textContent = count;
    if (hint) {
      hint.textContent = count < 2
        ? "可分类；再选 1 篇可对比"
        : count > 5
          ? "可分类、批量删除；对比最多 5 篇"
          : "可分类、对比或批量删除";
    }
    if (categoryButton) categoryButton.disabled = count === 0 || App.deleting;
    if (compareButton) {
      compareButton.disabled = count < 2 || count > 5 || App.deleting;
      compareButton.title = count > 5 ? "对比最多 5 篇，请先取消多余选择" : "打开多篇对比";
    }
    if (deleteButton) {
      deleteButton.disabled = count === 0 || App.deleting;
      deleteButton.innerHTML = App.deleting
        ? '<span class="spinner" style="width:11px;height:11px;border-width:1px"></span>删除中…'
        : icon("trash") + "删除";
      deleteButton.title = "将选中的文献移入回收站（不会改动 Zotero 原库）";
    }
    const clearButton = $("#sel-clear");
    if (clearButton) clearButton.disabled = App.deleting;
    updateSelectVisibleLabel();
  }

  async function bulkDeleteSelected() {
    if (App.deleting) return;
    const ids = Array.from(App.selected);
    if (!ids.length) return;
    if (ids.length > 200) {
      toast("一次最多删除 200 篇文献", "info");
      return;
    }
    const papers = ids.map((id) => App.papers.find((paper) => paper.id === id)).filter(Boolean);
    const titles = papers.slice(0, 6).map((paper) => "《" + (paper.title || "未命名文献") + "》").join("\n");
    const extra = papers.length > 6 ? "\n……以及另外 " + (papers.length - 6) + " 篇" : "";
    const confirmed = await confirmDialog({
      title: "将选中的 " + ids.length + " 篇文献移入回收站？",
      message: "会连同 PDF 副本、精读卡、追问记录和笔记一起移入回收站，可在「回收站」中恢复。\n不会改动 Zotero 原始库。\n\n" + titles + extra,
      confirmText: "移入回收站",
      danger: false,
    });
    if (!confirmed) return;
    App.deleting = true;
    updateSelectionBar();
    let result;
    try {
      result = await api("/api/papers/bulk-trash", { method: "POST", body: { ids } });
    } catch (error) {
      App.deleting = false;
      updateSelectionBar();
      toast("移入回收站失败：" + error.message, "error");
      return;
    }
    const trashed = Array.isArray(result.trashed) ? result.trashed : [];
    const missing = Array.isArray(result.missing) ? result.missing : [];
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const removed = new Set(trashed.concat(missing));
    if (removed.size) {
      abortTasksForPapers(removed);
      removed.forEach((id) => App.selected.delete(id));
      if (App.paperData && removed.has(App.paperData.paper.id)) {
        App.paperData = null;
        App.pages = null;
        App.pagesPaperId = null;
      }
    }
    await flushNotes();
    try { await refreshState(); } catch (_) { /* keep local state */ }
    App.deleting = false;
    updateSelectionBar();
    if (App.route.name === "library") {
      await renderRoute();
    } else if (App.paperData && removed.has(App.paperData.paper.id)) {
      location.hash = "#/library";
    } else {
      renderSidebar();
    }
    const failedNote = failed.length
      ? "；" + failed.length + " 篇未能移入（PDF 可能正在阅读器中打开，关闭后重试）"
      : "";
    if (removed.size) {
      toast("已将 " + removed.size + " 篇文献移入回收站" + failedNote, failed.length ? "info" : "success", 6500);
    } else {
      toast("没有文献被移入回收站" + (failedNote || "，请稍后重试"), "error", 6500);
    }
  }

  function abortTasksForPapers(ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    if (App.cardTask && set.has(App.cardTask.paperId)) {
      App.cardTask.status = "aborted";
      if (App.cardTask.controller) App.cardTask.controller.abort();
      App.cardTask = null;
    }
    if (App.chatTask && set.has(App.chatTask.paperId)) {
      App.chatTask.status = "aborted";
      if (App.chatTask.controller) App.chatTask.controller.abort();
      App.chatTask = null;
    }
    if (App.compareTask && (App.compareTask.paperIds || []).some((id) => set.has(id))) {
      App.compareTask.status = "aborted";
      if (App.compareTask.controller) App.compareTask.controller.abort();
      App.compareTask = null;
    }
    refreshTabBadges();
  }

  // ─────────────────────────────────────────────────────────────
  // Upload
  // ─────────────────────────────────────────────────────────────

  async function uploadFiles(files) {
    if (App.uploading) {
      toast("正在解析上一批文献，请稍候", "info");
      return;
    }
    const valid = files.filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!valid.length) {
      toast("请拖入 PDF 文件", "error");
      return;
    }
    if (valid.some((file) => file.size > 120 * 1024 * 1024)) {
      toast("单个 PDF 不能超过 120 MB", "error");
      return;
    }
    App.uploading = true;
    setUploadBusy(true, valid.length > 1 ? "正在解析 1/" + valid.length : "正在解析 PDF");
    const created = [];
    const errors = [];
    for (let index = 0; index < valid.length; index += 1) {
      const file = valid[index];
      setUploadBusy(true, valid.length > 1
        ? "正在解析 " + (index + 1) + "/" + valid.length
        : "正在解析 PDF");
      try {
        const data = await api("/api/papers", {
          method: "POST",
          headers: {
            "Content-Type": "application/pdf",
            "X-Filename": encodeURIComponent(file.name),
          },
          body: file,
        });
        created.push(Object.assign({}, data.paper, { _duplicate: !!data.duplicate }));
      } catch (error) {
        errors.push(file.name + "：" + error.message);
      }
    }
    App.uploading = false;
    setUploadBusy(false);
    try { await refreshState(); } catch (_) { /* keep going */ }
    errors.slice(0, 3).forEach((message) => toast(message, "error", 6500));
    if (!created.length) {
      if (!errors.length) toast("没有导入任何文献", "error");
      return;
    }
    if (created.length === 1) {
      const paper = created[0];
      if (paper._duplicate) {
        toast("文献库中已有这篇，已为你打开", "info");
        location.hash = "#/paper/" + paper.id + "/card";
      } else {
        const auto = App.settings.auto_analyze && aiReady();
        location.hash = "#/paper/" + paper.id + "/card" + (auto ? "?analyze=1" : "");
      }
    } else {
      toast("已导入 " + created.length + " 篇文献", "success");
      if (App.route.name === "library") renderRoute();
      else location.hash = "#/library";
    }
  }

  function setUploadBusy(busy, label) {
    const button = $("#upload-btn");
    if (button) {
      button.disabled = busy;
      const span = button.querySelector("span");
      if (span) span.textContent = busy ? (label || "解析中…") : "上传 PDF";
      const svg = button.querySelector("svg");
      if (svg) svg.classList.toggle("spin", busy);
    }
    const panel = $("#upload-panel");
    if (panel) panel.classList.toggle("busy", busy);
  }

  // ─────────────────────────────────────────────────────────────
  // Paper detail
  // ─────────────────────────────────────────────────────────────

  async function renderPaperRoute(route, seq) {
    const view = $("#view");
    setTopbar("精读空间");
    if (!App.paperData || App.paperData.paper.id !== route.id) {
      view.innerHTML = '<div class="page-detail"><div class="loading-page"><span class="spinner"></span>正在打开文献…</div></div>';
      try {
        const data = await api("/api/papers/" + route.id);
        if (seq !== App.routeSeq) return;
        App.paperData = data;
        App.pages = null;
        App.pagesPaperId = null;
        App.pdfPageByPaper[route.id] = App.pdfPageByPaper[route.id] || 1;
      } catch (error) {
        if (seq !== App.routeSeq) return;
        view.innerHTML = '<div class="page"><div class="empty-state">' +
          '<div class="empty-art">' + icon("alert") + "</div>" +
          "<h3>无法打开这篇文献</h3><p>" + esc(error.message) + "</p>" +
          '<div class="empty-actions"><a class="btn" href="#/library">回到文献库</a></div>' +
          "</div></div>";
        return;
      }
    }
    if (seq !== App.routeSeq) return;
    renderPaperShell(route.tab);
    if (route.tab === "source") {
      await renderSourceTab(route.query.get("page"));
    } else if (route.tab === "chat") {
      requestAnimationFrame(() => {
        scrollChatIntoView();
        scrollChatToBottom(false);
      });
    }
    if (route.tab === "card" && route.query.get("analyze") === "1") {
      history.replaceState(null, "", "#/paper/" + route.id + "/card");
      if (App.settings.auto_analyze && aiReady() && !App.paperData.card &&
          !(App.cardTask && App.cardTask.paperId === route.id && App.cardTask.status === "streaming")) {
        setTimeout(() => startCardGeneration(route.id), 160);
      }
    }
    updateNav();
  }

  function renderPaperShell(tab) {
    const data = App.paperData;
    const paper = data.paper;
    const cardRunning = App.cardTask && App.cardTask.paperId === paper.id && App.cardTask.status === "streaming";
    const chatRunning = App.chatTask && App.chatTask.paperId === paper.id && App.chatTask.status === "streaming";
    const kickerParts = [];
    if (paper.venue) kickerParts.push(esc(paper.venue));
    if (paper.year) kickerParts.push(esc(paper.year));
    if (paper.source === "zotero") kickerParts.push("Zotero 导入");
    if (paper.demo) kickerParts.push("内置示例");
    if (!kickerParts.length) kickerParts.push("未识别来源");

    const tabs = [
      { key: "card", label: "精读卡", iconName: "sparkles", active: !!paper.card_updated_at, running: cardRunning },
      { key: "chat", label: "追问", iconName: "chat", active: (data.chat || []).length > 0, running: chatRunning },
      { key: "source", label: "原文", iconName: "file" },
      { key: "notes", label: "笔记", iconName: "note", active: !!data.notes },
      { key: "pdf", label: "PDF", iconName: "pdf" },
    ];

    const warnings = [];
    if (paper.scanned) warnings.push("这份 PDF 可能是扫描件，没有足够的文字层，AI 精读会受到限制。");
    (paper.warnings || []).forEach((warning) => warnings.push(warning));

    const tags = (paper.tags || []).map((tag) =>
      '<a class="tag" href="#/library?tag=' + encodeURIComponent(tag) + '">' + esc(tag) + "</a>").join("");
    const knownCategories = categoryMap();
    const paperCategories = (paper.categories || []).map((categoryId) => knownCategories.get(categoryId)).filter(Boolean);
    const categoryRow = '<div class="detail-categories">' +
      (paperCategories.length
        ? paperCategories.map(categoryChipHtml).join("")
        : '<span class="detail-category-empty">未分类</span>') +
      '<button type="button" class="category-add" id="edit-categories">' + icon("layers") +
      (paperCategories.length ? "调整分类" : "添加分类") + "</button></div>";

    $("#view").innerHTML =
      '<div class="page page-detail">' +
      '<a class="back-link" href="#/library">' + icon("arrow-left") + "文献库</a>" +
      '<header class="detail-head">' +
      '<div class="detail-kicker">' + kickerParts.join('<span class="dot"></span>') + "</div>" +
      '<div class="detail-title-row"><h1 class="detail-title">' + esc(paper.title || "未命名文献") + "</h1>" +
      '<button type="button" class="star-btn' + (paper.starred ? " active" : "") + '" id="detail-star" aria-label="' +
      (paper.starred ? "取消星标" : "加入星标") + '" aria-pressed="' + (paper.starred ? "true" : "false") + '">' + icon("star") + "</button></div>" +
      '<p class="detail-authors">' + esc(formatAuthors(paper.authors, 20)) + "</p>" +
      '<div class="detail-meta">' +
      '<span class="meta-item">' + icon("file") + (paper.page_count || "?") + " 页</span>" +
      (paper.doi ? '<span class="meta-item">' + icon("link") + '<a href="https://doi.org/' + esc(encodeURI(paper.doi)) + '" target="_blank" rel="noopener">' + esc(paper.doi) + "</a></span>" : "") +
      (paper.pdf_filename ? '<span class="meta-item" title="原始文件名">' + icon("pdf") + esc(paper.pdf_filename) + "</span>" : "") +
      "</div>" +
      (tags ? '<div class="detail-tags">' + tags + "</div>" : "") +
      categoryRow +
      '<div class="detail-actions">' +
      '<span class="status-select-wrap"><select class="status-select" id="detail-status" aria-label="阅读状态">' +
      ["unread", "reading", "read"].map((status) =>
        '<option value="' + status + '"' + ((paper.status || "unread") === status ? " selected" : "") + ">" +
        STATUS_LABELS[status] + "</option>").join("") +
      "</select></span>" +
      '<a class="btn btn-sm" href="' + pdfUrl(paper.id, 1) + '" target="_blank" rel="noopener">' + icon("external") + "打开 PDF</a>" +
      '<button type="button" class="btn btn-sm btn-obsidian" data-obsidian-export>' + icon("obsidian") + "存入 Obsidian</button>" +
      '<a class="btn btn-sm" href="/api/papers/' + encodeURIComponent(paper.id) + '/export">' + icon("download") + "导出</a>" +
      '<button type="button" class="btn btn-sm" id="edit-paper">' + icon("edit") + "编辑题录</button>" +
      '<div class="right"><button type="button" class="btn btn-sm btn-quiet" id="delete-paper" title="移入回收站">' + icon("trash") + "删除</button></div>" +
      "</div></header>" +
      (paper.demo ? '<div class="notice demo-notice">' + icon("sparkles") +
        "<span>这是内置示例：论文、作者、数据和参考文献均为虚构，仅用于展示精读卡、页码跳转与引用核验。可随时删除。</span></div>" : "") +
      (warnings.length ? '<div class="notice">' + icon("alert") + "<span>" + esc(warnings.join(" ")) + "</span></div>" : "") +
      '<nav class="tabs" aria-label="文章视图">' + tabs.map((item) =>
        '<a class="tab' + (item.key === tab ? " active" : "") + '" data-tab="' + item.key + '" href="#/paper/' +
        encodeURIComponent(paper.id) + "/" + item.key + '">' + icon(item.iconName) + esc(item.label) +
        (item.running ? '<span class="tab-badge generating"></span>' : item.active ? '<span class="tab-badge"></span>' : "") +
        "</a>").join("") +
      "</nav>" +
      '<section class="tab-panel" id="tab-panel"></section>' +
      "</div>";

    document.title = (paper.title || "精读") + " · 澜读";
    setTopbar(paper.venue ? paper.venue + (paper.year ? " · " + paper.year : "") : "精读空间");

    $("#detail-star").addEventListener("click", () => toggleStar(paper.id));
    $("#detail-status").addEventListener("change", async (event) => {
      const status = event.target.value;
      try {
        const response = await api("/api/papers/" + paper.id, { method: "PATCH", body: { status } });
        App.paperData.paper = response.paper;
        const cached = App.papers.find((item) => item.id === paper.id);
        if (cached) cached.status = status;
        await refreshState(true);
        toast("已标记为「" + STATUS_LABELS[status] + "」", "success", 2000);
      } catch (error) {
        toast(error.message, "error");
        event.target.value = paper.status || "unread";
      }
    });
    $("#edit-paper").addEventListener("click", openEditModal);
    $("#delete-paper").addEventListener("click", deletePaper);
    if ($("#edit-categories")) $("#edit-categories").addEventListener("click", () => openCategoryAssignModal(paper.id));

    if (tab === "card") renderCardTab();
    else if (tab === "chat") renderChatTab();
    else if (tab === "notes") renderNotesTab();
    else if (tab === "pdf") renderPdfTab();
    else if (tab === "source") {
      $("#tab-panel").innerHTML = '<div class="loading-page"><span class="spinner"></span>正在载入原文…</div>';
    }
  }

  function setTabPanel(html) {
    const panel = $("#tab-panel");
    if (panel) panel.innerHTML = html;
  }

  // ─────────────────────────────────────────────────────────────
  // Card tab
  // ─────────────────────────────────────────────────────────────

  function activeCardTask(paperId) {
    return App.cardTask && App.cardTask.paperId === paperId ? App.cardTask : null;
  }

  function getFocus(paperId) {
    return App.cardFocus[paperId] || App.paperData.paper.card_focus || "standard";
  }

  function renderCardTab() {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    const task = activeCardTask(paper.id);
    const card = data.card || "";
    const takeaways = data.takeaways || "";
    const focus = getFocus(paper.id);
    const ready = aiReady();
    const streaming = task && task.status === "streaming";
    const errored = task && task.status === "error";

    let toolbarRight = "";
    if (streaming) {
      toolbarRight = '<span class="status-line">' + icon("sparkles") + "正在精读</span>" +
        '<button type="button" class="btn btn-sm" id="stop-card">' + icon("stop") + "停止</button>";
    } else {
      toolbarRight = '<select class="focus-select" id="card-focus" aria-label="精读侧重"' + (card ? "" : " disabled") + ">" +
        Object.keys(FOCUS_LABELS).map((key) =>
          '<option value="' + key + '"' + (focus === key ? " selected" : "") + ">" + FOCUS_LABELS[key] + "</option>").join("") +
        "</select>" +
        (card ? '<button type="button" class="btn btn-sm" id="regen-card">' + icon("refresh") + "重新生成</button>" : "") +
        (card ? '<button type="button" class="btn-quiet" id="verify-card" title="检查引用句中的关键数字/术语是否出现在对应页">' + icon("check") + "核验引用</button>" : "") +
        (card ? '<button type="button" class="btn-quiet" id="copy-card">' + icon("copy") + "复制</button>" : "") +
        (card ? '<button type="button" class="btn-quiet btn-obsidian" data-obsidian-export>' + icon("obsidian") + "存入 Obsidian</button>" : "") +
        (card ? '<a class="btn-quiet" href="/api/papers/' + encodeURIComponent(paper.id) + '/export">' + icon("download") + "导出</a>" : "");
    }

    const metaLine = card
      ? (paper.demo && paper.card_model === "demo-preview"
        ? "内置示例卡 · 预置内容，可直接核验引用"
        : "生成于 " + esc(formatDateTime(paper.card_updated_at)) +
          " · " + esc(paper.card_model || App.settings.model || "模型") +
          " · " + esc(FOCUS_LABELS[paper.card_focus] || "综合精读"))
      : "";

    let body = "";
    if (streaming) {
      body = '<div class="card-paper streaming no-seal">' +
        '<div class="stream-progress"><span></span></div>' +
        '<div class="stream-topline"><span class="spinner"></span>' +
        '<span id="card-stream-note">' + (task.sampled ? "原文较长，正在依据核心页面精读…" : "正在通读全文，提取问题、方法、证据与局限…") + "</span>" +
        "</div>" +
        '<div class="prose" id="card-stream-body">' +
        (task.buffer ? md.render(task.buffer) + '<span class="stream-caret"></span>' : '<p class="muted-line">正在阅读…</p>') +
        "</div></div>";
    } else if (errored) {
      const errorBox = '<div class="card-paper no-seal" style="padding:32px 36px">' +
        '<div class="inline-error" style="margin:0">' + icon("alert") +
        "<div><strong>精读卡没有生成成功</strong><br>" + esc(task.error || "模型服务出错") + "</div></div>" +
        '<div class="form-actions" style="justify-content:flex-start">' +
        ((task.code === "no_key" || task.code === "auth" || task.code === "config")
          ? '<a class="btn btn-primary btn-sm" href="#/settings">检查设置</a>' : "") +
        '<button type="button" class="btn btn-sm" id="retry-card">重试</button>' +
        (card ? '<button type="button" class="btn btn-sm" id="dismiss-card-error">查看已有精读卡</button>' : "") +
        "</div></div>";
      body = errorBox;
    } else if (card) {
      body = '<article class="card-paper">' +
        '<div class="prose">' + md.render(card) + "</div>" +
        '<div class="card-meta-line">' + metaLine + "</div>" +
        '<div class="card-actions-inline">' +
        '<a class="btn btn-sm" href="#/paper/' + encodeURIComponent(paper.id) + '/chat">' + icon("chat") + "继续追问" +
        "</a>" +
        '<button type="button" class="btn btn-sm" data-mode="meeting">' + icon("layers") + "组会提纲</button>" +
        '<button type="button" class="btn btn-sm" data-mode="wechat">' + icon("note") + "公众号初稿</button>" +
        "</div></article>";
    } else {
      const orphanFocus = getFocus(paper.id);
      const lowText = Number(paper.text_chars || 0) < 500;
      body = '<div class="card-empty">' +
        '<div class="orb">' + icon("sparkles") + "</div>" +
        "<h2>" + (lowText ? "这篇 PDF 缺少文字层" : "开始把这篇论文读透") + "</h2>" +
        "<p>" + (lowText
          ? "扫描版 PDF 需要 OCR 才能分析。首版暂未接入 OCR，你可以换一份文本版 PDF，或先阅读原文。"
          : "AI 会逐项拆解核心问题、真实创新、研究设计、关键证据、结论与局限，并为每条判断标注 PDF 页码。") + "</p>" +
        (!lowText ? '<div class="card-preview-list">' +
          ['一句话结论与核心问题', '方法与数据细节', '关键结果与证据链', '局限、审稿追问与研究启示']
            .map((text) => "<div>" + icon("check") + esc(text) + "</div>").join("") +
          "</div>" : "") +
        (!ready
          ? '<div class="gen-controls"><a class="btn btn-primary" href="#/settings">' + icon("gear") + "先配置 AI</a></div>" +
            '<p class="tiny">配置模型后，上传 PDF 会自动生成精读卡。</p>'
          : !lowText
            ? '<div class="gen-controls"><div class="gen-focus-pills" id="gen-focus-pills">' +
              Object.keys(FOCUS_LABELS).map((key) =>
                '<button type="button" data-focus="' + key + '" class="' + (orphanFocus === key ? "active" : "") + '">' +
                FOCUS_LABELS[key] + "</button>").join("") +
              '</div><button type="button" class="btn btn-primary" id="start-card">' + icon("sparkles") + "生成精读卡</button></div>" +
              '<p class="tiny" id="gen-focus-hint">' + esc(FOCUS_HINTS[orphanFocus] || "") + " · 预计 30–90 秒；生成的卡片会保存在本地。</p>"
            : "") +
        "</div>";
    }

    const showTakeaways = !!card && !streaming && !errored;
    const takeawayPanel = showTakeaways
      ? '<section class="takeaway-card">' +
        '<div class="takeaway-head"><div><div class="takeaway-kicker">MY TAKEAWAYS</div>' +
        "<h3>我的收获</h3><p>可以让 AI 先根据精读卡起草一版，再补充自己的判断；重新生成精读卡不会覆盖这里。</p></div>" +
        '<div class="takeaway-tools"><span class="takeaway-state saved" id="takeaway-state">' +
        (takeaways.trim() ? "已保存" : "自动保存到本地") + "</span>" +
        (ready ? '<button type="button" class="btn btn-sm" id="draft-takeaway" title="让 AI 根据精读卡和研究背景起草">' +
          icon("sparkles") + "AI 起草</button>" : "") +
        "</div></div>" +
        '<textarea class="takeaway-editor" id="takeaway-editor" rows="4" placeholder="例如：这个方法可以迁移到我的水库；有一个假设我暂时不信；下一篇要查什么…">' +
        esc(takeaways) + "</textarea>" +
        '<p class="takeaway-hint">自动保存在本地。AI 起草只是一个起点，你可以直接改成自己的话。</p>' +
        "</section>"
      : "";

    const focusNote = card && !streaming && !errored
      ? '<div class="focus-note" id="focus-note">' +
        esc(FOCUS_HINTS[focus] || "") +
        (paper.demo && paper.card_model === "demo-preview"
          ? " · 内置示例卡是预置内容，点「重新生成」才会按新模式重写"
          : " · 改模式后点「重新生成」生效") +
        "</div>"
      : "";
    setTabPanel('<div class="card-wrap">' +
      '<div class="card-toolbar"><span class="meta-line">' + (paper.demo ? "示例精读卡" : "AI 精读卡") +
      '</span><span class="evidence-summary" id="card-evidence-summary"></span><div class="right">' + toolbarRight + "</div></div>" +
      focusNote + body + takeawayPanel + "</div>");

    if (streaming && $("#stop-card")) $("#stop-card").addEventListener("click", stopCardGeneration);
    if ($("#card-focus")) {
      $("#card-focus").addEventListener("change", (event) => {
        App.cardFocus[paper.id] = event.target.value;
        const note = $("#focus-note");
        if (note) {
          note.textContent = (FOCUS_HINTS[event.target.value] || "") +
            (paper.demo && paper.card_model === "demo-preview"
              ? " · 内置示例卡是预置内容，点「重新生成」才会按新模式重写"
              : " · 改模式后点「重新生成」生效");
        }
      });
    }
    if ($("#regen-card")) {
      $("#regen-card").addEventListener("click", () => startCardGeneration(paper.id, getFocus(paper.id)));
    }
    if ($("#start-card")) {
      $("#start-card").addEventListener("click", () => startCardGeneration(paper.id, getFocus(paper.id)));
    }
    if ($("#gen-focus-pills")) {
      $("#gen-focus-pills").addEventListener("click", (event) => {
        const button = event.target.closest("[data-focus]");
        if (!button) return;
        App.cardFocus[paper.id] = button.dataset.focus;
        $$("#gen-focus-pills button").forEach((item) => item.classList.toggle("active", item === button));
        const hint = $("#gen-focus-hint");
        if (hint) {
          hint.textContent = (FOCUS_HINTS[button.dataset.focus] || "") +
            " · 预计 30–90 秒；生成的卡片会保存在本地。";
        }
      });
    }
    if ($("#copy-card")) {
      $("#copy-card").addEventListener("click", () => {
        const personal = (App.paperData.takeaways || "").trim();
        copyText(personal ? card + "\n\n## 我的收获\n\n" + personal : card);
      });
    }
    const takeawayEditor = $("#takeaway-editor");
    if (takeawayEditor) {
      autosizeTextarea(takeawayEditor, 300);
      takeawayEditor.addEventListener("input", () => {
        if (!App.paperData) return;
        App.paperData.takeaways = takeawayEditor.value;
        App.takeawayPending = true;
        setTakeawayState("saving", "保存中…");
        clearTimeout(App.takeawayTimer);
        App.takeawayTimer = setTimeout(saveTakeawaysNow, 650);
        autosizeTextarea(takeawayEditor, 300);
      });
      takeawayEditor.addEventListener("blur", () => {
        if (App.takeawayPending) saveTakeawaysNow();
      });
    }
    if ($("#draft-takeaway")) {
      $("#draft-takeaway").addEventListener("click", async () => {
        if (!aiReady()) {
          toast("请先在设置中配置 AI 模型", "info");
          location.hash = "#/settings";
          return;
        }
        const editor = $("#takeaway-editor");
        if (!editor) return;
        if (editor.value.trim()) {
          const confirmed = await confirmDialog({
            title: "让 AI 重新起草？",
            message: "当前的「我的收获」会被新草稿替换。你仍然可以在生成后继续修改。",
            confirmText: "重新起草",
            danger: false,
          });
          if (!confirmed) return;
        }
        const button = $("#draft-takeaway");
        App.takeawayDrafting = true;
        button.disabled = true;
        button.innerHTML = '<span class="spinner" style="width:11px;height:11px;border-width:1px"></span>起草中…';
        editor.readOnly = true;
        setTakeawayState("saving", "AI 正在根据精读卡起草…");
        try {
          const result = await api("/api/papers/" + paper.id + "/takeaways/draft", { method: "POST" });
          editor.value = result.takeaways || "";
          App.paperData.takeaways = editor.value;
          App.takeawayPending = true;
          autosizeTextarea(editor, 300);
          await saveTakeawaysNow();
          setTakeawayState("saved", "已保存草稿");
          toast("已起草，可以直接改写成你自己的话", "success", 5000);
          editor.focus({ preventScroll: true });
        } catch (error) {
          setTakeawayState("error", "起草失败");
          toast("AI 起草失败：" + error.message, "error", 6000);
        } finally {
          App.takeawayDrafting = false;
          editor.readOnly = false;
          if (button) {
            button.disabled = false;
            button.innerHTML = icon("sparkles") + "AI 起草";
          }
        }
      });
    }
    if ($("#verify-card")) {
      $("#verify-card").addEventListener("click", () => {
        clearTimeout(App.evidenceTimer);
        verifyCitations(paper.id, $("#tab-panel"), false);
      });
    }
    clearTimeout(App.evidenceTimer);
    if (card && !streaming && !errored && Number(paper.page_count || 0) <= 80) {
      App.evidenceTimer = setTimeout(() => {
        if (App.route.name === "paper" && App.route.id === paper.id && App.route.tab === "card") {
          verifyCitations(paper.id, $("#tab-panel"), true);
        }
      }, 280);
    }
    if (showTakeaways && !takeaways.trim() && App.settings.auto_takeaways !== false && aiReady() &&
        !App.autoTakeawayTried.has(paper.id)) {
      App.autoTakeawayTried.add(paper.id);
      setTimeout(() => autoDraftTakeaways(paper.id), 650);
    }
    if ($("#retry-card")) {
      $("#retry-card").addEventListener("click", () => {
        const failedFocus = App.cardFocus[paper.id] || "standard";
        App.cardTask = null;
        startCardGeneration(paper.id, failedFocus);
      });
    }
    if ($("#dismiss-card-error")) {
      $("#dismiss-card-error").addEventListener("click", () => {
        App.cardTask = null;
        renderCardTab();
      });
    }
    $$("[data-mode]", $("#tab-panel")).forEach((button) => {
      button.addEventListener("click", () => {
        location.hash = "#/paper/" + paper.id + "/chat";
        setTimeout(() => sendChatMessage(MODE_PROMPTS[button.dataset.mode], button.dataset.mode), 230);
      });
    });
  }

  async function startCardGeneration(paperId, focus) {
    const data = App.paperData;
    if (!data || data.paper.id !== paperId) return;
    if (!aiReady()) {
      toast("请先在设置中配置 AI 模型", "info");
      location.hash = "#/settings";
      return;
    }
    if (Number(data.paper.text_chars || 0) < 500) {
      toast("这篇 PDF 没有足够的文字层，暂无法精读", "error");
      return;
    }
    if (App.cardTask && App.cardTask.paperId === paperId && App.cardTask.status === "streaming") {
      toast("这篇文献正在生成精读卡", "info");
      return;
    }
    if (App.cardTask && App.cardTask.controller) App.cardTask.controller.abort();
    const controller = new AbortController();
    const task = {
      paperId,
      controller,
      buffer: "",
      status: "streaming",
      focus: focus || "standard",
      sampled: false,
      startedAt: Date.now(),
      error: "",
      code: "",
      raf: null,
    };
    App.cardTask = task;
    if (App.route.name === "paper" && App.route.id === paperId && App.route.tab === "card") {
      renderCardTab();
    }
    refreshTabBadges();
    try {
      await streamSSE("/api/papers/" + paperId + "/card", { focus: task.focus }, (event) => {
        if (event.type === "start") {
          task.sampled = !!event.sampled;
          task.model = event.model;
          const note = $("#card-stream-note");
          if (note) note.textContent = task.sampled
            ? "原文较长，正在依据核心页面精读…"
            : "正在通读全文，提取问题、方法、证据与局限…";
        } else if (event.type === "delta") {
          task.buffer += event.text || "";
          scheduleCardRender(task);
        } else if (event.type === "done") {
          finalizeCard(task, event);
        } else if (event.type === "error") {
          failCard(task, event.message || "生成失败", event.code);
        }
      }, controller.signal);
      if (task.status === "streaming") {
        failCard(task, "连接意外中断，请重试", "network");
      }
    } catch (error) {
      if (error.name === "AbortError") {
        if (task.status === "streaming") {
          task.status = "aborted";
          App.cardTask = null;
          if (currentPaperId() === paperId) renderCardTab();
        }
        return;
      }
      failCard(task, error.message || "生成失败", error.code);
    }
  }

  function scheduleCardRender(task) {
    if (task.raf) return;
    task.raf = requestAnimationFrame(() => {
      task.raf = null;
      if (App.cardTask !== task || task.status !== "streaming") return;
      updateCardStreamBody(task);
    });
  }

  function updateCardStreamBody(task) {
    const body = $("#card-stream-body");
    if (!body) return;
    body.innerHTML = task.buffer
      ? md.render(task.buffer) + '<span class="stream-caret"></span>'
      : '<p class="muted-line">正在阅读…</p>';
  }

  function finalizeCard(task, event) {
    task.status = "done";
    if (App.cardTask === task) App.cardTask = null;
    if (App.paperData && App.paperData.paper.id === task.paperId) {
      App.paperData.card = task.buffer;
      if (event.meta) App.paperData.paper = Object.assign({}, App.paperData.paper, event.meta);
      const cached = App.papers.find((item) => item.id === task.paperId);
      if (cached && event.meta) Object.assign(cached, event.meta);
    }
    const onCard = App.route.name === "paper" && App.route.id === task.paperId && App.route.tab === "card";
    if (onCard) {
      renderCardTab();
    } else {
      toast("精读卡已生成，可以回到文献查看", "success");
    }
    refreshTabBadges();
    refreshState(true).catch(() => {});
  }

  function failCard(task, message, code) {
    if (App.cardTask !== task) return;
    task.status = "error";
    task.error = message;
    task.code = code || "";
    if (App.route.name === "paper" && App.route.id === task.paperId && App.route.tab === "card") {
      renderCardTab();
    } else {
      toast("精读卡生成失败：" + message, "error", 6000);
    }
    refreshTabBadges();
  }

  function stopCardGeneration() {
    if (!App.cardTask || App.cardTask.status !== "streaming") return;
    App.cardTask.status = "aborted";
    if (App.cardTask.controller) App.cardTask.controller.abort();
    App.cardTask = null;
    renderCardTab();
    refreshTabBadges();
    toast("已停止生成", "info");
  }

  function refreshTabBadges() {
    if (App.route.name !== "paper" || !App.paperData) return;
    const cardTab = $('.tab[data-tab="card"]');
    if (cardTab) {
      const streaming = App.cardTask && App.cardTask.paperId === App.paperData.paper.id &&
        App.cardTask.status === "streaming";
      const hasCard = !!(App.paperData.card || App.paperData.paper.card_updated_at);
      let badge = cardTab.querySelector(".tab-badge");
      if (streaming || hasCard) {
        if (!badge) {
          badge = document.createElement("span");
          cardTab.appendChild(badge);
        }
        badge.className = "tab-badge" + (streaming ? " generating" : "");
      } else if (badge) {
        badge.remove();
      }
    }
    const chatTab = $('.tab[data-tab="chat"]');
    if (chatTab) {
      const streaming = App.chatTask && App.chatTask.paperId === App.paperData.paper.id &&
        App.chatTask.status === "streaming";
      const hasChat = (App.paperData.chat || []).length > 0;
      let badge = chatTab.querySelector(".tab-badge");
      if (streaming || hasChat) {
        if (!badge) {
          badge = document.createElement("span");
          chatTab.appendChild(badge);
        }
        badge.className = "tab-badge" + (streaming ? " generating" : "");
      } else if (badge) {
        badge.remove();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Chat tab
  // ─────────────────────────────────────────────────────────────

  function activeChatTask(paperId) {
    return App.chatTask && App.chatTask.paperId === paperId ? App.chatTask : null;
  }

  function questionsForPaper(paperId) {
    const task = activeCardTask(paperId);
    const card = App.paperData && App.paperData.card || "";
    const match = card.match(/##\s*建议追问\s*\n([\s\S]*?)(?=\n##\s|\s*$)/);
    if (match) {
      const questions = [];
      match[1].split("\n").forEach((line) => {
        const item = line.match(/^\s*(?:\d+[.、)]|[-*])\s+(.+?)\s*$/);
        if (item) questions.push(item[1].replace(/\*\*/g, "").replace(/\[p\.\d+\]/gi, "").trim());
      });
      if (questions.length) return questions.slice(0, 4);
    }
    return [
      "用三句话说明这篇论文的核心贡献与最关键的证据。",
      "作者的方法依赖哪些关键假设？在什么情况下会失效？",
      "这篇论文的局限是什么？如果由你来审稿，会追问什么？",
      "如果把这项研究迁移到我的课题，最值得借鉴和需要警惕的地方是什么？",
    ];
  }

  function renderChatTab() {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    const task = activeChatTask(paper.id);
    const base = task ? task.historyBefore : (data.chat || []);
    const display = (base || []).slice();
    if (task) display.push({ role: "user", content: task.pendingUser });
    const streaming = task && task.status === "streaming";
    if (streaming) display.push({ role: "assistant", content: task.buffer, streaming: true });
    App.chatDisplayMessages = display;

    const ready = aiReady();
    const locked = !ready;
    const lowText = Number(paper.text_chars || 0) < 500;
    const empty = display.length === 0;

    let messages = "";
    if (empty && !task) {
      messages = '<div class="chat-empty">' +
        '<div class="empty-orb">' + icon("chat") + "</div>" +
        "<h3>从证据出发，继续追问</h3>" +
        "<p>回答只依据这篇论文，关键判断附 PDF 页码；没写的内容会明确说没有报告。</p>" +
        '<div class="suggest-grid">' +
        questionsForPaper(paper.id).slice(0, 4).map((question, index) =>
          '<button type="button" class="suggest-card" data-suggest="' + esc(question) + '">' +
          '<span class="num">0' + (index + 1) + "</span><span>" + esc(question) + "</span></button>").join("") +
        "</div></div>";
    } else {
      messages = display.map((message, index) => chatMessageHTML(message, index, streaming && index === display.length - 1)).join("");
      if (task && task.status === "error") {
        messages += '<div class="chat-error">' + icon("alert") +
          "<div><strong>这次回答没有完成。</strong> " + esc(task.error || "模型服务出错") +
          '<div class="msg-actions" style="opacity:1;margin-top:5px">' +
          ((task.code === "no_key" || task.code === "auth" || task.code === "config")
            ? '<a class="btn-quiet" href="#/settings">去检查设置</a>' : "") +
          '<button type="button" class="btn-quiet" id="chat-retry">重试</button></div></div></div>';
      }
    }

    const modeButtons = [
      { key: "meeting", label: "组会提纲", iconName: "layers" },
      { key: "wechat", label: "公众号初稿", iconName: "note" },
      { key: "reviewer", label: "审稿人视角", iconName: "quote" },
      { key: "methods", label: "复现清单", iconName: "check" },
    ].map((mode) =>
      '<button type="button" class="mode-chip" data-mode="' + mode.key + '"' + (streaming ? " disabled" : "") + ">" +
      icon(mode.iconName) + mode.label + "</button>").join("");

    let composer = "";
    if (locked) {
      composer = '<div class="chat-locked">' + icon("sparkles") +
        "<span>配置 AI 模型后，就可以基于全文追问。</span>" +
        '<a class="btn btn-primary btn-sm" href="#/settings">去配置</a></div>';
    } else if (lowText) {
      composer = '<div class="chat-locked">' + icon("alert") +
        "<span>这篇 PDF 没有足够的文字层，暂时无法追问。</span>" +
        '<a class="btn btn-sm" href="#/paper/' + encodeURIComponent(paper.id) + '/pdf">查看 PDF</a></div>';
    } else {
      composer = '<div class="composer">' +
        '<textarea id="chat-input" rows="1" placeholder="问这篇文章任何问题…" aria-label="向 AI 提问">' +
        esc(App.drafts[paper.id] || "") + "</textarea>" +
        '<div class="composer-bar"><span class="composer-hint"><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>' +
        '<div class="composer-actions">' +
        (streaming
          ? '<button type="button" class="send-btn stop" id="chat-stop" aria-label="停止生成">' + icon("stop") + "</button>"
          : '<button type="button" class="send-btn" id="chat-send" aria-label="发送">' + icon("send") + "</button>") +
        "</div></div></div>";
    }

    setTabPanel('<div class="chat-shell">' +
      '<div class="chat-top"><div class="chat-context">' + icon("book") +
      "<span>基于全文 · <strong>" + (paper.page_count || "?") + " 页</strong> · 回答附页码</span></div>" +
      '<div class="right"><span class="model-tag">' + esc(App.settings.model || "未配置模型") + "</span>" +
      '<button type="button" class="icon-btn" id="verify-chat" aria-label="核验页码引用" title="核验回答中的页码引用"' +
      (streaming ? " disabled" : "") + ">" + icon("check") + "</button>" +
      '<button type="button" class="icon-btn" id="clear-chat" aria-label="清空对话" title="清空对话"' +
      (!display.length && !task ? " disabled" : "") + ">" + icon("trash") + "</button></div></div>" +
      '<div class="mode-chips">' + modeButtons + "</div>" +
      (paper.demo ? '<div class="notice demo-chat-note">' + icon("sparkles") +
        "<span>这是内置示例对话，用来说明回答样式；配置模型后可以继续追问。</span></div>" : "") +
      '<div class="chat-messages" id="chat-messages">' + messages + "</div>" +
      composer +
      "</div>");

    const container = $("#chat-messages");
    if (container) {
      if (empty && !task) {
        // no scroll needed
      } else {
        requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
      }
    }
    const textarea = $("#chat-input");
    if (textarea) {
      autosizeTextarea(textarea);
      textarea.addEventListener("input", () => {
        App.drafts[paper.id] = textarea.value;
        autosizeTextarea(textarea);
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          const value = textarea.value.trim();
          if (value) sendChatMessage(value, "reading");
        }
      });
      setTimeout(() => textarea.focus({ preventScroll: true }), 30);
    }
    if ($("#chat-send")) {
      $("#chat-send").addEventListener("click", () => {
        const input = $("#chat-input");
        const value = input ? input.value.trim() : "";
        if (!value) { if (input) input.focus(); return; }
        sendChatMessage(value, "reading");
      });
    }
    if ($("#chat-stop")) $("#chat-stop").addEventListener("click", stopChatGeneration);
    if ($("#verify-chat")) $("#verify-chat").addEventListener("click", () => verifyCitations(paper.id, $("#tab-panel"), false));
    if ($("#clear-chat")) $("#clear-chat").addEventListener("click", clearChat);
    if ($("#chat-retry")) {
      $("#chat-retry").addEventListener("click", () => {
        const current = App.chatTask;
        if (!current || current.status !== "error") return;
        const history = current.historyBefore;
        const content = current.pendingUser;
        const mode = current.mode;
        App.chatTask = null;
        sendChatMessage(content, mode, history);
      });
    }
    $$("[data-suggest]", $("#tab-panel")).forEach((button) => {
      button.addEventListener("click", () => sendChatMessage(button.dataset.suggest, "reading"));
    });
    $$("[data-mode]", $(".mode-chips") || document).forEach((button) => {
      if (!button.closest(".mode-chips")) return;
      button.addEventListener("click", () => {
        if (button.disabled) return;
        sendChatMessage(MODE_PROMPTS[button.dataset.mode] || MODE_PROMPTS.meeting, button.dataset.mode);
      });
    });
    $$("[data-copy-msg]", $("#tab-panel")).forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.copyMsg);
        const message = App.chatDisplayMessages[index];
        if (message) copyText(message.content || "");
      });
    });
    $$("[data-save-msg]", $("#tab-panel")).forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.saveMsg);
        saveAnswerToNotes(index);
      });
    });
  }

  function chatMessageHTML(message, index, streaming) {
    if (!message) return "";
    if (message.role === "user") {
      return '<div class="chat-msg user"><div class="msg-body">' +
        esc(message.content || "").replace(/\n/g, "<br>") + "</div></div>";
    }
    const content = message.content || "";
    const body = streaming
      ? '<div class="prose" id="chat-stream-body">' +
        (content ? md.render(content) + '<span class="stream-caret"></span>'
          : '<span class="status-line"><span class="spinner"></span>正在结合全文回答…</span>') +
        "</div>"
      : '<div class="prose">' + md.render(content) + "</div>" +
        '<div class="msg-actions">' +
        '<button type="button" data-copy-msg="' + index + '">' + icon("copy") + "复制</button>" +
        '<button type="button" data-save-msg="' + index + '">' + icon("note") + "存为笔记</button>" +
        "</div>";
    return '<div class="chat-msg assistant' + (streaming ? " streaming" : "") + '">' +
      '<div class="msg-avatar">澜</div><div class="msg-wrap">' +
      '<div class="msg-meta"><strong>精读助手</strong><span>' +
      (streaming ? "正在回答" : "基于全文") + "</span></div>" +
      '<div class="msg-body">' + body + "</div></div></div>";
  }

  function autosizeTextarea(textarea, maxHeight) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, maxHeight || 150) + "px";
  }

  async function sendChatMessage(content, mode, historyOverride) {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    const text = String(content || "").trim();
    if (!text) return;
    if (!aiReady()) {
      toast("请先在设置中配置 AI 模型", "info");
      location.hash = "#/settings";
      return;
    }
    if (Number(paper.text_chars || 0) < 500) {
      toast("这篇 PDF 没有足够的文字层，暂无法追问", "error");
      return;
    }
    if (App.chatTask) {
      if (App.chatTask.status === "streaming") stopChatGeneration(true, false);
      App.chatTask = null;
    }
    const historyBefore = Array.isArray(historyOverride)
      ? historyOverride.map((message) => ({ role: message.role, content: message.content }))
      : (data.chat || []).slice(-24).map((message) => ({ role: message.role, content: message.content }));
    const payloadMessages = historyBefore.concat([{ role: "user", content: text }]).slice(-30);
    const task = {
      paperId: paper.id,
      controller: new AbortController(),
      buffer: "",
      mode: mode || "reading",
      pendingUser: text,
      historyBefore,
      status: "streaming",
      error: "",
      code: "",
      startedAt: Date.now(),
      raf: null,
    };
    App.chatTask = task;
    App.drafts[paper.id] = "";
    renderChatTab();
    refreshTabBadges();
    try {
      await streamSSE("/api/papers/" + paper.id + "/chat", {
        messages: payloadMessages,
        mode: task.mode,
      }, (event) => {
        if (event.type === "start") {
          task.sampled = !!event.sampled;
          task.model = event.model;
        } else if (event.type === "delta") {
          task.buffer += event.text || "";
          scheduleChatRender(task);
        } else if (event.type === "done") {
          finalizeChat(task, event);
        } else if (event.type === "error") {
          failChat(task, event.message || "回答失败", event.code);
        }
      }, task.controller.signal);
      if (task.status === "streaming") failChat(task, "连接意外中断，请重试", "network");
    } catch (error) {
      if (error.name === "AbortError") return;
      failChat(task, error.message || "回答失败", error.code);
    }
  }

  function scheduleChatRender(task) {
    if (task.raf) return;
    task.raf = requestAnimationFrame(() => {
      task.raf = null;
      if (App.chatTask !== task || task.status !== "streaming") return;
      updateChatStreamBody(task);
    });
  }

  function updateChatStreamBody(task) {
    const body = $("#chat-stream-body");
    if (!body) return;
    const container = $("#chat-messages");
    const nearBottom = container ? container.scrollHeight - container.scrollTop - container.clientHeight < 130 : true;
    body.innerHTML = task.buffer
      ? md.render(task.buffer) + '<span class="stream-caret"></span>'
      : '<span class="status-line"><span class="spinner"></span>正在结合全文回答…</span>';
    if (container && nearBottom) container.scrollTop = container.scrollHeight;
  }

  function finalizeChat(task, event) {
    if (App.chatTask !== task) return;
    task.status = "done";
    const answer = event.answer || task.buffer;
    if (App.paperData && App.paperData.paper.id === task.paperId) {
      App.paperData.chat = task.historyBefore.concat([
        { role: "user", content: task.pendingUser },
        { role: "assistant", content: answer },
      ]);
      if (event.meta) App.paperData.paper = Object.assign({}, App.paperData.paper, event.meta);
      const cached = App.papers.find((item) => item.id === task.paperId);
      if (cached && event.meta) Object.assign(cached, event.meta);
    }
    App.chatTask = null;
    if (App.route.name === "paper" && App.route.id === task.paperId && App.route.tab === "chat") {
      renderChatTab();
    } else {
      toast("回答已生成，可以回到这篇文献查看", "success");
    }
    refreshTabBadges();
    refreshState(true).catch(() => {});
  }

  function failChat(task, message, code) {
    if (App.chatTask !== task) return;
    task.status = "error";
    task.error = message;
    task.code = code || "";
    if (App.route.name === "paper" && App.route.id === task.paperId && App.route.tab === "chat") {
      renderChatTab();
    } else {
      toast("回答失败：" + message, "error", 6000);
    }
    refreshTabBadges();
  }

  function stopChatGeneration(silent, preserve) {
    const task = App.chatTask;
    if (!task || task.status !== "streaming") return;
    task.status = "aborted";
    if (task.controller) task.controller.abort();
    if (preserve !== false && App.paperData && App.paperData.paper.id === task.paperId) {
      App.paperData.chat = task.historyBefore.concat([{ role: "user", content: task.pendingUser }]);
    }
    App.chatTask = null;
    refreshTabBadges();
    if (!silent) {
      renderChatTab();
      toast("已停止生成", "info");
    }
  }

  function scrollChatToBottom(smooth) {
    const container = $("#chat-messages");
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function scrollChatIntoView() {
    const tabs = $(".tabs");
    const shell = $(".chat-shell");
    if (!tabs || !shell) return;
    const barHeight = $(".topbar") ? $(".topbar").offsetHeight : 68;
    const top = tabs.getBoundingClientRect().top + window.scrollY - barHeight - 2;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  async function clearChat() {
    const paperId = currentPaperId();
    if (!paperId) return;
    if (App.chatTask && App.chatTask.status === "streaming") stopChatGeneration(true, false);
    const confirmed = await confirmDialog({
      title: "清空这篇文献的对话？",
      message: "精读卡和笔记不会受到影响，但对话记录无法恢复。",
      confirmText: "清空对话",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/papers/" + paperId + "/chat", { method: "DELETE" });
      if (App.paperData) App.paperData.chat = [];
      App.chatTask = null;
      renderChatTab();
      toast("对话已清空", "success");
      refreshState(true).catch(() => {});
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function saveAnswerToNotes(index) {
    if (!App.paperData) return;
    const messages = App.chatDisplayMessages;
    const message = messages[index];
    if (!message || message.role !== "assistant") return;
    const question = messages[index - 1] && messages[index - 1].role === "user"
      ? messages[index - 1].content : "追问";
    await flushNotes();
    const current = App.paperData.notes || "";
    const appended = current.trimEnd() +
      "\n\n---\n\n### 追问摘记\n\n> " + question.replace(/\n/g, "\n> ") + "\n\n" +
      (message.content || "") + "\n";
    App.paperData.notes = appended;
    try {
      await api("/api/papers/" + App.paperData.paper.id + "/notes", {
        method: "POST",
        body: { notes: appended },
      });
      toast("已存入笔记", "success");
    } catch (error) {
      toast("存入笔记失败：" + error.message, "error");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Evidence checks and source highlighting
  // ─────────────────────────────────────────────────────────────

  const EVIDENCE_STOP = new Set([
    "this", "that", "with", "from", "were", "was", "have", "has", "been", "into",
    "under", "over", "between", "across", "their", "these", "those", "which", "while",
    "also", "than", "then", "when", "where", "what", "after", "before", "during",
    "using", "used", "based", "study", "paper", "research", "result", "results",
    "figure", "table", "data", "method", "methods", "significant", "higher", "lower",
    "increased", "decreased", "shows", "show", "found", "reported", "authors", "author",
    "site", "sites", "page", "respectively", "approximately", "however", "therefore",
  ]);

  function normalizeEvidenceText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[−–—]/g, "-")
      .replace(/(\d),(?=\d)/g, "$1")
      .replace(/\s+/g, " ");
  }

  function claimEvidenceTokens(claim) {
    const text = String(claim || "")
      .replace(/\[(?:P\d+\s*[·,，]?\s*)?p\.?\s*\d+(?:\s*[-–]\s*\d+)?\]/gi, " ")
      .replace(/\bP\d+\s*[·,，]?\s*/gi, " ")
      .replace(/\bp\.\s*\d+\b/gi, " ")
      .replace(/(\d),(?=\d)/g, "$1");
    const numbers = Array.from(text.matchAll(/\d+(?:\.\d+)?/g)).map((match) => match[0])
      .filter((number) => !/^(19|20)\d{2}$/.test(number));
    const words = Array.from(text.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g))
      .map((match) => match[0].toLowerCase().replace(/^-+|-+$/g, ""))
      .filter((word) => word.length >= 3 && !EVIDENCE_STOP.has(word));
    return {
      numbers: Array.from(new Set(numbers)),
      words: Array.from(new Set(words)),
    };
  }

  function evidenceMatchForText(text, tokens) {
    const haystack = normalizeEvidenceText(text);
    const numberHits = tokens.numbers.filter((number) => haystack.includes(number));
    const wordHits = tokens.words.filter((word) => haystack.includes(word));
    let status = "unchecked";
    if (tokens.numbers.length) {
      status = numberHits.length >= Math.max(1, Math.ceil(tokens.numbers.length * 0.6)) ? "ok" : "review";
    } else if (tokens.words.length >= 2) {
      status = wordHits.length >= 2 ? "ok" : "review";
    }
    return { status, numberHits, wordHits };
  }

  function applyEvidenceStatus(chip, status, title) {
    chip.classList.remove("evidence-ok", "evidence-review", "evidence-na");
    if (status === "ok") chip.classList.add("evidence-ok");
    else if (status === "review") chip.classList.add("evidence-review");
    else chip.classList.add("evidence-na");
    chip.title = title;
  }

  async function ensurePagesFor(paperId) {
    if (App.pagesPaperId === paperId && Array.isArray(App.pages)) return App.pages;
    const result = await api("/api/papers/" + paperId + "/pages");
    const pages = result.pages || [];
    if (App.paperData && App.paperData.paper.id === paperId) {
      App.pages = pages;
      App.pagesPaperId = paperId;
    }
    return pages;
  }

  async function verifyCitations(paperId, scope, silent) {
    const panel = scope || $("#tab-panel");
    if (!panel) return;
    const chips = Array.from(panel.querySelectorAll(".cite-chip[data-page]")).filter((chip) =>
      !chip.dataset.paperId || chip.dataset.paperId === paperId);
    if (!chips.length) {
      if (!silent) toast("这里还没有页码引用可核验", "info");
      const emptySummary = $("#card-evidence-summary");
      if (emptySummary) emptySummary.textContent = "";
      return;
    }
    const summary = $("#card-evidence-summary");
    if (summary) {
      summary.innerHTML = '<span class="spinner" style="width:10px;height:10px;border-width:1px"></span> 正在核验引用…';
      summary.title = "正在比较引用句中的关键数字/术语与对应页内容";
    }
    let pages;
    try {
      pages = await ensurePagesFor(paperId);
    } catch (error) {
      if (summary) summary.textContent = "证据核验暂时不可用";
      if (!silent) toast("无法载入原文页：" + error.message, "error");
      return;
    }
    if (!panel.isConnected) return;
    const pageMap = new Map(pages.map((page) => [Number(page.page), page.text || ""]));
    const groups = new Map();
    chips.forEach((chip) => {
      const claimEl = chip.closest("li, p, td, th, blockquote") || chip.parentElement;
      if (!claimEl) return;
      if (!groups.has(claimEl)) groups.set(claimEl, { claim: claimEl.innerText, pages: new Set() });
      const page = Number(chip.dataset.page);
      if (page) groups.get(claimEl).pages.add(page);
    });
    let ok = 0;
    let review = 0;
    let unchecked = 0;
    for (const [claimEl, group] of groups) {
      const pageNumbers = Array.from(group.pages).sort((a, b) => a - b);
      const combinedText = pageNumbers.map((page) => pageMap.get(page) || "").join("\n");
      const tokens = claimEvidenceTokens(group.claim);
      const result = evidenceMatchForText(combinedText, tokens);
      const pagesLabel = pageNumbers.length ? "第 " + pageNumbers.join("、") + " 页" : "引用页";
      const title = result.status === "ok"
        ? "关键" + (tokens.numbers.length ? "数字" : "术语") + "在" + pagesLabel + "检出" +
          (result.numberHits.length ? "：" + result.numberHits.join("、") : "")
        : result.status === "review"
          ? "未能在" + pagesLabel + "自动检出全部关键" + (tokens.numbers.length ? "数字" : "术语") +
            "；建议回原文核对。绿点/黄点只是辅助标记。"
          : "这条判断主要由中文概述构成，没有足够的关键数字/英文术语可供自动核对；请人工阅读原文。";
      const claimChips = Array.from(claimEl.querySelectorAll(".cite-chip[data-page]"));
      claimChips.forEach((chip) => {
        if (chip.dataset.paperId && chip.dataset.paperId !== paperId) return;
        applyEvidenceStatus(chip, result.status, title);
        if (result.status === "ok") ok += 1;
        else if (result.status === "review") review += 1;
        else unchecked += 1;
      });
    }
    if (summary) {
      summary.innerHTML = '<span class="dot"></span>' + ok + ' 条检出 <span class="dot warn"></span>' +
        review + ' 条待核 <span class="dot muted"></span>' + unchecked + " 条未自动核";
      summary.title = "绿点：关键数字或术语在引用页检出；黄点：未检出或仅部分检出，建议回原文核对；灰点：中文概述，未包含足够可自动核对的信息。";
    }
    if (!silent) {
      toast("核验完成：" + ok + " 条在引用页检出，" + review + " 条建议复核，" + unchecked + " 条为中文概述未自动核对。", review ? "info" : "success", 7000);
    }
  }

  function splitEvidenceSentences(text) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return [""];
    return normalized.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
  }

  function evidenceTextScore(text, tokens) {
    const haystack = normalizeEvidenceText(text);
    let score = 0;
    let numberHits = 0;
    tokens.numbers.forEach((number) => {
      if (haystack.includes(number)) { score += 5; numberHits += 1; }
    });
    tokens.words.forEach((word) => {
      if (haystack.includes(word)) score += 1;
    });
    return { score, numberHits };
  }

  function clearEvidenceMarks(pageEl) {
    pageEl.querySelectorAll(".evidence-mark").forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    pageEl.querySelectorAll(".evidence-callout").forEach((item) => item.remove());
    pageEl.classList.remove("flash");
  }

  function highlightEvidenceInSource(pageNumber, claim) {
    const pageEl = document.querySelector('.source-page[data-page="' + Number(pageNumber) + '"]');
    if (!pageEl) return;
    clearEvidenceMarks(pageEl);
    const tokens = claimEvidenceTokens(claim || "");
    const paragraphs = Array.from(pageEl.querySelectorAll(".page-text p"));
    let best = null;
    paragraphs.forEach((paragraph) => {
      const sentences = splitEvidenceSentences(paragraph.textContent || "");
      sentences.forEach((sentence, index) => {
        const scored = evidenceTextScore(sentence, tokens);
        if (!best || scored.score > best.score) {
          best = { score: scored.score, numberHits: scored.numberHits, paragraph, sentences, index };
        }
      });
    });
    const head = pageEl.querySelector(".source-page-head");
    const callout = document.createElement("div");
    callout.className = "evidence-callout";
    if (best && best.score >= 2 && (best.numberHits > 0 || best.score >= 4)) {
      best.paragraph.innerHTML = best.sentences.map((sentence, index) =>
        index === best.index
          ? '<mark class="evidence-mark">' + esc(sentence) + "</mark>"
          : esc(sentence)).join(" ");
      callout.innerHTML = icon("check") + "<span>已按引用内容定位到最可能的证据句。绿色标记是辅助定位，请核对原文。</span>";
    } else {
      callout.innerHTML = icon("alert") + "<span>未自动定位到精确证据句，请浏览本页核实。</span>";
    }
    if (head) head.insertAdjacentElement("afterend", callout);
    pageEl.classList.add("flash");
    setTimeout(() => pageEl.classList.remove("flash"), 1900);
    const target = pageEl.querySelector(".evidence-mark") || pageEl;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ─────────────────────────────────────────────────────────────
  // Source tab
  // ─────────────────────────────────────────────────────────────

  async function renderSourceTab(pageQuery) {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    if (App.route.name !== "paper" || App.route.id !== paper.id || App.route.tab !== "source") return;
    const panel = $("#tab-panel");
    if (!panel) return;
    if (App.pagesPaperId !== paper.id) {
      panel.innerHTML = '<div class="loading-page"><span class="spinner"></span>正在载入原文…</div>';
      try {
        const result = await api("/api/papers/" + paper.id + "/pages");
        if (App.route.name !== "paper" || App.route.id !== paper.id || App.route.tab !== "source") return;
        App.pages = result.pages || [];
        App.pagesPaperId = paper.id;
      } catch (error) {
        panel.innerHTML = '<div class="empty-state"><h3>原文载入失败</h3><p>' + esc(error.message) + "</p></div>";
        return;
      }
    }
    if (App.paperData.paper.id !== paper.id) return;
    const pages = App.pages || [];
    const total = pages.reduce((sum, page) => sum + String(page.text || "").length, 0);

    panel.innerHTML = '<div class="source-wrap">' +
      '<div class="source-toolbar"><span>' + icon("file") + "共 " + pages.length + " 页 · " +
      (total ? "从 PDF 文字层提取" : "未检测到文字") + "</span>" +
      '<span class="right"><a class="btn btn-sm" href="' + pdfUrl(paper.id, 1) + '" target="_blank" rel="noopener">' +
      icon("external") + "在 PDF 中打开</a></span></div>" +
      '<div class="source-pages">' +
      pages.map((page) => sourcePageHTML(paper.id, page)).join("") +
      "</div></div>";

    if (pageQuery) {
      const page = Number(pageQuery);
      const pending = App.pendingEvidence;
      if (pending && pending.paperId === paper.id && pending.page && Date.now() - pending.ts < 20000) {
        const target = Number(pending.page) || page;
        setTimeout(() => {
          highlightEvidenceInSource(target, pending.claim);
          App.pendingEvidence = null;
        }, 90);
      } else if (page > 0) {
        setTimeout(() => scrollToSourcePage(page), 60);
      }
    }
    updateNav();
  }

  function sourcePageHTML(paperId, page) {
    const paragraphs = pageParagraphs(page.text || "");
    return '<article class="source-page" id="source-page-' + page.page + '" data-page="' + page.page + '">' +
      '<header class="source-page-head"><span class="page-label">PAGE</span>' +
      '<span class="page-num">' + String(page.page).padStart(2, "0") + "</span>" +
      '<span class="right"><a class="btn-quiet" href="' + pdfUrl(paperId, page.page) + '" target="_blank" rel="noopener" title="在 PDF 中打开这一页">' +
      icon("external") + "PDF</a></span></header>" +
      '<div class="page-text">' +
      (paragraphs.length
        ? paragraphs.map((text) => "<p>" + esc(text) + "</p>").join("")
        : '<p class="page-empty">这一页没有可提取的文字。</p>') +
      "</div></article>";
  }

  function pageParagraphs(text) {
    const blocks = String(text || "")
      .split(/\n\s*\n+/)
      .map((block) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        let result = "";
        lines.forEach((line) => {
          if (!result) { result = line; return; }
          const previous = result.slice(-1);
          const next = line.slice(0, 1);
          const addSpace = /[A-Za-z0-9,.;:)\]}]/.test(previous) && /[A-Za-z0-9(\[]/.test(next);
          result += (addSpace ? " " : "") + line;
        });
        return result;
      })
      .filter(Boolean);
    // Extracted PDF text often has no blank lines. Break dense pages into
    // readable chunks without destroying sentences or decimal numbers.
    const paragraphs = [];
    blocks.forEach((block) => {
      if (block.length <= 700) {
        paragraphs.push(block);
        return;
      }
      const sentences = block.split(/(?<=[.!?。！？])(?=\s|[\u4e00-\u9fff])/).filter((part) => part.trim());
      if (sentences.length <= 1) {
        paragraphs.push(block);
        return;
      }
      for (let index = 0; index < sentences.length; index += 4) {
        paragraphs.push(sentences.slice(index, index + 4).join("").trim());
      }
    });
    return paragraphs.filter(Boolean);
  }

  function scrollToSourcePage(page) {
    const element = document.getElementById("source-page-" + page);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.add("flash");
    setTimeout(() => element.classList.remove("flash"), 1900);
  }

  function handleSourceSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      hideSelectionPopover();
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 6) { hideSelectionPopover(); return; }
    const anchor = selection.anchorNode && (selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode);
    const pageEl = anchor ? anchor.closest(".source-page") : null;
    if (!pageEl) { hideSelectionPopover(); return; }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    hideSelectionPopover();
    const popover = document.createElement("div");
    popover.className = "sel-popover";
    popover.innerHTML = '<button type="button" data-sel-ask>' + icon("chat") + "就这段提问</button>" +
      '<button type="button" data-sel-copy>' + icon("copy") + "复制</button>";
    const left = Math.min(Math.max(rect.left + rect.width / 2, 100), window.innerWidth - 100);
    const top = Math.max(rect.top, 50);
    popover.style.left = left + "px";
    popover.style.top = top + "px";
    document.body.appendChild(popover);
    App.selectionPopover = { element: popover, text: text.slice(0, 1200), page: Number(pageEl.dataset.page) };
    popover.addEventListener("mousedown", (event) => event.preventDefault());
    popover.querySelector("[data-sel-copy]").addEventListener("click", () => {
      copyText(text);
      hideSelectionPopover();
    });
    popover.querySelector("[data-sel-ask]").addEventListener("click", () => {
      const paper = App.paperData && App.paperData.paper;
      if (!paper) return;
      const snippet = text.length > 700 ? text.slice(0, 700) + "…" : text;
      App.drafts[paper.id] = "关于第 " + pageEl.dataset.page + " 页这段原文：\n“" + snippet +
        "”\n\n请解释它在全文论证中的作用，并说明它支持或削弱了什么结论。";
      hideSelectionPopover();
      location.hash = "#/paper/" + paper.id + "/chat";
    });
  }

  function hideSelectionPopover() {
    if (App.selectionPopover && App.selectionPopover.element) App.selectionPopover.element.remove();
    App.selectionPopover = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Notes tab
  // ─────────────────────────────────────────────────────────────

  async function autoDraftTakeaways(paperId) {
    if (App.takeawayDrafting) return;
    if (!App.paperData || App.paperData.paper.id !== paperId) return;
    if ((App.paperData.takeaways || "").trim()) return;
    if (App.route.name !== "paper" || App.route.id !== paperId || App.route.tab !== "card") return;
    const editor = $("#takeaway-editor");
    if (!editor || editor.value.trim()) return;
    if (!aiReady() || App.settings.auto_takeaways === false) return;
    App.takeawayDrafting = true;
    setTakeawayState("saving", "AI 正在先总结一版…");
    if (editor) editor.readOnly = true;
    const draftButton = $("#draft-takeaway");
    if (draftButton) draftButton.disabled = true;
    try {
      const result = await api("/api/papers/" + paperId + "/takeaways/draft", { method: "POST" });
      if (!App.paperData || App.paperData.paper.id !== paperId) return;
      const current = App.paperData.takeaways || "";
      if (current.trim() || !editor.isConnected || editor.value.trim()) {
        setTakeawayState("saved", "已保留你写的内容");
        return;
      }
      editor.value = result.takeaways || "";
      App.paperData.takeaways = editor.value;
      App.takeawayPending = true;
      autosizeTextarea(editor, 300);
      await saveTakeawaysNow();
      setTakeawayState("saved", "AI 已起草，可继续补充");
    } catch (error) {
      setTakeawayState("error", "AI 暂未起草，可点按钮重试");
    } finally {
      App.takeawayDrafting = false;
      if (editor) editor.readOnly = false;
      if (draftButton) {
        draftButton.disabled = false;
        draftButton.innerHTML = icon("sparkles") + "AI 起草";
      }
    }
  }

  function setTakeawayState(state, text) {
    const el = $("#takeaway-state");
    if (!el) return;
    el.className = "takeaway-state " + state;
    el.innerHTML = (state === "saving"
      ? '<span class="spinner" style="width:10px;height:10px;border-width:1px"></span>'
      : state === "error" ? icon("alert") : icon("check")) + esc(text);
  }

  async function saveTakeawaysNow() {
    if (!App.paperData || App.takeawaySaving) return;
    const data = App.paperData;
    const paperId = data.paper.id;
    const text = data.takeaways || "";
    clearTimeout(App.takeawayTimer);
    App.takeawayTimer = null;
    App.takeawaySaving = true;
    setTakeawayState("saving", "保存中…");
    let changedWhileSaving = false;
    try {
      const result = await api("/api/papers/" + paperId + "/takeaways", {
        method: "POST",
        body: { takeaways: text },
      });
      if (App.paperData && App.paperData.paper.id === paperId) {
        App.paperData.paper.takeaways_updated_at = result.updated_at || App.paperData.paper.takeaways_updated_at;
        changedWhileSaving = (App.paperData.takeaways || "") !== text;
        App.takeawayPending = changedWhileSaving;
        setTakeawayState(changedWhileSaving ? "saving" : "saved", changedWhileSaving ? "保存中…" : "已保存");
      }
    } catch (error) {
      setTakeawayState("error", "保存失败");
      toast("我的收获保存失败：" + error.message, "error");
    } finally {
      App.takeawaySaving = false;
      if (changedWhileSaving && App.takeawayPending) {
        App.takeawayTimer = setTimeout(saveTakeawaysNow, 700);
      }
    }
  }

  async function flushTakeaways() {
    if (!App.takeawayPending) return;
    if (App.takeawaySaving) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return flushTakeaways();
    }
    await saveTakeawaysNow();
  }

  function renderNotesTab() {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    const notes = data.notes || "";
    setTabPanel('<div class="notes-wrap">' +
      '<div class="notes-toolbar">' +
      '<span class="save-state" id="note-state">' + icon("check") + "自动保存到本地</span>" +
      '<span class="right">' +
      (data.card ? '<button type="button" class="btn-quiet" id="insert-card">' + icon("sparkles") + "插入精读卡</button>" : "") +
      '<button type="button" class="btn-quiet btn-obsidian" data-obsidian-export>' + icon("obsidian") + "存入 Obsidian</button>" +
      '<a class="btn-quiet" href="/api/papers/' + encodeURIComponent(paper.id) + '/export">' + icon("download") + "导出</a>" +
      "</span></div>" +
      '<div class="notes-grid">' +
      '<section class="notes-pane"><div class="notes-pane-head"><span>Markdown</span><span>' + (notes.length || 0) + " 字符</span></div>" +
      '<textarea class="notes-editor" id="notes-editor" placeholder="记下你的判断、可复用的方法、与课题的连接，或组会要讲的重点…">' +
      esc(notes) + "</textarea></section>" +
      '<section class="notes-pane"><div class="notes-pane-head"><span>预览</span><span>' + esc(FOCUS_LABELS[paper.card_focus] || "") + "</span></div>" +
      '<div class="notes-preview" id="notes-preview">' +
      (notes.trim() ? '<div class="prose">' + md.render(notes) + "</div>" : '<p class="empty-hint">在左侧输入后，这里会显示排版预览。</p>') +
      "</div></section></div></div>");

    const editor = $("#notes-editor");
    if (!editor) return;
    editor.addEventListener("input", () => {
      data.notes = editor.value;
      App.notesPending = true;
      const preview = $("#notes-preview");
      if (preview) {
        preview.innerHTML = editor.value.trim()
          ? '<div class="prose">' + md.render(editor.value) + "</div>"
          : '<p class="empty-hint">在左侧输入后，这里会显示排版预览。</p>';
      }
      setNoteState("saving", "保存中…");
      clearTimeout(App.noteTimer);
      App.noteTimer = setTimeout(() => saveNotesNow(), 650);
    });
    if ($("#insert-card")) {
      $("#insert-card").addEventListener("click", async () => {
        const current = editor.value.trimEnd();
        const addition = (current ? "\n\n---\n\n" : "") + data.card;
        editor.value = addition;
        data.notes = addition;
        App.notesPending = true;
        $("#notes-preview").innerHTML = '<div class="prose">' + md.render(addition) + "</div>";
        await saveNotesNow();
      });
    }
  }

  function setNoteState(state, text) {
    const el = $("#note-state");
    if (!el) return;
    el.className = "save-state " + state;
    el.innerHTML = (state === "saving" ? '<span class="spinner" style="width:11px;height:11px;border-width:1px"></span>' : icon("check")) + esc(text);
  }

  async function saveNotesNow() {
    if (!App.paperData || App.notesSaving) return;
    const data = App.paperData;
    const notes = data.notes || "";
    clearTimeout(App.noteTimer);
    App.noteTimer = null;
    App.notesSaving = true;
    setNoteState("saving", "保存中…");
    try {
      await api("/api/papers/" + data.paper.id + "/notes", {
        method: "POST",
        body: { notes },
      });
      App.notesPending = false;
      if (App.paperData && App.paperData.paper.id === data.paper.id) {
        App.paperData.paper.notes_updated_at = new Date().toISOString();
      }
      setNoteState("saved", "已保存");
    } catch (error) {
      setNoteState("error", "保存失败");
      toast("笔记保存失败：" + error.message, "error");
    } finally {
      App.notesSaving = false;
      if (App.notesPending) {
        App.noteTimer = setTimeout(() => saveNotesNow(), 800);
      }
    }
  }

  async function flushNotes() {
    if (!App.notesPending) return;
    if (App.notesSaving) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return flushNotes();
    }
    await saveNotesNow();
  }

  // ─────────────────────────────────────────────────────────────
  // PDF tab
  // ─────────────────────────────────────────────────────────────

  function renderPdfTab() {
    const data = App.paperData;
    if (!data) return;
    const paper = data.paper;
    const page = App.pdfPageByPaper[paper.id] || 1;
    App.pdfPageByPaper[paper.id] = page;
    setTabPanel('<div class="pdf-shell">' +
      '<div class="pdf-toolbar"><span>' + icon("pdf") + "PDF 原文 · " + (paper.page_count || "?") + " 页</span>" +
      '<span class="right"><span class="page-jump">跳到 <input id="pdf-page" type="number" min="1" max="' + (paper.page_count || 9999) + '" value="' + page + '"> 页</span>' +
      '<button type="button" class="btn btn-sm" id="pdf-jump">定位</button>' +
      '<a class="btn btn-sm" href="' + pdfUrl(paper.id, page) + '" target="_blank" rel="noopener">' + icon("external") + "新标签打开</a></span></div>" +
      '<iframe class="pdf-frame" id="pdf-frame" title="PDF 原文" src="' + pdfUrl(paper.id, page) + '"></iframe>' +
      '<p class="setting-footnote" style="margin-top:10px">如果浏览器不支持内嵌 PDF，请点击「新标签打开」。</p></div>');

    const jump = () => {
      const input = $("#pdf-page");
      if (!input) return;
      let target = Math.max(1, Math.min(Number(input.value) || 1, paper.page_count || 9999));
      App.pdfPageByPaper[paper.id] = target;
      const frame = $("#pdf-frame");
      if (frame) frame.src = pdfUrl(paper.id, target);
      const open = $(".pdf-toolbar a[target=_blank]");
      if (open) open.href = pdfUrl(paper.id, target);
    };
    if ($("#pdf-jump")) $("#pdf-jump").addEventListener("click", jump);
    if ($("#pdf-page")) {
      $("#pdf-page").addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); jump(); }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────

  function renderSettings() {
    const settings = App.settings || {};
    const provider = settings.provider || "deepseek";
    const providers = Object.keys(PROVIDERS);
    const localModel = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(settings.base_url || ""));
    const keyState = settings.api_key_set ? "Key 已配置" : localModel ? "本地模型 · 无需 Key" : "尚未配置 Key";
    const keyStateClass = (settings.api_key_set || localModel) ? "ok" : "warn";
    const lanUrls = Array.isArray(settings.lan_urls) ? settings.lan_urls : [];
    const lanEnabled = !!settings.lan_access;
    const lanLocal = !!settings.lan_local;
    const lanPin = settings.lan_pin || "";
    const obsidianVault = String(settings.obsidian_vault || "");
    const obsidianFolder = String(settings.obsidian_folder || "澜读文献");
    const obsidianVaultCount = Array.isArray(settings.obsidian_vaults) ? settings.obsidian_vaults.length : 0;
    setTopbar("设置");
    $("#view").innerHTML =
      '<div class="page settings-page">' +
      '<div class="page-head"><div><div class="kicker">PREFERENCES / 设置</div>' +
      '<h1 class="page-title">让工作台按你的方式工作</h1>' +
      '<p class="page-sub">Key 只保存在这台电脑的数据目录里，不会写进笔记，也不会出现在对话中。只有生成精读卡和回答问题时，论文文本才会发送给你配置的模型服务。</p></div></div>' +
      '<div class="settings-grid">' +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>AI 模型</h2><p>兼容 OpenAI Chat Completions 接口。默认接入 DeepSeek。</p></div>' +
      '<div class="head-state"><span class="badge ' + keyStateClass + '">' + keyState + "</span></div></div>" +
      '<div class="preset-row" id="provider-presets">' +
      providers.map((key) =>
        '<button type="button" class="preset' + (provider === key ? " active" : "") + '" data-provider="' + key + '">' +
        esc(PROVIDERS[key].label) + "</button>").join("") +
      '<input type="hidden" id="set-provider" value="' + esc(provider) + '">' +
      "</div>" +
      '<div class="field-grid">' +
      '<div class="field"><label for="set-base">Base URL</label><input id="set-base" type="url" value="' + esc(settings.base_url || "") + '" placeholder="https://api.deepseek.com/v1" spellcheck="false"></div>' +
      '<div class="field"><label for="set-model">模型名称</label><input id="set-model" type="text" value="' + esc(settings.model || "") + '" placeholder="deepseek-chat" spellcheck="false"></div>' +
      '<div class="field full"><label for="set-key">API Key</label><div class="key-wrap">' +
      '<input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="' +
      (settings.api_key_set ? "已设置 " + esc(settings.api_key_hint || "") + "，留空则保持不变" : "sk-…，仅保存在本机") + '">' +
      '<button type="button" class="key-toggle" id="key-toggle" aria-label="显示或隐藏 Key">' + icon("eye") + "</button></div>" +
      '<span class="hint">DeepSeek Key 可在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a> 获取。也支持兼容接口或本机 Ollama，本地地址不强制要求 Key。</span></div>' +
      "</div>" +
      '<div class="form-actions"><button type="button" class="btn btn-primary" id="save-settings">保存设置</button>' +
      '<button type="button" class="btn" id="test-ai">测试连接</button>' +
      '<span class="test-result" id="test-ai-result"></span>' +
      (settings.api_key_set ? '<button type="button" class="btn btn-quiet right" id="clear-key">清除已保存的 Key</button>' : "") +
      "</div>" +
      '<div class="privacy-note">' + icon("alert") + "<span>如果使用第三方中转站，论文内容会经过该服务。未发表数据请自行评估风险，或改用本机 Ollama。</span></div>" +
      "</section>" +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>阅读与输出</h2><p>这些偏好会进入精读卡中的“与我的研究关联”，也会影响追问的侧重点。</p></div></div>' +
      '<div class="field"><label for="set-profile">我的研究背景</label>' +
      '<textarea id="set-profile" rows="4" placeholder="例如：水库水质与富营养化、沉积物重金属、排水管网入渗与溢流污染…">' + esc(settings.research_profile || "") + "</textarea>" +
      '<span class="hint">写得越具体，卡片最后一节越有用。不会自动上传，只随本次分析一起发送。</span></div>' +
      '<div class="switch-row"><div class="switch-copy"><strong>上传后自动生成精读卡</strong><p>仅对文本版 PDF 生效；生成会消耗模型额度。</p></div>' +
      '<label class="switch"><input type="checkbox" id="set-auto"' + (settings.auto_analyze ? " checked" : "") + '><span></span></label></div>' +
      '<div class="switch-row"><div class="switch-copy"><strong>自动起草「我的收获」</strong><p>打开空白收获时，先让 AI 根据精读卡和研究背景写一版；可随时修改或关闭。</p></div>' +
      '<label class="switch"><input type="checkbox" id="set-auto-takeaways"' + (settings.auto_takeaways !== false ? " checked" : "") + '><span></span></label></div>' +
      '<div class="field" style="margin-top:14px"><label for="set-context">送入模型的正文上限</label>' +
      '<input id="set-context" type="number" min="20000" max="180000" step="10000" value="' + esc(settings.context_char_limit || 130000) + '">' +
      '<span class="hint">默认 130,000 字符。长综述或学位论文可按需调整；超出后会优先保留开头、结论区和带小标题的页面。</span></div>' +
      "</section>" +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>Zotero</h2><p>从本机 Zotero 直接读取题录和 PDF，免去重复上传。需要 Zotero 7 桌面端保持运行。</p></div>' +
      '<div class="head-state"><button type="button" class="btn btn-sm" id="test-zotero">测试 Zotero</button></div></div>' +
      '<div class="field-grid">' +
      '<div class="field"><label for="set-zotero-api">本地 API 地址</label><input id="set-zotero-api" type="url" value="' + esc(settings.zotero_api || "http://127.0.0.1:23119") + '" spellcheck="false"></div>' +
      '<div class="field"><label for="set-zotero-user">User ID</label><input id="set-zotero-user" type="text" value="' + esc(settings.zotero_user_id || "0") + '" spellcheck="false">' +
      '<span class="hint">本地 API 通常使用 0 即可；写你自己的 Zotero 数字 ID 也可以。</span></div>' +
      "</div>" +
      '<div class="form-actions"><button type="button" class="btn" id="open-zotero">从 Zotero 导入文献</button><span class="test-result" id="test-zotero-result"></span></div>' +
      "</section>" +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>Obsidian</h2><p>把精读卡、我的收获和笔记写成 Markdown，直接放进本机 Obsidian 笔记库。</p></div>' +
      '<div class="head-state"><span class="badge ' + (obsidianVault ? "ok" : "warn") + '">' +
      (obsidianVault ? "已设置" : "未设置") + "</span></div></div>" +
      '<div class="field"><label for="set-obsidian-vault">笔记库</label>' +
      '<input id="set-obsidian-vault" type="text" value="' + esc(obsidianVault) + '" placeholder="选择一个笔记库，或粘贴包含 .obsidian 的文件夹路径" spellcheck="false"' + (lanLocal ? "" : " disabled") + ">" +
      (lanLocal ? vaultChipsHtml(obsidianVault) : "") +
      '<span class="hint">Obsidian 的笔记库是包含 .obsidian 文件夹的目录；路径只保存在本机，不会随笔记导出。</span></div>' +
      '<div class="field-grid" style="margin-top:14px">' +
      '<div class="field"><label for="set-obsidian-folder">子文件夹</label><input id="set-obsidian-folder" type="text" value="' + esc(obsidianFolder) + '" placeholder="澜读文献" spellcheck="false"' + (lanLocal ? "" : " disabled") + ">" +
      '<span class="hint">相对于笔记库根目录，可写多级，例如「文献/水环境」；留空则使用「澜读文献」。</span></div>' +
      '<div class="field"><label>自动检测</label><div class="obsidian-detect"><span>检测到 ' + obsidianVaultCount + ' 个笔记库</span>' +
      '<button type="button" class="btn btn-sm" id="refresh-obsidian"' + (lanLocal ? "" : " disabled") + ">重新检测</button></div></div>" +
      "</div>" +
      '<div class="form-actions"><button type="button" class="btn" id="save-obsidian-settings"' + (lanLocal ? "" : " disabled") + ">保存 Obsidian 设置</button>" +
      '<span class="test-result" id="obsidian-settings-result"></span></div>' +
      (!lanLocal ? '<p class="setting-footnote" style="margin-top:8px">Obsidian 设置只能在电脑上修改；手机端可以使用已配置的笔记库导出。</p>' : "") +
      '<div class="privacy-note">' + icon("check") +
      "<span>导出不会覆盖你在 Obsidian 里改过的笔记；同名文件发生变化时会自动另存副本。PDF 本身不会复制进笔记库，页码引用仍指向原文。</span></div>" +
      "</section>" +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>手机访问</h2><p>手机和电脑连接同一个 Wi-Fi，用手机浏览器打开下面的地址；论文和数据仍保存在电脑上。</p></div>' +
      '<div class="head-state"><span class="badge ' + (lanEnabled ? "ok" : "warn") + '">' +
      (lanEnabled ? "已开启" : "未开启") + "</span></div></div>" +
      '<div class="switch-row"><div class="switch-copy"><strong>允许同一 Wi-Fi 下的手机访问</strong>' +
      '<p>开启后需要输入访问码；电脑需保持开机。只建议在可信的家庭或办公室网络中开启。</p></div>' +
      '<label class="switch"><input type="checkbox" id="set-lan"' + (lanEnabled ? " checked" : "") +
      (lanLocal ? "" : " disabled") + '><span></span></label></div>' +
      (lanEnabled
        ? '<div class="lan-access-block">' +
          '<div class="field full"><label>手机打开这个地址</label>' +
          '<div class="lan-url-list">' +
          (lanUrls.length
            ? lanUrls.map((url) => '<div class="lan-url-row"><code>' + esc(url) + '</code>' +
              '<button type="button" class="btn btn-sm" data-lan-copy="' + esc(url) + '">复制</button></div>').join("")
            : '<span class="hint">暂未检测到局域网地址，请检查电脑是否已连接 Wi-Fi。</span>') +
          '</div><span class="hint">手机首次打开会进入登录页，输入访问码即可。</span></div>' +
          (lanLocal
            ? '<div class="field full"><label>访问码</label><div class="lan-pin-row">' +
              '<strong class="lan-pin">' + esc(lanPin || "未设置") + '</strong>' +
              '<button type="button" class="btn btn-sm" id="copy-lan-pin">复制</button>' +
              '<button type="button" class="btn-quiet" id="regen-lan-pin">换一个访问码</button></div>' +
              '<span class="hint">访问码只在电脑上显示；换码后，已经登录的手机需要重新输入。</span></div>'
            : '<p class="setting-footnote">访问码已隐藏，只能在电脑端的设置中查看。</p>') +
          '<div class="privacy-note">' + icon("alert") +
          "<span>首次连接时，Windows 防火墙可能询问是否允许 Python 访问网络，请在专用网络下允许。若手机打不开，确认两台设备在同一个 Wi-Fi，且路由器没有开启设备隔离。</span></div>" +
          "</div>"
        : '<p class="setting-footnote">开启后，手机可在同一 Wi-Fi 下访问；关闭后手机端会立即失去访问权限。</p>') +
      '<div class="privacy-note">' + icon("check") +
      "<span>手机访问通过局域网 HTTP + 访问码保护；请只在可信网络下开启，不要在公共 Wi-Fi 上长期开放。</span></div>" +
      "</section>" +

      '<section class="setting-card">' +
      '<div class="setting-head"><div><h2>本地数据</h2><p>PDF、精读卡、对话和笔记都以普通文件保存在本机。建议定期备份整个文件夹。</p></div></div>' +
      '<div class="data-path"><span>' + icon("folder") + "</span><span>" + esc(settings.data_dir || "") + "</span>" +
      '<button type="button" class="btn btn-sm right" id="copy-data-path">复制</button></div>' +
      '<div class="form-actions"><button type="button" class="btn btn-sm" id="open-demo">' + icon("sparkles") + "查看内置示例</button>" +
      '<span class="setting-footnote">虚构演示例文，不消耗模型额度，可随时删除</span></div>' +
      '<div class="privacy-note">' + icon("check") + "<span>不上传云端、不做账号同步；删除文献会先移入回收站，彻底删除后才移除本地 PDF 与笔记。</span></div>" +
      '<p class="setting-footnote" style="margin-top:16px">澜读 · 文献工作台 1.0.2 · 本地优先的文献精读空间</p>' +
      "</section>" +

      "</div></div>";

    bindSettings();
  }

  function bindSettings() {
    const providerInput = $("#set-provider");
    $$("[data-provider]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.provider;
        if ($("#set-provider")) $("#set-provider").value = key;
        $$("[data-provider]").forEach((item) => item.classList.toggle("active", item === button));
        const preset = PROVIDERS[key];
        if (preset && key !== "custom") {
          if ($("#set-base")) $("#set-base").value = preset.base;
          if ($("#set-model")) $("#set-model").value = preset.model;
        }
      });
    });
    if ($("#key-toggle")) {
      $("#key-toggle").addEventListener("click", () => {
        const input = $("#set-key");
        if (!input) return;
        const shown = input.type === "text";
        input.type = shown ? "password" : "text";
        $("#key-toggle").innerHTML = icon(shown ? "eye" : "eye-off");
      });
    }
    if ($("#save-settings")) $("#save-settings").addEventListener("click", saveSettings);
    if ($("#test-ai")) $("#test-ai").addEventListener("click", testAI);
    if ($("#set-obsidian-vault")) bindVaultChips($("#view"), $("#set-obsidian-vault"));
    if ($("#save-obsidian-settings")) $("#save-obsidian-settings").addEventListener("click", saveObsidianSettings);
    if ($("#refresh-obsidian")) $("#refresh-obsidian").addEventListener("click", refreshObsidianVaults);
    if ($("#clear-key")) {
      $("#clear-key").addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "清除已保存的 API Key？",
          message: "清除后，精读卡生成与追问将暂时不可用；已生成的卡片和笔记不受影响。",
          confirmText: "清除 Key",
          danger: true,
        });
        if (!ok) return;
        try {
          const response = await api("/api/settings", { method: "POST", body: { clear_api_key: true } });
          App.settings = response.settings;
          renderSidebar();
          renderSettings();
          toast("Key 已清除", "success");
        } catch (error) {
          toast(error.message, "error");
        }
      });
    }
    if ($("#test-zotero")) {
      $("#test-zotero").addEventListener("click", async () => {
        const target = $("#test-zotero-result");
        target.className = "test-result";
        target.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1px"></span>正在测试…';
        try {
          const result = await api("/api/zotero/test");
          target.className = "test-result ok";
          target.innerHTML = icon("check") + "已连接 · " + result.ms + " ms";
        } catch (error) {
          target.className = "test-result err";
          target.innerHTML = icon("alert") + esc(error.message);
        }
      });
    }
    if ($("#open-zotero")) $("#open-zotero").addEventListener("click", openZoteroModal);
    if ($("#copy-data-path")) {
      $("#copy-data-path").addEventListener("click", () => copyText(App.settings.data_dir || ""));
    }
    if ($("#open-demo")) {
      $("#open-demo").addEventListener("click", () => importDemo(true));
    }
    if ($("#set-lan")) {
      $("#set-lan").addEventListener("change", async (event) => {
        const enabled = event.target.checked;
        event.target.disabled = true;
        try {
          const response = await api("/api/settings", { method: "POST", body: { lan_access: enabled } });
          App.settings = response.settings;
          await refreshState(true);
          renderSettings();
          toast(enabled ? "手机访问已开启" : "手机访问已关闭", "success", 4500);
        } catch (error) {
          event.target.checked = !enabled;
          event.target.disabled = false;
          toast("手机访问设置失败：" + error.message, "error");
        }
      });
    }
    $$("[data-lan-copy]").forEach((button) => {
      button.addEventListener("click", () => copyText(button.dataset.lanCopy || ""));
    });
    if ($("#copy-lan-pin")) {
      $("#copy-lan-pin").addEventListener("click", () => copyText(lanPin));
    }
    if ($("#regen-lan-pin")) {
      $("#regen-lan-pin").addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          title: "换一个手机访问码？",
          message: "旧访问码会立即失效，已经登录的手机需要重新输入新的访问码。",
          confirmText: "生成新访问码",
          danger: false,
        });
        if (!confirmed) return;
        try {
          const response = await api("/api/lan/regenerate", { method: "POST" });
          App.settings = response.settings;
          await refreshState(true);
          renderSettings();
          toast("已生成新的访问码", "success", 4500);
        } catch (error) {
          toast("无法生成新访问码：" + error.message, "error");
        }
      });
    }
  }

  async function saveSettings() {
    const provider = $("#set-provider") ? $("#set-provider").value : "deepseek";
    const base = $("#set-base") ? $("#set-base").value.trim() : "";
    const model = $("#set-model") ? $("#set-model").value.trim() : "";
    const key = $("#set-key") ? $("#set-key").value.trim() : "";
    if (!base || !/^https?:\/\//.test(base)) {
      toast("Base URL 需要以 http:// 或 https:// 开头", "error");
      return;
    }
    if (!model) { toast("请填写模型名称", "error"); return; }
    const body = {
      provider,
      base_url: base,
      model,
      auto_analyze: $("#set-auto") ? $("#set-auto").checked : true,
      auto_takeaways: $("#set-auto-takeaways") ? $("#set-auto-takeaways").checked : true,
      research_profile: $("#set-profile") ? $("#set-profile").value.trim() : "",
      context_char_limit: $("#set-context") ? Number($("#set-context").value) : 130000,
      zotero_api: $("#set-zotero-api") ? $("#set-zotero-api").value.trim() : "http://127.0.0.1:23119",
      zotero_user_id: $("#set-zotero-user") ? $("#set-zotero-user").value.trim() : "0",
    };
    if (key) body.api_key = key;
    const button = $("#save-settings");
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      const response = await api("/api/settings", { method: "POST", body });
      App.settings = response.settings;
      renderSidebar();
      renderSettings();
      toast("设置已保存", "success");
    } catch (error) {
      toast(error.message, "error");
      if (button) { button.disabled = false; button.textContent = "保存设置"; }
    }
  }

  async function saveObsidianSettings() {
    const vault = $("#set-obsidian-vault") ? $("#set-obsidian-vault").value.trim() : "";
    const folder = $("#set-obsidian-folder") ? $("#set-obsidian-folder").value.trim() : "澜读文献";
    const button = $("#save-obsidian-settings");
    if (!vault) {
      toast("请选择或填写 Obsidian 笔记库路径", "error");
      if ($("#set-obsidian-vault")) $("#set-obsidian-vault").focus();
      return;
    }
    if (button) { button.disabled = true; button.textContent = "保存中…"; }
    try {
      const response = await api("/api/settings", {
        method: "POST",
        body: { obsidian_vault: vault, obsidian_folder: folder },
      });
      App.settings = response.settings;
      const scrollY = window.scrollY;
      renderSettings();
      window.scrollTo(0, scrollY);
      toast("Obsidian 设置已保存", "success");
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = "保存 Obsidian 设置"; }
      const target = $("#obsidian-settings-result");
      if (target) {
        target.className = "test-result err";
        target.innerHTML = icon("alert") + esc(error.message);
      } else {
        toast("保存失败：" + error.message, "error");
      }
    }
  }

  async function refreshObsidianVaults() {
    const button = $("#refresh-obsidian");
    if (button) { button.disabled = true; button.textContent = "检测中…"; }
    try {
      const response = await api("/api/settings");
      App.settings = response.settings;
      const scrollY = window.scrollY;
      renderSettings();
      window.scrollTo(0, scrollY);
      toast("已重新检测 Obsidian 笔记库", "success", 3000);
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = "重新检测"; }
      toast("检测失败：" + error.message, "error");
    }
  }

  async function testAI() {
    const target = $("#test-ai-result");
    const button = $("#test-ai");
    if (!target || !button) return;
    target.className = "test-result";
    target.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1px"></span>正在连接…';
    button.disabled = true;
    try {
      const key = $("#set-key") ? $("#set-key").value.trim() : "";
      const payload = {
        base_url: $("#set-base") ? $("#set-base").value.trim() : "",
        model: $("#set-model") ? $("#set-model").value.trim() : "",
      };
      if (key) payload.api_key = key;
      const result = await api("/api/settings/test", { method: "POST", body: payload });
      target.className = "test-result ok";
      target.innerHTML = icon("check") + "连接成功 · " + result.model + " · " + result.ms + " ms";
    } catch (error) {
      target.className = "test-result err";
      target.innerHTML = icon("alert") + esc(error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Compare
  // ─────────────────────────────────────────────────────────────

  async function renderComparePage(seq) {
    const view = $("#view");
    if (!App.papers.length) {
      view.innerHTML = '<div class="page"><div class="empty-state">' +
        '<div class="empty-art">' + libraryEmptyArt() + "</div>" +
        "<h3>先用几篇文献把桌面铺开</h3><p>多篇对比需要至少两篇文献。导入 PDF 后，就能在这里比较方法、结论与适用边界。</p>" +
        '<div class="empty-actions"><button class="btn btn-primary" data-upload>' + icon("upload") + "上传 PDF</button></div>" +
        "</div></div>";
      bindLibraryHero();
      return;
    }
    const historyHtml = '<div class="history-list" id="compare-history-list">' +
      '<div class="history-empty"><span class="spinner"></span></div></div>';
    view.innerHTML =
      '<div class="page">' +
      '<div class="page-head"><div><div class="kicker">SYNTHESIS / 多篇对比</div>' +
      '<h1 class="page-title">把几篇论文放在同一张桌上</h1>' +
      '<p class="page-sub">不是把摘要叠在一起，而是比较它们对同一问题的不同回答：尺度、数据、方法、结论边界，以及哪些分歧值得继续追。</p></div></div>' +
      '<div class="compare-layout">' +
      '<section class="compare-builder">' +
      '<h2><span class="step">01 /</span>选择 2–5 篇文献</h2>' +
      '<p class="sub">优先选择已生成精读卡的文献；没有卡片的会使用原文关键页，信息会粗一些。</p>' +
      '<div class="pick-list" id="compare-pick-list">' + comparePickHTML() + "</div>" +
      '<div class="focus-input-row"><label for="compare-focus">给这次对比一个关注点（可选）</label>' +
      '<input id="compare-focus" type="text" maxlength="300" placeholder="例如：方法差异、对管网管理的启示、尺度问题" value="' + esc(App.compareFocus) + '">' +
      '<p class="hint">留空时，AI 会自动寻找最能产生洞见的对比角度。</p></div>' +
      '<div class="compare-actions"><button type="button" class="btn btn-primary" id="start-compare">' +
      icon("sparkles") + "生成对比综述</button>" +
      '<span class="sel-note" id="compare-note"></span>' +
      "</div>" +
      '<div class="compare-output" id="compare-output"></div>' +
      "</section>" +
      '<aside class="compare-history"><div class="side-head"><h2>已保存的对比</h2><span>本地</span></div>' + historyHtml + "</aside>" +
      "</div></div>";

    bindComparePage();
    updateCompareControls();
    renderCompareOutput();
    try {
      const result = await api("/api/comparisons");
      if (seq !== App.routeSeq) return;
      App.comparisons = result.comparisons || [];
      const container = $("#compare-history-list");
      if (container) {
        container.innerHTML = App.comparisons.length
          ? App.comparisons.map((item) =>
            '<a class="history-item" href="#/compare/' + encodeURIComponent(item.id) + '"><strong>' + esc(item.title) +
            "</strong><span>" + esc((item.paper_titles || []).length + " 篇 · " + formatDateTime(item.created_at)) + "</span></a>").join("")
          : '<div class="history-empty">还没有保存过对比。选择文献，生成第一份综合评述。</div>';
      }
    } catch (error) {
      if (seq !== App.routeSeq) return;
      const container = $("#compare-history-list");
      if (container) container.innerHTML = '<div class="history-empty">' + esc(error.message) + "</div>";
    }
  }

  function comparePickHTML() {
    const papers = App.papers.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    if (!papers.length) return '<div class="pick-empty">还没有文献。</div>';
    return papers.map((paper) => {
      const checked = App.selected.has(paper.id);
      return '<label class="pick-row' + (checked ? " checked" : "") + '">' +
        '<input type="checkbox" data-compare-pick="' + esc(paper.id) + '"' + (checked ? " checked" : "") + ">" +
        '<div class="pick-info"><div class="pick-title">' + esc(paper.title || "未命名文献") + "</div>" +
        '<div class="pick-meta">' + esc(formatAuthors(paper.authors, 2)) + " · " + esc(paper.year || "年份未知") +
        (paper.venue ? " · " + esc(paper.venue) : "") + "</div></div>" +
        (paper.card_updated_at
          ? '<span class="pick-badge">' + icon("sparkles") + "精读卡</span>"
          : '<span class="pick-badge missing">无卡</span>') +
        "</label>";
    }).join("");
  }

  function bindComparePage() {
    const list = $("#compare-pick-list");
    if (list) {
      list.addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-compare-pick]");
        if (!checkbox) return;
        const id = checkbox.dataset.comparePick;
        if (checkbox.checked) {
          if (App.selected.size >= 5 && !App.selected.has(id)) {
            checkbox.checked = false;
            toast("最多同时对比 5 篇文献", "info");
            return;
          }
          App.selected.add(id);
        } else {
          App.selected.delete(id);
        }
        const row = checkbox.closest(".pick-row");
        if (row) row.classList.toggle("checked", checkbox.checked);
        updateCompareControls();
      });
    }
    if ($("#compare-focus")) {
      $("#compare-focus").addEventListener("input", (event) => { App.compareFocus = event.target.value; });
    }
    if ($("#start-compare")) $("#start-compare").addEventListener("click", startComparison);
  }

  function updateCompareControls() {
    const count = App.selected.size;
    const button = $("#start-compare");
    const note = $("#compare-note");
    if (button) button.disabled = count < 2 || count > 5 || (App.compareTask && App.compareTask.status === "streaming");
    if (note) {
      const selectedPapers = App.papers.filter((paper) => App.selected.has(paper.id));
      const missing = selectedPapers.filter((paper) => !paper.card_updated_at).length;
      note.textContent = count < 2
        ? "至少选择 2 篇文献"
        : count > 5
          ? "对比最多 5 篇，请先取消 " + (count - 5) + " 篇"
          : count + " 篇已选" + (missing ? "，" + missing + " 篇无精读卡" : "，均有精读卡");
    }
  }

  async function startComparison() {
    if (!aiReady()) {
      toast("请先在设置中配置 AI 模型", "info");
      location.hash = "#/settings";
      return;
    }
    const ids = Array.from(App.selected);
    if (ids.length < 2 || ids.length > 5) {
      toast("请选择 2–5 篇文献", "info");
      return;
    }
    if (App.compareTask && App.compareTask.controller) {
      App.compareTask.status = "aborted";
      App.compareTask.controller.abort();
    }
    const focus = App.compareFocus.trim();
    const papers = App.papers.filter((paper) => ids.indexOf(paper.id) !== -1);
    const task = {
      controller: new AbortController(),
      buffer: "",
      status: "streaming",
      paperIds: ids,
      paperTitles: papers.map((paper) => paper.title),
      focus,
      startedAt: Date.now(),
      error: "",
      code: "",
      raf: null,
    };
    App.compareTask = task;
    renderCompareOutput();
    updateCompareControls();
    setTimeout(() => {
      const output = $("#compare-output");
      if (output) output.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    try {
      await streamSSE("/api/comparisons", { paper_ids: ids, focus }, (event) => {
        if (event.type === "start") {
          task.model = event.model;
        } else if (event.type === "delta") {
          task.buffer += event.text || "";
          scheduleCompareRender(task);
        } else if (event.type === "done") {
          const comparison = event.comparison || {};
          App.compareTask = null;
          App.comparisons.unshift(comparison);
          toast("对比综述已保存", "success");
          if (App.route.name === "compare" && comparison.id) {
            location.hash = "#/compare/" + comparison.id;
          }
        } else if (event.type === "error") {
          failCompare(task, event.message || "生成失败", event.code);
        }
      }, task.controller.signal);
      if (task.status === "streaming") failCompare(task, "连接意外中断，请重试", "network");
    } catch (error) {
      if (error.name === "AbortError") return;
      failCompare(task, error.message || "生成失败", error.code);
    }
  }

  function scheduleCompareRender(task) {
    if (task.raf) return;
    task.raf = requestAnimationFrame(() => {
      task.raf = null;
      if (App.compareTask !== task || task.status !== "streaming") return;
      updateCompareStreamBody(task);
    });
  }

  function updateCompareStreamBody(task) {
    const body = $("#compare-stream-body");
    if (!body) return;
    body.innerHTML = task.buffer
      ? md.render(task.buffer, { paperMap: comparisonPaperMap(task.paperIds) }) + '<span class="stream-caret"></span>'
      : '<p class="muted-line">正在建立对照维度…</p>';
  }

  function failCompare(task, message, code) {
    if (App.compareTask !== task) return;
    task.status = "error";
    task.error = message;
    task.code = code || "";
    renderCompareOutput();
    updateCompareControls();
  }

  function stopComparison() {
    if (!App.compareTask || App.compareTask.status !== "streaming") return;
    App.compareTask.status = "aborted";
    if (App.compareTask.controller) App.compareTask.controller.abort();
    App.compareTask = null;
    renderCompareOutput();
    updateCompareControls();
    toast("已停止生成", "info");
  }

  function comparisonPaperMap(ids) {
    const map = {};
    (ids || []).forEach((id, index) => { map["P" + (index + 1)] = id; });
    return map;
  }

  function renderCompareOutput() {
    const container = $("#compare-output");
    if (!container) return;
    const task = App.compareTask;
    if (!task) {
      container.innerHTML = "";
      return;
    }
    const map = comparisonPaperMap(task.paperIds);
    const chips = (task.paperIds || []).map((id, index) =>
      '<span class="paper-chip"><span class="label">P' + (index + 1) + "</span>" +
      esc(App.papers.find((paper) => paper.id === id)?.title || task.paperTitles[index] || "文献") + "</span>").join("");
    if (task.status === "streaming") {
      container.innerHTML = '<div class="compare-output-head"><span>正在综合 ' + task.paperIds.length + " 篇文献</span>" +
        '<span class="right">' + icon("sparkles") + "生成中" +
        '<button type="button" class="btn btn-sm" id="compare-stop-inline">' + icon("stop") + "停止</button></span></div>" +
        '<div class="compare-result-meta">' + chips + "</div>" +
        '<article class="card-paper streaming no-seal"><div class="stream-progress"><span></span></div>' +
        '<div class="prose" id="compare-stream-body">' +
        (task.buffer ? md.render(task.buffer, { paperMap: map }) + '<span class="stream-caret"></span>'
          : '<p class="muted-line">正在建立对照维度…</p>') +
        "</div></article>";
      const stop = $("#compare-stop-inline");
      if (stop) stop.addEventListener("click", stopComparison);
    } else if (task.status === "error") {
      container.innerHTML = '<div class="inline-error">' + icon("alert") +
        "<div><strong>对比没有生成成功</strong><br>" + esc(task.error || "") + "</div>" +
        '<span class="err-actions"><button type="button" id="compare-retry">重试</button></span></div>';
      const retry = $("#compare-retry");
      if (retry) {
        retry.addEventListener("click", () => {
          App.compareTask = null;
          startComparison();
        });
      }
    }
  }

  async function renderCompareDetail(route, seq) {
    const view = $("#view");
    view.innerHTML = '<div class="page"><div class="loading-page"><span class="spinner"></span>正在打开对比综述…</div></div>';
    let comparison;
    try {
      const result = await api("/api/comparisons/" + route.id);
      if (seq !== App.routeSeq) return;
      comparison = result.comparison;
      if (!comparison) throw new Error("对比不存在");
    } catch (error) {
      if (seq !== App.routeSeq) return;
      view.innerHTML = '<div class="page"><div class="empty-state">' +
        '<div class="empty-art">' + icon("alert") + "</div><h3>无法打开这份对比</h3><p>" + esc(error.message) + "</p>" +
        '<div class="empty-actions"><a class="btn" href="#/compare">回到对比列表</a></div></div></div>';
      return;
    }
    const map = comparisonPaperMap(comparison.paper_ids || []);
    const bodyContent = String(comparison.content || "").replace(/^\s*#\s+[^\n]*\n+/, "").trim();
    const chips = (comparison.paper_ids || []).map((id, index) =>
      '<a class="paper-chip" href="#/paper/' + encodeURIComponent(id) + '/card"><span class="label">P' + (index + 1) +
      "</span>" + esc(comparison.paper_titles[index] || App.papers.find((paper) => paper.id === id)?.title || "文献") + "</a>").join("");
    view.innerHTML = '<div class="page">' +
      '<a class="back-link" href="#/compare">' + icon("arrow-left") + "多篇对比</a>" +
      '<div class="compare-detail-head"><div class="kicker">SYNTHESIS / 对比综述</div>' +
      "<h1>" + esc(comparison.title || "文献对比") + "</h1>" +
      '<div class="meta">' + esc((comparison.paper_ids || []).length + " 篇文献 · " + formatDateTime(comparison.created_at) +
      (comparison.model ? " · " + comparison.model : "")) + "</div>" +
      (comparison.focus ? '<div class="meta">关注点：' + esc(comparison.focus) + "</div>" : "") +
      '<div class="compare-detail-actions">' +
      '<button type="button" class="btn btn-sm" id="export-compare">' + icon("download") + "导出 Markdown</button>" +
      '<button type="button" class="btn btn-sm btn-danger" id="delete-compare">' + icon("trash") + "删除" +
      "</button></div></div>" +
      '<div class="compare-result-meta">' + chips + "</div>" +
      '<article class="card-paper compare-output no-seal" style="padding:40px 48px"><div class="prose">' +
      md.render(bodyContent, { paperMap: map }) +
      "</div></article></div>";

    $("#export-compare").addEventListener("click", () => {
      const header = "# " + (comparison.title || "文献对比") + "\n\n" +
        "> " + (comparison.paper_titles || []).map((title, index) => "P" + (index + 1) + "：" + title).join("；") +
        "\n> 生成于 " + formatDateTime(comparison.created_at) + "\n\n";
      downloadText(safeFilename(comparison.title || "文献对比") + ".md", header + bodyContent);
    });
    $("#delete-compare").addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "删除这份对比综述？",
        message: "只删除对比结果，原文献和精读卡不受影响。此操作无法撤销。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api("/api/comparisons/" + comparison.id, { method: "DELETE" });
        toast("对比已删除", "success");
        location.hash = "#/compare";
      } catch (error) {
        toast(error.message, "error");
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Onboarding & bundled demo
  // ─────────────────────────────────────────────────────────────

  const ONBOARD_KEY = "landu_onboarded_v1";

  function markOnboarded() {
    try { localStorage.setItem(ONBOARD_KEY, "1"); } catch (_) { /* ignore */ }
  }

  function maybeShowOnboarding() {
    setTimeout(() => {
      if (App.modal) return;
      if (App.route.name !== "library") return;
      if (App.papers.length > 0) return;
      if (App.settings.api_key_set || aiReady()) return;
      try {
        if (localStorage.getItem(ONBOARD_KEY)) return;
      } catch (_) { /* show if storage is unavailable */ }
      openOnboarding();
    }, 750);
  }

  function openOnboarding() {
    if (App.modal) return;
    const provider = providerLabel(App.settings.provider);
    const model = App.settings.model || "deepseek-chat";
    const keyUrl = App.settings.provider === "openai"
      ? "https://platform.openai.com/api-keys"
      : App.settings.provider === "deepseek"
        ? "https://platform.deepseek.com/api_keys"
        : "";
    const keyLink = keyUrl
      ? '还没有 Key？<a href="' + keyUrl + '" target="_blank" rel="noopener">去 ' + esc(provider) + " 获取</a>，或"
      : "还没有 Key？请在你的模型服务中创建，或";
    openModal({
      title: "先把模型接上，再开始第一篇精读",
      subtitle: "第一次使用只需要这一步。你也可以先打开内置示例，不配置 Key 先看看工作台长什么样。",
      body: '<div class="onboarding">' +
        '<div class="onboarding-steps">' +
        '<div><span>01</span><strong>连接</strong><p>填入 ' + esc(provider) + ' 的 Key，测试并保存。</p></div>' +
        '<div><span>02</span><strong>放入</strong><p>拖入 PDF，或从 Zotero 读取本机文献。</p></div>' +
        '<div><span>03</span><strong>精读</strong><p>自动拆出问题、方法、证据和局限。</p></div>' +
        "</div>" +
        '<div class="field onboarding-field"><label for="onboard-key">' + esc(provider) + " API Key</label>" +
        '<div class="key-wrap"><input id="onboard-key" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 Key，仅保存在本机">' +
        '<button type="button" class="key-toggle" id="onboard-eye" aria-label="显示或隐藏 Key">' + icon("eye") + "</button></div>" +
        '<span class="hint">当前模型：' + esc(model) + " · Key 保存在本地配置文件中，不会写进笔记或对话。</span></div>" +
        '<div class="field onboarding-field"><label for="onboard-profile">你的研究方向（可选）</label>' +
        '<textarea id="onboard-profile" rows="2" placeholder="例如：水环境过程与污染控制、监测与建模、管网与溢流污染…"></textarea>' +
        '<span class="hint">会用于精读卡里的「与我的研究关联」，以后可以随时在设置中修改。</span></div>' +
        '<div id="onboard-error"></div>' +
        '<div class="onboarding-alt">' + keyLink +
        ' <button type="button" class="linklike" id="onboard-demo">先打开内置示例</button>' +
        ' · <button type="button" class="linklike" id="onboard-settings">更换模型/接口</button></div>' +
        '<div class="onboarding-privacy">' + icon("alert") + "<span>只有生成精读卡或回答问题时，论文文本才会发送给你配置的模型服务。</span></div>" +
        "</div>",
      footer: '<button type="button" class="btn btn-quiet" id="onboard-later">稍后再说</button>' +
        '<button type="button" class="btn btn-primary" id="onboard-save">测试并保存</button>',
      onClose: markOnboarded,
    });
    const root = $("#modal-root");
    const input = $("#onboard-key");
    const eye = $("#onboard-eye");
    if (eye) eye.addEventListener("click", () => {
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      eye.innerHTML = icon(shown ? "eye" : "eye-off");
    });
    if (input) setTimeout(() => input.focus(), 50);
    const showError = (message) => {
      const box = $("#onboard-error");
      if (box) box.innerHTML = '<div class="inline-error" style="margin-top:10px">' + icon("alert") +
        "<span>" + esc(message) + "</span></div>";
    };
    root.querySelector("#onboard-later").addEventListener("click", () => { markOnboarded(); closeModal(); });
    root.querySelector("#onboard-settings").addEventListener("click", () => {
      markOnboarded();
      closeModal();
      location.hash = "#/settings";
    });
    root.querySelector("#onboard-demo").addEventListener("click", () => {
      markOnboarded();
      closeModal();
      importDemo(true);
    });
    root.querySelector("#onboard-save").addEventListener("click", async () => {
      const key = input ? input.value.trim() : "";
      if (!key) {
        showError("请先粘贴 API Key。若想先体验界面，可以打开内置示例。");
        if (input) input.focus();
        return;
      }
      const profileInput = $("#onboard-profile");
      const profile = profileInput ? profileInput.value.trim() : "";
      const button = root.querySelector("#onboard-save");
      button.disabled = true;
      button.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1px"></span>测试中…';
      const errorBox = $("#onboard-error");
      if (errorBox) errorBox.innerHTML = "";
      try {
        const payload = { api_key: key };
        if (profile) payload.research_profile = profile;
        await api("/api/settings/test", { method: "POST", body: { api_key: key } });
        const response = await api("/api/settings", { method: "POST", body: payload });
        App.settings = response.settings;
        markOnboarded();
        await refreshState(true);
        closeModal();
        toast("模型已连接，可以开始上传 PDF 了", "success", 5000);
        if (App.route.name === "library") await renderRoute();
        else renderSidebar();
      } catch (error) {
        button.disabled = false;
        button.textContent = "测试并保存";
        showError(error.message + " 你可以检查 Key 是否正确、账户是否有余额；也可以先打开内置示例。");
        const box = $("#onboard-error");
        if (box && (error.code === "no_key" || error.code === "auth")) {
          box.innerHTML += '<div style="margin-top:6px"><button type="button" class="btn btn-sm" id="onboard-error-settings">去完整设置</button></div>';
          const settingsButton = $("#onboard-error-settings");
          if (settingsButton) settingsButton.addEventListener("click", () => {
            markOnboarded();
            closeModal();
            location.hash = "#/settings";
          });
        }
      }
    });
  }

  async function importDemo(openPaper) {
    if (App.demoBusy) return;
    App.demoBusy = true;
    try {
      const data = await api("/api/demo", { method: "POST" });
      markOnboarded();
      await refreshState();
      if (openPaper) location.hash = "#/paper/" + data.paper.id + "/card";
      toast(data.duplicate ? "已打开内置示例" : "已导入内置示例。它是虚构演示，可随时删除。", "info", 6000);
      return data.paper;
    } catch (error) {
      toast("打不开内置示例：" + error.message, "error", 6500);
    } finally {
      App.demoBusy = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Trash
  // ─────────────────────────────────────────────────────────────

  function trashEmptyArt() {
    return '<svg viewBox="0 0 160 120" fill="none" aria-hidden="true">' +
      '<path d="M48 40h64l-7 58H55z" stroke="currentColor" stroke-width="1.6" opacity=".55" stroke-linejoin="round"/>' +
      '<path d="M40 40h80M64 29h32M65 55v29M80 55v29M95 55v29" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>' +
      '<path d="M44 108c17-7 29-7 46 0s29 7 46 0" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".22"/>' +
      '<circle cx="80" cy="21" r="2.5" fill="currentColor" opacity=".35"/>' +
      "</svg>";
  }

  function trashRowHTML(item) {
    const metaParts = [
      esc(formatAuthors(item.authors, 3)),
      item.venue ? '<span class="venue">' + esc(item.venue) + "</span>" : "",
      esc(item.year || "年份未知"),
      esc((item.page_count || "?") + " 页"),
    ].filter(Boolean);
    return '<article class="trash-row" data-trash-id="' + esc(item.trash_id) + '">' +
      '<div class="trash-main">' +
      '<div class="trash-title">' + (item.demo ? '<span class="tag demo-tag">示例</span> ' : "") +
      esc(item.title || "未命名文献") + "</div>" +
      '<div class="trash-meta">' + metaParts.join('<span class="sep">·</span>') + "</div>" +
      '<div class="trash-time">删除于 ' + esc(formatDateTime(item.trashed_at)) +
      (item.card_updated_at ? " · 精读卡已一并保留" : "") + "</div>" +
      "</div>" +
      '<div class="trash-actions">' +
      '<button type="button" class="btn btn-sm" data-restore="' + esc(item.trash_id) + '">' + icon("refresh") + "恢复</button>" +
      '<button type="button" class="btn btn-sm btn-danger" data-purge="' + esc(item.trash_id) + '">' + icon("trash") + "彻底删除</button>" +
      "</div></article>";
  }

  async function renderTrashPage(seq) {
    const view = $("#view");
    view.innerHTML = '<div class="page"><div class="loading-page"><span class="spinner"></span>正在打开回收站…</div></div>';
    let items = [];
    try {
      const data = await api("/api/trash");
      if (seq !== App.routeSeq) return;
      items = data.items || [];
    } catch (error) {
      if (seq !== App.routeSeq) return;
      view.innerHTML = '<div class="page"><div class="empty-state">' +
        '<div class="empty-art">' + icon("alert") + "</div><h3>回收站暂时打不开</h3><p>" + esc(error.message) + "</p>" +
        '<div class="empty-actions"><a class="btn" href="#/library">回到文献库</a></div></div></div>';
      return;
    }
    const head = '<div class="page-head"><div><div class="kicker">TRASH / 回收站</div>' +
      '<h1 class="page-title">误删的文献，先放在这里</h1>' +
      '<p class="page-sub">删除的文献会连同 PDF、精读卡、对话和笔记一起保留。恢复后回到文献库；彻底删除则不可恢复，但不会影响 Zotero 原库。</p></div>' +
      (items.length
        ? '<div class="page-head-actions"><button type="button" class="btn btn-primary" id="restore-all">' +
          icon("refresh") + "全部恢复</button><button type=\"button\" class=\"btn btn-danger\" id=\"empty-trash\">" +
          icon("trash") + "清空回收站</button></div>"
        : "") +
      "</div>";

    if (!items.length) {
      view.innerHTML = '<div class="page">' + head +
        '<div class="empty-state"><div class="empty-art">' + trashEmptyArt() + "</div>" +
        "<h3>回收站是空的</h3><p>删除文献后，它会先来到这里。你可以在彻底删除前随时恢复。</p>" +
        '<div class="empty-actions"><a class="btn btn-primary" href="#/library">回到文献库</a></div></div></div>';
      updateNav();
      return;
    }

    view.innerHTML = '<div class="page">' + head +
      '<div class="trash-summary">共 ' + items.length + " 篇 · 恢复后卡片、笔记和对话都会回来</div>" +
      '<div class="trash-list">' + items.map(trashRowHTML).join("") + "</div>" +
      '<p class="setting-footnote" style="margin-top:14px">彻底删除或清空只影响工作台本地副本，不会改动 Zotero 原始库。</p></div>';

    const restoreAll = $("#restore-all");
    if (restoreAll) restoreAll.addEventListener("click", () => {
      restoreTrashItems(items.map((item) => item.trash_id));
    });
    const empty = $("#empty-trash");
    if (empty) empty.addEventListener("click", () => emptyTrash(items.length));
    $$("[data-restore]", view).forEach((button) => {
      button.addEventListener("click", () => restoreTrashItems([button.dataset.restore]));
    });
    $$("[data-purge]", view).forEach((button) => {
      const item = items.find((entry) => entry.trash_id === button.dataset.purge);
      button.addEventListener("click", () => permanentlyDeleteTrash(button.dataset.purge, item ? item.title : "这篇文献"));
    });
    updateNav();
  }

  async function restoreTrashItems(trashIds) {
    if (!trashIds.length) return;
    try {
      const result = await api("/api/trash/restore", { method: "POST", body: { trash_ids: trashIds } });
      await refreshState(true);
      if (App.route.name === "trash") await renderRoute();
      else renderSidebar();
      const restored = (result.restored || []).length;
      const failed = result.failed || [];
      const failedNote = failed.length ? "；" + failed.length + " 篇未能恢复" : "";
      toast("已恢复 " + restored + " 篇文献到文献库" + failedNote, failed.length ? "info" : "success", 6000);
    } catch (error) {
      toast("恢复失败：" + error.message, "error");
    }
  }

  async function permanentlyDeleteTrash(trashId, title) {
    const confirmed = await confirmDialog({
      title: "彻底删除这篇文献？",
      message: "将从回收站删除本地的 PDF、精读卡、对话和笔记，无法恢复。\n不会影响 Zotero 原始库。\n\n《" + (title || "未命名文献") + "》",
      confirmText: "彻底删除",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/trash/" + trashId, { method: "DELETE" });
      await refreshState(true);
      await renderRoute();
      toast("已彻底删除", "success", 4500);
    } catch (error) {
      toast("彻底删除失败：" + error.message, "error");
    }
  }

  async function emptyTrash(count) {
    const confirmed = await confirmDialog({
      title: "清空回收站？",
      message: "会彻底删除回收站里的 " + count + " 篇文献，包括本地 PDF、精读卡、对话和笔记。\n此操作不可恢复，但不会影响 Zotero 原始库。",
      confirmText: "清空回收站",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api("/api/trash", { method: "DELETE" });
      await refreshState(true);
      await renderRoute();
      const failed = Array.isArray(result.failed) ? result.failed.length : 0;
      toast(failed ? "已清空回收站，" + failed + " 篇被占用未能删除" : "回收站已清空", failed ? "info" : "success", 6000);
    } catch (error) {
      toast("清空回收站失败：" + error.message, "error");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Modals
  // ─────────────────────────────────────────────────────────────

  function openModal(config) {
    closeModal();
    App.modalReturnFocus = document.activeElement;
    const root = $("#modal-root");
    root.innerHTML = '<div class="modal-backdrop" data-modal-backdrop>' +
      '<div class="modal' + (config.wide ? " wide" : "") + '" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
      '<div class="modal-head"><div><h2 id="modal-title">' + esc(config.title) + "</h2>" +
      (config.subtitle ? "<p>" + esc(config.subtitle) + "</p>" : "") +
      '</div><button type="button" class="icon-btn modal-close" aria-label="关闭">' + icon("close") + "</button></div>" +
      '<div class="modal-body">' + (config.body || "") + "</div>" +
      (config.footer ? '<div class="modal-foot">' + config.footer + "</div>" : "") +
      "</div></div>";
    document.body.style.overflow = "hidden";
    App.modal = { config: config, root: root };
    root.querySelector(".modal-close").addEventListener("click", () => closeModal());
    root.querySelector("[data-modal-backdrop]").addEventListener("mousedown", (event) => {
      if (event.target === root.querySelector("[data-modal-backdrop]") && !config.static) closeModal();
    });
    setTimeout(() => {
      const focusable = root.querySelector("input, textarea, select") || root.querySelector("button");
      if (focusable) focusable.focus();
    }, 40);
    return root;
  }

  function closeModal() {
    const root = $("#modal-root");
    if (root) root.innerHTML = "";
    document.body.style.overflow = "";
    if (App.modal && App.modal.config && typeof App.modal.config.onClose === "function") {
      App.modal.config.onClose();
    }
    App.modal = null;
    if (App.modalReturnFocus && App.modalReturnFocus.focus) {
      try { App.modalReturnFocus.focus(); } catch (_) { /* ignore */ }
    }
    App.modalReturnFocus = null;
  }

  function confirmDialog(options) {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      openModal({
        title: options.title || "确认操作",
        body: '<p class="danger-copy">' + esc(options.message || "").replace(/\n/g, "<br>") + "</p>",
        footer: '<button type="button" class="btn" data-cancel>取消</button>' +
          '<button type="button" class="btn ' + (options.danger ? "btn-danger" : "btn-primary") + '" data-confirm>' +
          esc(options.confirmText || "确认") + "</button>",
        onClose: () => finish(false),
      });
      const root = $("#modal-root");
      root.querySelector("[data-cancel]").addEventListener("click", () => { finish(false); closeModal(); });
      root.querySelector("[data-confirm]").addEventListener("click", () => { finish(true); closeModal(); });
    });
  }

  function openEditModal() {
    if (!App.paperData) return;
    const paper = App.paperData.paper;
    openModal({
      title: "编辑题录",
      subtitle: "这些信息只用于本地的检索、引用和对比，不会改写 PDF。",
      body: '<form id="edit-form">' +
        '<div class="form-row"><label for="edit-title">标题</label><input id="edit-title" type="text" value="' + esc(paper.title || "") + '"></div>' +
        '<div class="form-row"><label for="edit-authors">作者（用分号分隔）</label><input id="edit-authors" type="text" value="' + esc((paper.authors || []).join("; ")) + '"></div>' +
        '<div class="form-2col"><div class="form-row"><label for="edit-year">年份</label><input id="edit-year" type="text" value="' + esc(paper.year || "") + '"></div>' +
        '<div class="form-row"><label for="edit-venue">期刊 / 来源</label><input id="edit-venue" type="text" value="' + esc(paper.venue || "") + '"></div></div>' +
        '<div class="form-row"><label for="edit-doi">DOI</label><input id="edit-doi" type="text" value="' + esc(paper.doi || "") + '"></div>' +
        '<div class="form-row"><label for="edit-tags">标签（用逗号分隔）</label><input id="edit-tags" type="text" value="' + esc((paper.tags || []).join("，")) + '"></div>' +
        '<div class="form-row"><label for="edit-status">阅读状态</label><select id="edit-status">' +
        ["unread", "reading", "read"].map((status) =>
          '<option value="' + status + '"' + ((paper.status || "unread") === status ? " selected" : "") + ">" +
          STATUS_LABELS[status] + "</option>").join("") + "</select></div>" +
        '<div id="edit-error"></div>' +
        "</form>",
      footer: '<button type="button" class="btn" data-cancel>取消</button>' +
        '<button type="button" class="btn btn-primary" id="save-edit">保存题录</button>',
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    root.querySelector("#save-edit").addEventListener("click", async () => {
      const payload = {
        title: $("#edit-title").value.trim(),
        authors: $("#edit-authors").value,
        year: $("#edit-year").value.trim(),
        venue: $("#edit-venue").value.trim(),
        doi: $("#edit-doi").value.trim(),
        tags: $("#edit-tags").value.split(/[，,;；]/).map((tag) => tag.trim()).filter(Boolean),
        status: $("#edit-status").value,
      };
      if (!payload.title) {
        $("#edit-error").innerHTML = '<div class="inline-error" style="margin-top:8px">' + icon("alert") + "<span>标题不能为空。</span></div>";
        return;
      }
      try {
        const response = await api("/api/papers/" + paper.id, { method: "PATCH", body: payload });
        App.paperData.paper = response.paper;
        const cached = App.papers.find((item) => item.id === paper.id);
        if (cached) Object.assign(cached, response.paper);
        await refreshState(true);
        const tab = App.route.name === "paper" ? App.route.tab : "card";
        closeModal();
        renderPaperShell(tab);
        if (tab === "source") renderSourceTab();
        toast("题录已更新", "success");
      } catch (error) {
        $("#edit-error").innerHTML = '<div class="inline-error" style="margin-top:8px">' + icon("alert") +
          "<span>" + esc(error.message) + "</span></div>";
      }
    });
  }

  async function deletePaper() {
    if (!App.paperData) return;
    const paper = App.paperData.paper;
    const ok = await confirmDialog({
      title: "将这篇文献移入回收站？",
      message: "会连同本地的 PDF、精读卡、对话与笔记一起移入回收站，可在「回收站」中恢复。\n不会改动 Zotero 原始库。\n\n《" + paper.title + "》",
      confirmText: "移入回收站",
      danger: false,
    });
    if (!ok) return;
    if (App.cardTask && App.cardTask.paperId === paper.id) {
      if (App.cardTask.controller) App.cardTask.controller.abort();
      App.cardTask = null;
    }
    if (App.chatTask && App.chatTask.paperId === paper.id) {
      if (App.chatTask.controller) App.chatTask.controller.abort();
      App.chatTask = null;
    }
    try {
      await api("/api/papers/" + paper.id, { method: "DELETE" });
      App.selected.delete(paper.id);
      App.paperData = null;
      App.pages = null;
      App.pagesPaperId = null;
      await refreshState(true);
      toast("已移入回收站", "success");
      location.hash = "#/library";
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Categories
  // ─────────────────────────────────────────────────────────────

  function categoryManageRow(category) {
    return '<div class="category-manage-row" data-category-row="' + esc(category.id) + '">' +
      categoryDot(category.color) +
      '<div class="category-manage-main"><strong>' + esc(category.name) + "</strong>" +
      "<small>" + (category.count || 0) + " 篇文献</small></div>" +
      '<div class="category-manage-actions">' +
      '<button type="button" class="btn btn-sm btn-quiet" data-edit-category="' + esc(category.id) + '">编辑</button>' +
      '<button type="button" class="btn btn-sm btn-quiet category-danger" data-delete-category="' + esc(category.id) + '">删除</button>' +
      "</div></div>";
  }

  async function refreshAfterCategoryChange() {
    await refreshState(true);
    if (App.paperData && App.paperData.paper) {
      App.paperData.paper.categories = (App.paperData.paper.categories || []).filter((categoryId) => !!categoryById(categoryId));
    }
    if (App.library.category && App.library.category !== "__uncategorized__" && !categoryById(App.library.category)) {
      App.library.category = "";
      if (App.route.name === "library") replaceLibraryHash();
    }
    if (App.route.name === "paper" && App.paperData) renderPaperShell(App.route.tab);
    else if (App.route.name === "library") renderLibrary();
  }

  function openCategoryManager() {
    const categories = categoryList();
    const existingNames = new Set(categories.map((category) => category.name.toLocaleLowerCase()));
    const suggestions = CATEGORY_SUGGESTIONS.filter((name) => !existingNames.has(name.toLocaleLowerCase())).slice(0, 4);
    const defaultColor = CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length];
    const body = '<p class="category-intro">分类用于按研究方向整理文献，一篇文献可以属于多个分类；标签仍是自动提取的关键词。</p>' +
      '<div class="category-manage-list">' +
      (categories.length
        ? categories.map(categoryManageRow).join("")
        : '<div class="category-manage-empty">还没有分类。先在下面新建一个，或点一个建议。</div>') +
      "</div>" +
      '<div class="category-create">' +
      '<div class="field"><label for="new-category-name">新建分类</label>' +
      '<div class="category-create-line"><input id="new-category-name" type="text" maxlength="24" placeholder="例如：管网入渗" autocomplete="off">' +
      '<button type="button" class="btn btn-primary btn-sm" id="create-category">新建</button></div></div>' +
      '<input type="hidden" id="new-category-color" value="' + defaultColor + '">' +
      categoryColorButtons(defaultColor) +
      (suggestions.length
        ? '<div class="category-suggestions"><span>快捷添加</span>' + suggestions.map((name) =>
          '<button type="button" data-suggest-category="' + esc(name) + '">' + esc(name) + "</button>").join("") + "</div>"
        : "") +
      "</div>";
    openModal({
      title: "管理分类",
      subtitle: "按研究方向整理文献库；删除分类不会删除文献本身。",
      wide: true,
      body: body,
      footer: '<span class="left">分类可以多选</span><button type="button" class="btn" data-cancel>完成</button>',
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const colorInput = $("#new-category-color");
    bindCategoryColors(root, colorInput);
    const nameInput = $("#new-category-name");
    const createButton = $("#create-category");

    const createCategory = async (name) => {
      const clean = String(name || "").trim();
      if (!clean) {
        toast("请先填写分类名称", "error");
        if (nameInput) nameInput.focus();
        return;
      }
      if (createButton) { createButton.disabled = true; createButton.textContent = "创建中…"; }
      try {
        const response = await api("/api/categories", {
          method: "POST",
          body: { name: clean, color: colorInput ? colorInput.value : "" },
        });
        await refreshState(true);
        openCategoryManager();
        toast("已新建分类「" + response.category.name + "」", "success");
      } catch (error) {
        if (createButton) { createButton.disabled = false; createButton.textContent = "新建"; }
        toast("新建分类失败：" + error.message, "error");
      }
    };

    if (createButton) createButton.addEventListener("click", () => createCategory(nameInput ? nameInput.value : ""));
    if (nameInput) {
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); createCategory(nameInput.value); }
      });
      setTimeout(() => nameInput.focus(), 60);
    }
    $$("[data-suggest-category]", root).forEach((button) => {
      button.addEventListener("click", () => createCategory(button.dataset.suggestCategory || ""));
    });
    $$("[data-edit-category]", root).forEach((button) => {
      button.addEventListener("click", () => {
        const category = categoryById(button.dataset.editCategory);
        if (category) openCategoryEditModal(category);
      });
    });
    $$("[data-delete-category]", root).forEach((button) => {
      button.addEventListener("click", async () => {
        const category = categoryById(button.dataset.deleteCategory);
        if (!category) return;
        const confirmed = await confirmDialog({
          title: "删除分类「" + category.name + "」？",
          message: "这个分类会从 " + (category.count || 0) + " 篇文献上移除，但不会删除文献、精读卡或笔记。",
          confirmText: "删除分类",
          danger: true,
        });
        if (!confirmed) {
          openCategoryManager();
          return;
        }
        try {
          await api("/api/categories/" + encodeURIComponent(category.id), { method: "DELETE" });
          await refreshAfterCategoryChange();
          openCategoryManager();
          toast("分类已删除", "success");
        } catch (error) {
          openCategoryManager();
          toast("删除分类失败：" + error.message, "error");
        }
      });
    });
  }

  function openCategoryEditModal(category) {
    openModal({
      title: "编辑分类",
      subtitle: "只修改分类名称或颜色，不会改动文献的阅读状态。",
      body: '<div id="category-edit-error"></div>' +
        '<div class="field"><label for="edit-category-name">分类名称</label>' +
        '<input id="edit-category-name" type="text" maxlength="24" value="' + esc(category.name) + '" autocomplete="off"></div>' +
        '<div class="field" style="margin-top:14px"><label>颜色</label>' +
        '<input type="hidden" id="edit-category-color" value="' + esc(category.color) + '">' +
        categoryColorButtons(category.color) + "</div>",
      footer: '<button type="button" class="btn" data-cancel>取消</button>' +
        '<button type="button" class="btn btn-primary" id="save-category-edit">保存</button>',
      onClose: () => {
        setTimeout(() => { if (!App.modal) openCategoryManager(); }, 0);
      },
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const colorInput = $("#edit-category-color");
    bindCategoryColors(root, colorInput);
    const nameInput = $("#edit-category-name");
    const saveButton = $("#save-category-edit");
    if (nameInput) setTimeout(() => nameInput.focus(), 60);
    const save = async () => {
      const name = nameInput ? nameInput.value.trim() : "";
      if (!name) { toast("分类名称不能为空", "error"); return; }
      if (saveButton) { saveButton.disabled = true; saveButton.textContent = "保存中…"; }
      try {
        await api("/api/categories/" + encodeURIComponent(category.id), {
          method: "PATCH",
          body: { name: name, color: colorInput ? colorInput.value : category.color },
        });
        await refreshAfterCategoryChange();
        closeModal();
        toast("分类已更新", "success");
      } catch (error) {
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = "保存"; }
        const errorBox = $("#category-edit-error");
        if (errorBox) {
          errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
            "<span>" + esc(error.message) + "</span></div>";
        }
      }
    };
    if (saveButton) saveButton.addEventListener("click", save);
    if (nameInput) {
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); save(); }
      });
    }
  }

  function openCategoryAssignModal(paperId) {
    const paper = (App.paperData && App.paperData.paper.id === paperId)
      ? App.paperData.paper
      : App.papers.find((item) => item.id === paperId);
    if (!paper) return;
    const selected = new Set(paper.categories || []);
    const categories = categoryList();
    const body = '<div id="category-assign-error"></div>' +
      '<p class="category-intro">按研究方向给这篇文献分类，可多选。分类不会替代自动提取的标签。</p>' +
      (categories.length
        ? '<div class="category-pick-list">' + categories.map((category) =>
          '<label class="category-pick' + (selected.has(category.id) ? " checked" : "") + '">' +
          '<input type="checkbox" value="' + esc(category.id) + '"' + (selected.has(category.id) ? " checked" : "") + ">" +
          categoryDot(category.color) +
          '<span class="category-pick-name">' + esc(category.name) + "</span>" +
          '<span class="category-pick-count">' + (category.count || 0) + " 篇</span></label>").join("") + "</div>"
        : '<div class="category-assign-empty">还没有分类，先去创建一个吧。' +
          '<button type="button" class="btn btn-sm" id="assign-create-category">新建分类</button></div>') +
      '<p class="setting-footnote">分类可以在侧栏的「分类 → 管理」中重命名或删除。</p>';
    openModal({
      title: "给文献分类",
      subtitle: "一篇文献可以同时属于多个研究方向。",
      body: body,
      footer: '<button type="button" class="btn btn-quiet left" id="assign-manage-categories">管理分类</button>' +
        '<button type="button" class="btn" data-cancel>取消</button>' +
        '<button type="button" class="btn btn-primary" id="save-paper-categories">保存分类</button>',
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const manage = () => openCategoryManager();
    const manageButton = $("#assign-manage-categories");
    if (manageButton) manageButton.addEventListener("click", manage);
    const createButton = $("#assign-create-category");
    if (createButton) createButton.addEventListener("click", manage);
    $$(".category-pick input", root).forEach((input) => {
      input.addEventListener("change", () => {
        const row = input.closest(".category-pick");
        if (row) row.classList.toggle("checked", input.checked);
      });
    });
    const saveButton = $("#save-paper-categories");
    if (saveButton) {
      saveButton.addEventListener("click", async () => {
        const categoryIds = $$(".category-pick input:checked", root).map((input) => input.value);
        saveButton.disabled = true;
        saveButton.textContent = "保存中…";
        try {
          const response = await api("/api/papers/" + encodeURIComponent(paperId), {
            method: "PATCH",
            body: { categories: categoryIds },
          });
          const cached = App.papers.find((item) => item.id === paperId);
          if (cached) Object.assign(cached, response.paper);
          if (App.paperData && App.paperData.paper.id === paperId) App.paperData.paper = response.paper;
          await refreshState(true);
          closeModal();
          if (App.route.name === "paper" && App.paperData) renderPaperShell(App.route.tab);
          else if (App.route.name === "library") renderLibrary();
          toast("分类已更新", "success");
        } catch (error) {
          saveButton.disabled = false;
          saveButton.textContent = "保存分类";
          const errorBox = $("#category-assign-error");
          if (errorBox) {
            errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
              "<span>" + esc(error.message) + "</span></div>";
          }
        }
      });
    }
  }

  function openBulkCategoryAssignModal() {
    const ids = Array.from(App.selected);
    if (!ids.length) return;
    const categories = categoryList();
    const body = '<div id="bulk-category-error"></div>' +
      '<p class="category-intro">给选中的 ' + ids.length + ' 篇文献加入分类；不会移除它们已有的分类。</p>' +
      (categories.length
        ? '<div class="category-pick-list">' + categories.map((category) =>
          '<label class="category-pick">' +
          '<input type="checkbox" value="' + esc(category.id) + '">' +
          categoryDot(category.color) +
          '<span class="category-pick-name">' + esc(category.name) + "</span>" +
          '<span class="category-pick-count">' + (category.count || 0) + " 篇</span></label>").join("") + "</div>"
        : '<div class="category-assign-empty">还没有分类，先去创建一个吧。' +
          '<button type="button" class="btn btn-sm" id="bulk-create-category">新建分类</button></div>') +
      '<p class="setting-footnote">分类可以多选；保存后会追加到每篇文献，不会清空原有分类。</p>';
    openModal({
      title: "给选中的 " + ids.length + " 篇文献分类",
      subtitle: "批量加入研究方向分类。",
      body: body,
      footer: '<button type="button" class="btn btn-quiet left" id="bulk-manage-categories">管理分类</button>' +
        '<button type="button" class="btn" data-cancel>取消</button>' +
        (categories.length ? '<button type="button" class="btn btn-primary" id="save-bulk-categories">保存分类</button>' : ""),
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const manage = $("#bulk-manage-categories");
    if (manage) manage.addEventListener("click", openCategoryManager);
    const create = $("#bulk-create-category");
    if (create) create.addEventListener("click", openCategoryManager);
    $$(".category-pick input", root).forEach((input) => {
      input.addEventListener("change", () => {
        const row = input.closest(".category-pick");
        if (row) row.classList.toggle("checked", input.checked);
      });
    });
    const saveButton = $("#save-bulk-categories");
    if (!saveButton) return;
    saveButton.addEventListener("click", async () => {
      const categoryIds = $$(".category-pick input:checked", root).map((input) => input.value);
      if (!categoryIds.length) {
        const errorBox = $("#bulk-category-error");
        if (errorBox) {
          errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
            "<span>请至少选择一个分类。</span></div>";
        }
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
      let updated = 0;
      try {
        for (const id of ids) {
          const paper = App.papers.find((item) => item.id === id);
          if (!paper) continue;
          const merged = Array.from(new Set([...(paper.categories || []), ...categoryIds]));
          await api("/api/papers/" + encodeURIComponent(id), {
            method: "PATCH",
            body: { categories: merged },
          });
          updated += 1;
        }
        await refreshState(true);
        App.selected.clear();
        closeModal();
        if (App.route.name === "library") renderLibrary();
        toast("已给 " + updated + " 篇文献加入分类", "success");
      } catch (error) {
        await refreshState(true).catch(() => {});
        saveButton.disabled = false;
        saveButton.textContent = "保存分类";
        const errorBox = $("#bulk-category-error");
        if (errorBox) {
          errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
            "<span>" + esc(error.message) + "</span></div>";
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Obsidian export
  // ─────────────────────────────────────────────────────────────

  function obsidianLocal() {
    return !App.settings || App.settings.lan_local !== false;
  }

  function obsidianVaults() {
    return App.settings && Array.isArray(App.settings.obsidian_vaults) ? App.settings.obsidian_vaults : [];
  }

  function defaultObsidianVault() {
    const settings = App.settings || {};
    const configured = String(settings.obsidian_vault || "").trim();
    if (configured) return configured;
    const vaults = obsidianVaults();
    const preferred = vaults.find((vault) => vault.open) || vaults[0];
    return preferred ? String(preferred.path || "") : "";
  }

  function vaultChipsHtml(selected) {
    const vaults = obsidianVaults();
    if (!vaults.length) {
      return '<p class="hint">没有自动检测到笔记库。请手动填写包含 .obsidian 的文件夹路径。</p>';
    }
    return '<div class="vault-chips">' + vaults.map((vault) => {
      const active = String(vault.path) === String(selected || "");
      return '<button type="button" class="vault-chip' + (active ? " active" : "") +
        '" data-vault-path="' + esc(vault.path) + '" title="' + esc(vault.path) + '">' +
        "<strong>" + esc(vault.name) + (vault.open ? '<span class="vault-open">当前打开</span>' : "") + "</strong>" +
        "<small>" + esc(vault.path) + "</small></button>";
    }).join("") + "</div>";
  }

  function bindVaultChips(root, input) {
    if (!root || !input) return;
    const buttons = $$("[data-vault-path]", root);
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        input.value = button.dataset.vaultPath || "";
        buttons.forEach((item) => item.classList.toggle("active", item === button));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    input.addEventListener("input", () => {
      const value = input.value.trim();
      buttons.forEach((item) => item.classList.toggle("active", item.dataset.vaultPath === value));
    });
  }

  function obsidianSummaryHtml(data) {
    const rows = [
      ["精读卡", (data.card || "").trim() ? "已包含" : "暂无"],
      ["我的收获", (data.takeaways || "").trim() ? "已包含" : "暂无"],
      ["我的笔记", (data.notes || "").trim() ? "已包含" : "暂无"],
      ["PDF 页码", "保留 [p.N] 标注"],
    ];
    return '<div class="obsidian-summary">' + rows.map(([label, value]) =>
      '<div class="obsidian-summary-row"><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>"
    ).join("") + "</div>";
  }

  function openObsidianExportModal() {
    if (!App.paperData) return;
    const paper = App.paperData.paper;
    if (App.cardTask && App.cardTask.paperId === paper.id && App.cardTask.status === "streaming") {
      toast("精读卡还在生成，完成后再存入 Obsidian", "info", 4000);
      return;
    }
    const local = obsidianLocal();
    const configuredVault = defaultObsidianVault();
    const vault = local ? configuredVault : String((App.settings && App.settings.obsidian_vault) || "");
    const folder = String((App.settings && App.settings.obsidian_folder) || "澜读文献");
    const chatCount = (App.paperData.chat || []).filter((message) => String(message.content || "").trim()).length;
    const canWrite = !!vault;
    const vaultField = local
      ? '<div class="field"><label for="obsidian-vault">Obsidian 笔记库</label>' +
        '<input id="obsidian-vault" type="text" value="' + esc(vault) + '" placeholder="选择下面的笔记库，或粘贴文件夹路径" spellcheck="false">' +
        vaultChipsHtml(vault) +
        '<span class="hint">必须是包含 .obsidian 文件夹的 Obsidian 笔记库；路径只保存在这台电脑上。</span></div>'
      : '<div class="field"><label>电脑上的 Obsidian 笔记库</label>' +
        '<div class="data-path"><span>' + icon("folder") + "</span><span>" + esc(vault || "尚未设置") + "</span></div>" +
        '<span class="hint">手机端只能写入电脑已配置的笔记库；如需更改，请到电脑的设置中操作。</span></div>';
    const body = '<div id="obsidian-export-error"></div>' +
      (!canWrite
        ? '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
          "<span>还没有设置 Obsidian 笔记库。" + (local ? "请在上方填写路径，或到设置中选择。" : "请先在电脑上设置笔记库。") + "</span></div>"
        : "") +
      vaultField +
      '<div class="field-grid" style="margin-top:14px">' +
      '<div class="field"><label for="obsidian-folder">子文件夹</label>' +
      '<input id="obsidian-folder" type="text" value="' + esc(folder) + '" placeholder="澜读文献" spellcheck="false"' + (local ? "" : " readonly") + ">" +
      '<span class="hint">相对于笔记库根目录，可写多级，例如「文献/水环境」；留空则使用「澜读文献」。</span></div>' +
      '<div class="field"><label>导出内容</label>' + obsidianSummaryHtml(App.paperData) + "</div>" +
      "</div>" +
      '<label class="check-line" style="margin-top:14px"><input type="checkbox" id="obsidian-include-chat" checked>' +
      "<span>包含追问记录" + (chatCount ? "（" + chatCount + " 条）" : "（暂无）") + "</span></label>" +
      '<div class="privacy-note">' + icon("check") +
      "<span>导出的是 Markdown 文件，带 YAML 属性、标签和页码引用。若同名笔记已在 Obsidian 中修改，澜读会另存副本，不会覆盖你的改动。</span></div>";

    openModal({
      title: "存入 Obsidian",
      subtitle: local ? "把这篇文献的精读卡、我的收获和笔记写进本机笔记库。" : "写入电脑上的 Obsidian 笔记库。",
      wide: true,
      body: body,
      footer: '<button type="button" class="btn" data-cancel>取消</button>' +
        '<a class="btn btn-quiet" href="/api/papers/' + encodeURIComponent(paper.id) + '/export">' + icon("download") + "仅下载 .md</a>" +
        '<button type="button" class="btn btn-primary btn-obsidian" id="obsidian-export-confirm">' + icon("obsidian") + "存入 Obsidian</button>",
    });

    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    if (local) {
      const input = $("#obsidian-vault");
      if (input) bindVaultChips(root, input);
    }
    $("#obsidian-export-confirm").addEventListener("click", async () => {
      const button = $("#obsidian-export-confirm");
      const errorBox = $("#obsidian-export-error");
      const vaultInput = $("#obsidian-vault");
      const folderInput = $("#obsidian-folder");
      const targetVault = local
        ? (vaultInput ? vaultInput.value.trim() : "")
        : String((App.settings && App.settings.obsidian_vault) || "");
      if (!targetVault) {
        if (errorBox) {
          errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
            "<span>请先选择或填写 Obsidian 笔记库。</span></div>";
        }
        if (vaultInput) vaultInput.focus();
        return;
      }
      if (errorBox) errorBox.innerHTML = "";
      button.disabled = true;
      button.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1px"></span>正在写入…';
      try {
        await flushNotes();
        await flushTakeaways();
        const payload = {
          include_chat: $("#obsidian-include-chat") ? $("#obsidian-include-chat").checked : true,
        };
        if (local) {
          payload.vault = targetVault;
          payload.folder = folderInput ? folderInput.value.trim() : folder;
        }
        const result = await api("/api/papers/" + paper.id + "/obsidian", { method: "POST", body: payload });
        if (result.settings) App.settings = result.settings;
        showObsidianSuccess(result);
      } catch (error) {
        if (errorBox) {
          errorBox.innerHTML = '<div class="inline-error" style="margin-bottom:14px">' + icon("alert") +
            "<span>" + esc(error.message) + "</span></div>";
        }
        button.disabled = false;
        button.innerHTML = icon("obsidian") + "存入 Obsidian";
        toast("写入 Obsidian 失败：" + error.message, "error", 6000);
      }
    });
  }

  function showObsidianSuccess(result) {
    const local = obsidianLocal();
    const messages = {
      created: ["已新建笔记", "Obsidian 会自动索引这个新文件；如果暂时没看到，稍等片刻或切换一下文件夹。"],
      updated: ["已更新笔记", "这篇文献之前由澜读写入，且你没有在 Obsidian 中改动过；内容已同步到最新版本。"],
      unchanged: ["笔记已是最新", "这次导出的内容和笔记库中已有的澜读笔记一致，没有重复写入。"],
      created_copy: ["已另存副本", "检测到同名笔记已经在 Obsidian 中改过，澜读没有覆盖它，而是另存了一份新笔记。"],
    };
    const [title, description] = messages[result.mode] || messages.created;
    const remoteNote = local ? "" :
      '<p class="setting-footnote" style="margin-top:10px">文件已写入电脑上的笔记库；手机浏览器无法直接唤起电脑端的 Obsidian。</p>';
    const openLink = local
      ? '<a class="btn btn-primary btn-obsidian" href="obsidian://open?path=' + encodeURIComponent(result.path) +
        '" target="_blank" rel="noopener">' + icon("obsidian") + "在 Obsidian 中打开</a>"
      : "";
    openModal({
      title: "已存入 Obsidian",
      body: '<div class="obsidian-success">' +
        '<div class="obsidian-success-mark">' + icon("check") + "</div>" +
        '<h3 style="margin:0;color:var(--ink-soft);font-family:var(--serif);font-size:19px">' + esc(title) + "</h3>" +
        '<p style="margin:6px 0 14px">' + esc(description) + "</p>" +
        '<div class="data-path"><span>' + icon("folder") + "</span><span>" + esc(result.rel_path || result.filename) + "</span></div>" +
        '<p class="setting-footnote" style="margin-top:8px">笔记库：' + esc(result.vault_name || "") + " · " + esc(result.vault || "") + "</p>" +
        remoteNote + "</div>",
      footer: '<button type="button" class="btn" data-cancel>关闭</button>' +
        '<button type="button" class="btn btn-quiet" data-copy-obsidian-path>复制路径</button>' +
        openLink,
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const copyButton = root.querySelector("[data-copy-obsidian-path]");
    if (copyButton) copyButton.addEventListener("click", () => copyText(result.path || ""));
    toast("已写入 Obsidian：" + (result.filename || "笔记"), "success", 5000);
  }

  // ─────────────────────────────────────────────────────────────
  // Zotero
  // ─────────────────────────────────────────────────────────────

  function openZoteroModal() {
    openModal({
      title: "从 Zotero 导入",
      subtitle: "读取本机 Zotero 的条目。带 PDF 的可直接导入，没有 PDF 的会标注出来。",
      wide: true,
      body: '<div class="zotero-search"><label class="search-field">' + icon("search") +
        '<input id="zotero-q" type="search" placeholder="搜索标题、作者或关键词…" autocomplete="off"></label></div>' +
        '<div id="zotero-error"></div>' +
        '<div class="zotero-list" id="zotero-list"><div class="zotero-empty"><span class="spinner"></span>正在读取 Zotero…</div></div>',
      footer: '<span class="left">Zotero 需在本机运行；导入会复制一份 PDF 到本地文献库。</span>' +
        '<button type="button" class="btn" data-cancel>关闭</button>',
    });
    const root = $("#modal-root");
    root.querySelector("[data-cancel]").addEventListener("click", closeModal);
    const input = $("#zotero-q");
    input.addEventListener("input", debounce(() => loadZotero(input.value), 360));
    setTimeout(() => input.focus(), 80);
    loadZotero("");
  }

  async function loadZotero(query) {
    const list = $("#zotero-list");
    const errorBox = $("#zotero-error");
    if (!list) return;
    if (errorBox) errorBox.innerHTML = "";
    list.innerHTML = '<div class="zotero-empty"><span class="spinner"></span>正在读取 Zotero…</div>';
    try {
      const result = await api("/api/zotero/search?q=" + encodeURIComponent(query || "") + "&limit=30");
      const items = result.items || [];
      list.innerHTML = items.length ? items.map(zoteroItemHTML).join("") :
        '<div class="zotero-empty">没有找到匹配的文献。可以换个关键词，或先在 Zotero 里下载 PDF。</div>';
      bindZoteroItems();
    } catch (error) {
      list.innerHTML = '<div class="zotero-empty">暂时读不到 Zotero</div>';
      if (errorBox) {
        errorBox.innerHTML = '<div class="zotero-error">' + icon("alert") +
          "<div>" + esc(error.message) + '<div style="margin-top:5px"><button type="button" class="btn-quiet" id="zotero-retry">重试</button></div></div></div>';
        const retry = $("#zotero-retry");
        if (retry) retry.addEventListener("click", () => loadZotero($("#zotero-q") ? $("#zotero-q").value : ""));
      }
    }
  }

  function zoteroItemHTML(item) {
    const existing = App.papers.find((paper) => {
      if (item.doi && paper.doi) return paper.doi.toLowerCase() === item.doi.toLowerCase();
      return (paper.title || "").toLowerCase() === (item.title || "").toLowerCase();
    });
    let action;
    if (existing) {
      action = '<button type="button" class="btn btn-sm" data-open-paper="' + esc(existing.id) + '">打开</button>';
    } else if (!item.has_pdf) {
      action = '<button type="button" class="btn btn-sm" disabled>无 PDF</button>';
    } else {
      action = '<button type="button" class="btn btn-primary btn-sm" data-zotero-import="' + esc(item.key) + '">导入</button>';
    }
    return '<div class="zotero-item"><div class="zitem-main"><div class="zitem-title">' + esc(item.title) + "</div>" +
      '<div class="zitem-meta">' + esc(formatAuthors(item.authors, 2)) + " · " + esc(item.year || "年份未知") +
      (item.venue ? " · " + esc(item.venue) : "") +
      '<span class="pdf-badge' + (item.has_pdf ? "" : " missing") + '">' + (item.has_pdf ? "PDF" : "无 PDF") + "</span></div></div>" +
      '<div class="zitem-actions">' + action + "</div></div>";
  }

  function bindZoteroItems() {
    $$("[data-open-paper]").forEach((button) => {
      button.addEventListener("click", () => {
        closeModal();
        location.hash = "#/paper/" + button.dataset.openPaper + "/card";
      });
    });
    $$("[data-zotero-import]").forEach((button) => {
      button.addEventListener("click", async () => {
        const original = button.textContent;
        button.disabled = true;
        button.innerHTML = '<span class="spinner" style="width:11px;height:11px;border-width:1px"></span>导入中';
        try {
          const result = await api("/api/zotero/import", { method: "POST", body: { key: button.dataset.zoteroImport } });
          await refreshState();
          closeModal();
          toast(result.duplicate ? "文献库中已有这篇，已为你打开" : "已从 Zotero 导入", "success");
          const auto = !result.duplicate && App.settings.auto_analyze && aiReady();
          location.hash = "#/paper/" + result.paper.id + "/card" + (auto ? "?analyze=1" : "");
        } catch (error) {
          button.disabled = false;
          button.textContent = original;
          toast(error.message, "error", 6000);
          const errorBox = $("#zotero-error");
          if (errorBox) {
            errorBox.innerHTML = '<div class="zotero-error">' + icon("alert") + "<div>" + esc(error.message) + "</div></div>";
          }
        }
      });
    });
  }
})();
