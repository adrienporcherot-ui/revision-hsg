/* HSG Revision: static single-page app.
 * Content lives in data/<course>/*.json, progress in localStorage. No build step, no server. */
(function () {
  "use strict";

  const STORAGE_KEY = "hsg-revision-v2";
  const DAY = 24 * 60 * 60 * 1000;
  const MOCK_MINUTES = 30;
  const TODAY_MAX_TASKS = 6;
  const TODAY_MAX_PER_COURSE = 2;

  const $main = document.getElementById("main");
  const $tooltip = document.getElementById("tooltip");

  /* ---------- Utilities ---------- */

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function fmtDate(ts, withTime) {
    const o = { day: "numeric", month: "short" };
    if (withTime) Object.assign(o, { hour: "2-digit", minute: "2-digit" });
    return new Date(ts).toLocaleString("en-GB", o);
  }

  function fmtPts(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  }

  // Swiss grade: 1 + 5 × (points / total), rounded to the nearest 0.25.
  function swissGrade(points, total) {
    if (!total) return 1;
    return Math.round((1 + 5 * (points / total)) * 4) / 4;
  }

  function fmtGrade(g) {
    return g.toFixed(2).replace(/0$/, "");
  }

  function gradeClass(g) {
    return g >= 5 ? "good" : g >= 4 ? "ok" : "bad";
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for browsers without async clipboard access.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ---------- Storage ---------- */

  function loadState() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (e) { s = {}; }
    s.theme = s.theme || "auto";
    s.read = s.read || {};           // course -> chapter -> timestamp
    s.practice = s.practice || {};   // course -> chapter -> [{date, score, total}]
    s.mocks = s.mocks || {};         // course -> mockId -> [attempt]
    s.drafts = s.drafts || {};       // "course/mockId" -> {start, answers}
    s.today = s.today || null;       // {date, tasks, done}
    return s;
  }

  let state = loadState();

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast("Could not save progress (browser storage unavailable)."); }
  }

  const bucket = (obj, ...keys) => keys.reduce((o, k) => (o[k] = o[k] || {}), obj);

  /* ---------- Theme ---------- */

  const themeBtn = document.getElementById("theme-toggle");
  const svgIcon = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const THEME_ICONS = {
    auto: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'),
    light: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svgIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  };

  function applyTheme() {
    if (state.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = state.theme;
    themeBtn.innerHTML = THEME_ICONS[state.theme];
    themeBtn.title = "Theme: " + state.theme + " (click to change)";
  }

  themeBtn.addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    save();
    applyTheme();
    toast("Theme: " + state.theme);
    if (location.hash.startsWith("#/settings")) route();
  });

  /* ---------- Data loading ---------- */

  let courses = [];          // from data/courses.json
  const content = {};        // courseId -> {title, info, chapters: [...], courseMock, error?}

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    return res.json();
  }

  async function loadCourse(c) {
    let meta;
    try {
      meta = await fetchJSON(`data/${c.id}/course.json`);
    } catch (e) {
      return { chapters: [], missing: true };
    }
    const chapters = await Promise.all((meta.chapters || []).map(async (chId) => {
      try {
        const ch = await fetchJSON(`data/${c.id}/${chId}.json`);
        ch.id = ch.id || chId;
        ch.practice = ch.practice || [];
        ch.summary = ch.summary || {};
        return ch;
      } catch (e) {
        return { id: chId, title: chId, error: e.message, practice: [], summary: {} };
      }
    }));
    return { ...meta, chapters };
  }

  async function loadAll() {
    const index = await fetchJSON("data/courses.json");
    courses = index.courses || [];
    await Promise.all(courses.map(async (c) => { content[c.id] = await loadCourse(c); }));
  }

  const findChapter = (courseId, chId) => (content[courseId]?.chapters || []).find((ch) => ch.id === chId);
  const chapterLabel = (ch) => (ch.number ? `Ch. ${ch.number} ` : "") + ch.title;

  function conceptName(courseId, chId, topicId) {
    const ch = findChapter(courseId, chId);
    const c = ch && (ch.summary.concepts || []).find((x) => x.id === topicId);
    return c ? c.name : topicId;
  }

  // Mock definition: a chapter mock or the whole-course mock ("full").
  function getMock(courseId, mockId) {
    const data = content[courseId];
    if (!data) return null;
    if (mockId === "full") {
      if (!data.courseMock || !(data.courseMock.questions || []).length) return null;
      return { id: "full", title: `${courseById(courseId).name}: full-course mock exam`, questions: data.courseMock.questions, minutes: data.courseMock.minutes || MOCK_MINUTES };
    }
    const ch = findChapter(courseId, mockId);
    if (!ch || !ch.mock || !(ch.mock.questions || []).length) return null;
    return {
      id: ch.id,
      title: `${courseById(courseId).name}, ${chapterLabel(ch)}: mock exam`,
      questions: ch.mock.questions.map((q) => ({ ...q, chapter: q.chapter || ch.id })),
      minutes: ch.mock.minutes || MOCK_MINUTES,
    };
  }

  const courseById = (id) => courses.find((c) => c.id === id);

  /* ---------- Progress helpers ---------- */

  function practiceAttempts(courseId, chId) { return (state.practice[courseId] || {})[chId] || []; }
  function mockAttempts(courseId, mockId) { return (state.mocks[courseId] || {})[mockId] || []; }
  function isRead(courseId, chId) { return !!(state.read[courseId] || {})[chId]; }

  function bestGrade(courseId, mockId) {
    const a = mockAttempts(courseId, mockId);
    return a.length ? Math.max(...a.map((x) => x.grade)) : null;
  }
  function lastGrade(courseId, mockId) {
    const a = mockAttempts(courseId, mockId);
    return a.length ? a[a.length - 1].grade : null;
  }
  function bestPractice(courseId, chId) {
    const a = practiceAttempts(courseId, chId);
    return a.length ? Math.max(...a.map((x) => Math.round((x.score / x.total) * 100))) : null;
  }

  function courseProgress(courseId) {
    const data = content[courseId];
    const chs = data.chapters || [];
    const read = chs.filter((ch) => isRead(courseId, ch.id)).length;
    const practiced = chs.filter((ch) => practiceAttempts(courseId, ch.id).length).length;
    const mocked = chs.filter((ch) => mockAttempts(courseId, ch.id).length).length;
    const grades = Object.values(state.mocks[courseId] || {}).flat().map((a) => a.grade);
    return {
      chapters: chs.length, read, practiced, mocked,
      avgGrade: grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null,
      attempts: grades.length,
    };
  }

  /* ---------- Markdown (small subset) ---------- */

  // Inline Markdown: `code`, **bold**, *italic* (nesting allowed, e.g. **a *b***).
  // Stray asterisks such as "p*" or "x * y" stay literal.
  function inline(s) {
    return String(s ?? "").split(/(`[^`]+`)/).map((part) =>
      /^`[^`]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : emphasis(part)).join("");
  }

  function emphasis(s) {
    const out = [];
    const stack = []; // open delimiters: { tag, idx }
    const isSpace = (ch) => ch === undefined || /\s/.test(ch);
    const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
    const re = /\*+/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      out.push(esc(s.slice(last, m.index)));
      last = re.lastIndex;
      const prev = s[m.index - 1], next = s[re.lastIndex];
      let n = m[0].length;
      const canOpen = !isSpace(next) && (n >= 2 || !isWord(prev));
      const canClose = !isSpace(prev) && (n >= 2 || !isWord(next));
      const closes = [];
      if (canClose) {
        while (n > 0 && stack.length) {
          const top = stack[stack.length - 1];
          const need = top.tag === "strong" ? 2 : 1;
          if (n < need || (top.tag === "em" && n === 2 && canOpen)) break;
          stack.pop();
          out[top.idx] = `<${top.tag}>`;
          closes.push(`</${top.tag}>`);
          n -= need;
        }
      }
      if (closes.length && n > 0 && !(canOpen && isWord(next))) { out.push("*".repeat(n)); n = 0; }
      out.push(...closes);
      if (n > 0 && canOpen) {
        const tags = n >= 3 ? ["em", "strong"] : n === 2 ? ["strong"] : ["em"];
        if (n > 3) out.push("*".repeat(n - 3));
        for (const tag of tags) { stack.push({ tag, idx: out.length }); out.push(tag === "strong" ? "**" : "*"); }
      } else if (n > 0) out.push("*".repeat(n));
    }
    out.push(esc(s.slice(last)));
    return out.join("");
  }

  function renderMarkdown(src) {
    const lines = Array.isArray(src) ? src.flatMap((l) => String(l).split("\n")) : String(src ?? "").split("\n");
    let html = "";
    let i = 0;
    const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const isBlockStart = (l) => /^(#{1,3}\s|\s*\||\s*>|\s*[-*]\s|\s*\d+[.)]\s)/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const level = m[1].length + 2;
        html += `<h${level}>${inline(m[2])}</h${level}>`;
        i++;
      } else if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const head = splitRow(rows[0]);
        const body = rows.slice(1).filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(splitRow);
        html += '<div class="table-wrap"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join("") +
          "</tr></thead><tbody>" + body.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table></div>";
      } else if (/^\s*>/.test(line)) {
        const parts = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) parts.push(lines[i++].replace(/^\s*>\s?/, ""));
        html += `<blockquote><p>${inline(parts.join(" "))}</p></blockquote>`;
      } else if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
        html += "<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>";
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
        html += "<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>";
      } else {
        const parts = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) parts.push(lines[i++]);
        html += `<p>${parts.map(inline).join("<br>")}</p>`;
      }
    }
    return html;
  }

  const mdList = (items) => "<ul>" + (items || []).map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>";

  /* ---------- Router ---------- */

  let cleanup = null; // per-view teardown (timers, key listeners)

  function setView(html) {
    if (cleanup) { cleanup(); cleanup = null; }
    $main.innerHTML = html;
    $tooltip.hidden = true;
  }

  function setActiveNav(name) {
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  }

  function parseHash() {
    const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
    const params = new URLSearchParams(query || "");
    return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params };
  }

  function route() {
    const { parts, params } = parseHash();
    const scrollTarget = params.get("concept");
    if (parts[0] === "course" && parts[1]) {
      const course = courseById(parts[1]);
      if (!course) return renderNotFound();
      setActiveNav("courses");
      if (parts[2] === "ch" && parts[3]) {
        const ch = findChapter(course.id, parts[3]);
        if (!ch) return renderNotFound();
        const tab = parts[4] || "summary";
        if (tab === "practice") renderPractice(course, ch);
        else renderSummary(course, ch, scrollTarget);
        return;
      }
      if (parts[2] === "mock" && parts[3]) return renderMock(course, parts[3]);
      return renderCourse(course);
    }
    window.scrollTo(0, 0);
    if (parts[0] === "today") { setActiveNav("today"); return renderToday(); }
    if (parts[0] === "progress") { setActiveNav("progress"); return renderProgress(); }
    if (parts[0] === "settings") { setActiveNav("settings"); return renderSettings(); }
    setActiveNav("courses");
    renderHome();
  }

  function renderNotFound() {
    setView(`<div class="panel"><h1>Not found</h1><p>This page does not exist. <a href="#/">Back to courses</a></p></div>`);
  }

  /* ---------- Home: courses ---------- */

  function courseCardHTML(c) {
    const data = content[c.id];
    const p = courseProgress(c.id);
    const hasContent = p.chapters > 0;
    const pctRead = hasContent ? Math.round((p.read / p.chapters) * 100) : 0;
    return `
      <article class="course-card" style="--c:${esc(c.color)}">
        <div class="course-head">
          <div class="course-icon" aria-hidden="true">${esc(c.icon || c.name[0])}</div>
          <div>
            <h2><a href="#/course/${esc(c.id)}">${esc(c.name)}</a></h2>
            <div class="small muted">${hasContent ? `${p.chapters} chapter${p.chapters === 1 ? "" : "s"}` : "No PDFs yet"}</div>
          </div>
        </div>
        ${hasContent ? `
          <div>
            <div class="meter-label"><span>Summaries read</span><span>${p.read}/${p.chapters}</span></div>
            <div class="meter" role="progressbar" aria-valuenow="${pctRead}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(c.name)} summaries read"><span style="width:${pctRead}%"></span></div>
          </div>
          <div class="row small muted">
            <span>Practice: ${p.practiced}/${p.chapters}</span>·
            <span>Mocks: ${p.mocked}/${p.chapters}</span>·
            <span>${p.avgGrade === null ? "No grade yet" : "Avg grade " + fmtGrade(Math.round(p.avgGrade * 4) / 4)}</span>
          </div>
          <a class="btn primary" href="#/course/${esc(c.id)}">Open course</a>`
        : `<p class="small muted">${data.error ? esc(data.error) : `Add the lecture PDFs for ${esc(c.name)} and the content will appear here.`}</p>`}
      </article>`;
  }

  function renderHome() {
    const withContent = courses.filter((c) => content[c.id].chapters.length);
    const without = courses.filter((c) => !content[c.id].chapters.length);
    const plan = ensureTodayPlan();
    const open = plan.tasks.filter((t) => !taskDone(t)).length;
    setView(`
      <section class="hero">
        <div>
          <h1>Your courses</h1>
          <p class="muted">${open ? `${open} task${open === 1 ? "" : "s"} left in <a href="#/today">today's plan</a>.` : `Today's plan is done. <a href="#/today">See it</a>.`}</p>
        </div>
      </section>
      <section class="grid">${withContent.map(courseCardHTML).join("")}</section>
      ${without.length ? `<h2 class="section-title">Waiting for material</h2><section class="grid">${without.map(courseCardHTML).join("")}</section>` : ""}`);
  }

  /* ---------- Course overview ---------- */

  function gradeChip(g) {
    return g === null ? "" : `<span class="chip grade ${gradeClass(g)}">${fmtGrade(g)}</span>`;
  }

  function renderCourse(c) {
    const data = content[c.id];
    window.scrollTo(0, 0);
    if (!data.chapters.length) {
      setView(`
        <a class="back" href="#/">← All courses</a>
        <div class="course-header" style="--c:${esc(c.color)}"><div class="course-icon" aria-hidden="true">${esc(c.icon)}</div><h1>${esc(c.name)}</h1></div>
        <div class="panel"><p>No lecture PDFs for this course yet. Once you add them (see Settings → “Adding new PDFs”), the summaries, practice questions and mock exams will appear here.</p></div>`);
      return;
    }
    const full = getMock(c.id, "full");
    setView(`
      <div style="--c:${esc(c.color)}">
        <a class="back" href="#/">← All courses</a>
        <div class="course-header">
          <div class="course-icon" aria-hidden="true">${esc(c.icon)}</div>
          <div><h1>${esc(c.name)}</h1>${data.title ? `<div class="small muted">${esc(data.title)}</div>` : ""}</div>
        </div>
        ${data.info ? `<details class="panel info"><summary><strong>About this course</strong></summary><div class="prose">${renderMarkdown(data.info)}</div></details>` : ""}
        <h2 class="section-title">Chapters</h2>
        <div class="chapter-list">
          ${data.chapters.map((ch) => {
            const read = isRead(c.id, ch.id);
            const pb = bestPractice(c.id, ch.id);
            const g = bestGrade(c.id, ch.id);
            return `
              <article class="chapter-row">
                <div class="chapter-main">
                  <div class="chapter-num">${esc(ch.number || "")}</div>
                  <div>
                    <h3><a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary">${esc(ch.title)}</a></h3>
                    <div class="row small muted status-line">
                      <span class="${read ? "ok-text" : ""}">${read ? "✓ Summary read" : "Summary not read"}</span>·
                      <span>${pb === null ? "No practice yet" : "Practice best " + pb + "%"}</span>·
                      <span>${g === null ? "No mock yet" : "Mock best"} ${gradeChip(g)}</span>
                    </div>
                  </div>
                </div>
                <div class="chapter-actions">
                  <a class="btn small" href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary">Summary</a>
                  <a class="btn small" href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/practice">Practice</a>
                  ${ch.mock ? `<a class="btn small" href="#/course/${esc(c.id)}/mock/${esc(ch.id)}">Mock exam</a>` : ""}
                </div>
              </article>`;
          }).join("")}
        </div>
        <h2 class="section-title">Mock exams</h2>
        <div class="mock-list">
          ${full ? mockCardHTML(c, full, true) : ""}
          ${data.chapters.map((ch) => getMock(c.id, ch.id)).filter(Boolean).map((m) => mockCardHTML(c, m, false)).join("")}
        </div>
      </div>`);
  }

  function mockCardHTML(c, mock, isFull) {
    const total = mock.questions.reduce((n, q) => n + q.points, 0);
    const ch = isFull ? null : findChapter(c.id, mock.id);
    const best = bestGrade(c.id, mock.id);
    const n = mockAttempts(c.id, mock.id).length;
    return `
      <a class="mock-card ${isFull ? "full" : ""}" href="#/course/${esc(c.id)}/mock/${esc(mock.id)}">
        <div>
          <strong>${isFull ? "Full course" : esc(chapterLabel(ch))}</strong>
          <div class="small muted">${mock.minutes} min · ${fmtPts(total)} points · ${mock.questions.length} questions</div>
        </div>
        <div class="mock-card-right">${best === null ? `<span class="small muted">Not taken</span>` : `<span class="small muted">${n} attempt${n === 1 ? "" : "s"}</span> ${gradeChip(best)}`}</div>
      </a>`;
  }

  /* ---------- Chapter shell ---------- */

  function chapterShell(c, ch, tab, body) {
    const data = content[c.id];
    const idx = data.chapters.indexOf(ch);
    const prev = data.chapters[idx - 1], next = data.chapters[idx + 1];
    return `
      <div style="--c:${esc(c.color)}">
        <a class="back" href="#/course/${esc(c.id)}">← ${esc(c.name)}</a>
        <div class="course-header">
          <div class="course-icon" aria-hidden="true">${esc(ch.number || c.icon)}</div>
          <div>
            <h1>${esc(ch.title)}</h1>
            <div class="small muted">${esc(c.name)}${ch.number ? " · Chapter " + esc(ch.number) : ""}</div>
          </div>
        </div>
        ${ch.error ? `<div class="notice">Could not load this chapter (${esc(ch.error)}).</div>` : ""}
        <nav class="tabs" aria-label="Chapter sections">
          <a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary" class="${tab === "summary" ? "active" : ""}">Summary</a>
          <a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/practice" class="${tab === "practice" ? "active" : ""}">Practice <span class="muted">(${ch.practice.length})</span></a>
          ${ch.mock ? `<a href="#/course/${esc(c.id)}/mock/${esc(ch.id)}">Mock exam</a>` : ""}
        </nav>
        <div id="view">${body}</div>
        <nav class="pager no-print" aria-label="Other chapters">
          ${prev ? `<a class="btn small" href="#/course/${esc(c.id)}/ch/${esc(prev.id)}/${tab}">← ${esc(chapterLabel(prev))}</a>` : "<span></span>"}
          ${next ? `<a class="btn small" href="#/course/${esc(c.id)}/ch/${esc(next.id)}/${tab}">${esc(chapterLabel(next))} →</a>` : "<span></span>"}
        </nav>
      </div>`;
  }

  /* ---------- Summary ---------- */

  function renderSummary(c, ch, scrollConcept) {
    const s = ch.summary;
    const concepts = s.concepts || [];
    const ef = s.examFocus || {};
    const read = isRead(c.id, ch.id);
    const sections = [
      ["big-picture", "Big Picture"], ["key-concepts", "Key Concepts"], ["connections", "Connections"],
      ["exam-focus", "Exam Focus"], ["memorize", "Definitions / Formulas to Memorize"],
    ];
    if ((s.gaps || []).length) sections.push(["gaps", "Unclear or missing"]);
    const body = `
      <div class="row no-print summary-tools">
        <nav class="toc" aria-label="Summary sections">${sections.map(([id, t]) => `<a href="#" data-jump="${id}" class="chip">${esc(t)}</a>`).join("")}</nav>
        <span class="spacer"></span>
        <button class="btn small" type="button" data-print>Print / PDF</button>
      </div>
      ${(ch.sources || []).length ? `<p class="small muted">Based on: ${ch.sources.map(esc).join(" · ")}</p>` : ""}
      <section class="panel prose summary-section" id="big-picture">
        <h2>Big Picture</h2>
        ${mdList(s.bigPicture)}
      </section>
      <section class="summary-section" id="key-concepts">
        <h2 class="section-title">Key Concepts <span class="muted small">(${concepts.length}, in slide order)</span></h2>
        <div class="concept-index panel no-print">${concepts.map((k, i) => `<a href="#" data-jump="concept-${esc(k.id)}">${i + 1}. ${esc(k.name)}</a>`).join("")}</div>
        ${concepts.map((k, i) => `
          <article class="panel concept" id="concept-${esc(k.id)}">
            <header class="concept-head">
              <h3><span class="concept-num">${i + 1}</span>${esc(k.name)}</h3>
              ${k.slides ? `<span class="chip">${esc(k.slides)}</span>` : ""}
            </header>
            <div class="layer simple"><div class="layer-label">Simple</div><div class="prose">${renderMarkdown(k.simple)}</div></div>
            <div class="layer exam"><div class="layer-label">Exam</div><div class="prose">${renderMarkdown(k.exam)}</div></div>
            ${k.example ? `<div class="layer example"><div class="layer-label">Example</div><div class="prose">${renderMarkdown(k.example)}</div></div>` : ""}
          </article>`).join("")}
      </section>
      <section class="panel prose summary-section" id="connections">
        <h2>Connections</h2>
        ${mdList(s.connections)}
      </section>
      <section class="panel prose summary-section" id="exam-focus">
        <h2>Exam Focus</h2>
        <h3>Most likely exam questions</h3>${mdList(ef.questions)}
        <h3>Typical traps</h3>${mdList(ef.traps)}
        ${(ef.mistakes || []).length ? `<h3>Common student mistakes</h3>${mdList(ef.mistakes)}` : ""}
      </section>
      <section class="panel prose summary-section memorize" id="memorize">
        <h2>Definitions / Formulas to Memorize</h2>
        ${mdList(s.memorize)}
      </section>
      ${(s.gaps || []).length ? `
      <section class="panel prose summary-section gaps" id="gaps">
        <h2>Unclear or missing in your materials</h2>
        ${mdList(s.gaps)}
      </section>` : ""}
      <div class="panel read-box no-print">
        ${read
          ? `<p>✓ You marked this summary as read on ${fmtDate(state.read[c.id][ch.id])}.</p><div class="row"><a class="btn primary" href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/practice">Practice questions →</a><button class="btn" type="button" data-unread>Mark as unread</button></div>`
          : `<p>Finished reading? Mark it so your study plan knows.</p><div class="row"><button class="btn primary" type="button" data-read>✓ Mark summary as read</button></div>`}
      </div>`;
    setView(chapterShell(c, ch, "summary", body));

    $main.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const el = document.getElementById(a.dataset.jump);
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }));
    $main.querySelector("[data-print]").addEventListener("click", () => window.print());
    const r = $main.querySelector("[data-read]");
    if (r) r.addEventListener("click", () => {
      bucket(state.read, c.id)[ch.id] = Date.now();
      save();
      toast("Summary marked as read");
      renderSummary(c, ch);
      document.querySelector(".read-box").scrollIntoView({ block: "center" });
    });
    const u = $main.querySelector("[data-unread]");
    if (u) u.addEventListener("click", () => {
      delete bucket(state.read, c.id)[ch.id];
      save();
      renderSummary(c, ch);
      document.querySelector(".read-box").scrollIntoView({ block: "center" });
    });

    if (scrollConcept) {
      const el = document.getElementById("concept-" + scrollConcept);
      if (el) {
        el.classList.add("highlight");
        requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
      }
    } else {
      window.scrollTo(0, 0);
    }
  }

  /* ---------- Practice (multiple choice, one at a time) ---------- */

  function renderPractice(c, ch) {
    window.scrollTo(0, 0);
    const n = ch.practice.length;
    if (!n) {
      setView(chapterShell(c, ch, "practice", `<div class="panel">No practice questions for this chapter yet.</div>`));
      return;
    }
    const attempts = practiceAttempts(c.id, ch.id);
    const best = bestPractice(c.id, ch.id);
    const last = attempts.length ? Math.round((attempts[attempts.length - 1].score / attempts[attempts.length - 1].total) * 100) : null;
    setView(chapterShell(c, ch, "practice", `
      <div class="panel setup">
        <div class="stats">
          <div class="stat"><div class="v">${n}</div><div class="l">Questions</div></div>
          <div class="stat"><div class="v">${attempts.length}</div><div class="l">Rounds done</div></div>
          <div class="stat"><div class="v">${best === null ? "–" : best + "%"}</div><div class="l">Best score</div></div>
          <div class="stat"><div class="v">${last === null ? "–" : last + "%"}</div><div class="l">Last score</div></div>
        </div>
        <p class="small muted">Multiple choice, 4 options, exactly one correct. You see the correct answer and an explanation after each question.</p>
        <div><button class="btn primary" type="button" data-start>Start practice</button></div>
      </div>`));
    $main.querySelector("[data-start]").addEventListener("click", () => startPractice(c, ch, shuffle(ch.practice)));
  }

  function startPractice(c, ch, questions) {
    const view = document.getElementById("view");
    let idx = 0, score = 0, answered = false;
    const mistakes = [];

    function show() {
      const q = questions[idx];
      answered = false;
      const opts = shuffle(q.options.map((text, i) => ({ text, correct: i === q.answer })));
      view.innerHTML = `
        <div class="panel study">
          <div class="study-top"><span>Question ${idx + 1} of ${questions.length}</span><span>Score: ${score}</span></div>
          <div class="progressbar"><span style="width:${(idx / questions.length) * 100}%"></span></div>
          <div class="quiz-q">${inline(q.question)}</div>
          <div class="options">
            ${opts.map((o, i) => `<button class="option" type="button" data-i="${i}"><span class="letter">${"ABCD"[i]}</span><span>${inline(o.text)}</span></button>`).join("")}
          </div>
          <div data-feedback aria-live="polite"></div>
        </div>`;
      view.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => answer(+b.dataset.i)));

      function answer(i) {
        if (answered) return;
        answered = true;
        const ok = opts[i].correct;
        if (ok) score++;
        else mistakes.push({ q, chosen: opts[i].text });
        view.querySelectorAll(".option").forEach((b, j) => {
          b.disabled = true;
          if (opts[j].correct) b.classList.add("correct");
          else if (j === i) b.classList.add("wrong");
        });
        const right = opts.find((o) => o.correct).text;
        const fb = view.querySelector("[data-feedback]");
        fb.innerHTML = `
          <div class="explanation ${ok ? "" : "bad"}">
            <strong>${ok ? "✓ Correct!" : "✗ Not quite. Correct answer: " + inline(right)}</strong>
            ${q.explanation ? `<div>${inline(q.explanation)}</div>` : ""}
            ${q.topic ? `<div class="small" style="margin-top:6px"><a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary?concept=${esc(q.topic)}">Review: ${esc(conceptName(c.id, ch.id, q.topic))} →</a></div>` : ""}
          </div>
          <div class="row" style="margin-top:14px;justify-content:flex-end">
            <button class="btn primary" type="button" data-next>${idx + 1 < questions.length ? "Next question →" : "See my score"}</button>
          </div>`;
        const next = fb.querySelector("[data-next]");
        next.addEventListener("click", () => { idx++; idx < questions.length ? show() : finish(); });
        next.focus({ preventScroll: true });
        fb.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    function finish() {
      const pct = Math.round((score / questions.length) * 100);
      const list = bucket(state.practice, c.id)[ch.id] = practiceAttempts(c.id, ch.id);
      list.push({ date: Date.now(), score, total: questions.length });
      save();
      view.innerHTML = `
        <div class="panel study">
          <div style="text-align:center">
            <h2>Your score</h2>
            <div class="score-big">${pct}%</div>
            <p class="muted">${score} of ${questions.length} correct</p>
            <div class="row" style="justify-content:center">
              ${mistakes.length ? `<button class="btn primary" type="button" data-mistakes>Retry my mistakes (${mistakes.length})</button>` : ""}
              <button class="btn ${mistakes.length ? "" : "primary"}" type="button" data-retry>New round</button>
              ${ch.mock ? `<a class="btn" href="#/course/${esc(c.id)}/mock/${esc(ch.id)}">Take the mock exam</a>` : ""}
            </div>
          </div>
          ${mistakes.length ? `<h3 style="margin-top:24px">Review your mistakes</h3>
          <ul class="review-list">${mistakes.map((m) => `
            <li><strong>${inline(m.q.question)}</strong><br>
              <span class="bad-text">Your answer: ${inline(m.chosen)}</span><br>
              <span class="ok-text">Correct: ${inline(m.q.options[m.q.answer])}</span>
              ${m.q.explanation ? `<div class="small muted" style="margin-top:4px">${inline(m.q.explanation)}</div>` : ""}
            </li>`).join("")}</ul>` : ""}
        </div>`;
      view.querySelector("[data-retry]").addEventListener("click", () => startPractice(c, ch, shuffle(ch.practice)));
      const mb = view.querySelector("[data-mistakes]");
      if (mb) mb.addEventListener("click", () => startPractice(c, ch, shuffle(mistakes.map((m) => m.q))));
    }

    function onKey(e) {
      if (answered || e.target.matches("input, textarea, select")) return;
      const i = "ABCD".indexOf(e.key.toUpperCase()) >= 0 ? "ABCD".indexOf(e.key.toUpperCase()) : "1234".indexOf(e.key);
      if (i >= 0) { const b = view.querySelector(`.option[data-i="${i}"]`); if (b) b.click(); }
    }
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);
    show();
  }

  /* ---------- Mock exams ---------- */

  const TYPE_LABEL = { mc: "Multiple choice", open: "Open question", calc: "Calculation" };
  const mockKey = (courseId, mockId) => `${courseId}/${mockId}`;

  function mockHeader(c, mock, extra) {
    const isFull = mock.id === "full";
    const ch = isFull ? null : findChapter(c.id, mock.id);
    return `
      <div style="--c:${esc(c.color)}">
        <a class="back no-print" href="#/course/${esc(c.id)}">← ${esc(c.name)}</a>
        <div class="course-header">
          <div class="course-icon" aria-hidden="true">${isFull ? "∑" : esc(ch.number || c.icon)}</div>
          <div>
            <h1>${isFull ? "Full-course mock exam" : "Mock exam: " + esc(ch.title)}</h1>
            <div class="small muted">${esc(c.name)}${isFull ? " · all chapters" : ch.number ? " · Chapter " + esc(ch.number) : ""}</div>
          </div>
        </div>
        ${!isFull ? `<nav class="tabs" aria-label="Chapter sections">
          <a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary">Summary</a>
          <a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/practice">Practice <span class="muted">(${ch.practice.length})</span></a>
          <a class="active" href="#/course/${esc(c.id)}/mock/${esc(ch.id)}">Mock exam</a>
        </nav>` : ""}
        <div id="view">${extra}</div>
      </div>`;
  }

  function renderMock(c, mockId) {
    window.scrollTo(0, 0);
    const mock = getMock(c.id, mockId);
    if (!mock) return renderNotFound();
    const total = mock.questions.reduce((n, q) => n + q.points, 0);
    const counts = mock.questions.reduce((o, q) => ((o[q.type] = (o[q.type] || 0) + 1), o), {});
    const attempts = mockAttempts(c.id, mock.id);
    const draft = state.drafts[mockKey(c.id, mock.id)];
    setView(mockHeader(c, mock, `
      <div class="panel exam-intro">
        <div class="stats">
          <div class="stat"><div class="v">${mock.minutes} min</div><div class="l">Duration</div></div>
          <div class="stat"><div class="v">${fmtPts(total)}</div><div class="l">Total points</div></div>
          <div class="stat"><div class="v">${mock.questions.length}</div><div class="l">Questions</div></div>
          <div class="stat"><div class="v">${attempts.length ? fmtGrade(Math.max(...attempts.map((a) => a.grade))) : "–"}</div><div class="l">Best grade</div></div>
        </div>
        <p>${Object.entries(counts).map(([t, n]) => `${n} × ${TYPE_LABEL[t] || t}`).join(" · ")}</p>
        <ul class="rules">
          <li>Exam conditions: no answers, explanations or hints are shown until you submit.</li>
          <li>A ${mock.minutes}-minute timer runs at the top. When it reaches zero you can still finish and submit.</li>
          <li>Multiple choice is graded automatically. For open questions and calculations you grade yourself with the model answer and a strict marking guide.</li>
          <li>Grade = 1 + 5 × (points ÷ total), rounded to the nearest 0.25. 4 = pass, 6 = best.</li>
          <li>Your answers are saved in this browser while you write, so you can resume if the page reloads.</li>
        </ul>
        <div class="row">
          ${draft ? `<button class="btn primary" type="button" data-resume>Resume exam in progress</button><button class="btn" type="button" data-start>Start over</button>`
                  : `<button class="btn primary" type="button" data-start>Start the exam</button>`}
        </div>
        ${attempts.length ? `<h3 style="margin-top:20px">Previous attempts</h3>
          <table class="history-table"><thead><tr><th>Date</th><th>Points</th><th>Grade</th></tr></thead><tbody>
          ${attempts.slice().reverse().map((a) => `<tr><td>${fmtDate(a.date, true)}</td><td>${fmtPts(a.points)} / ${fmtPts(a.total)}</td><td>${gradeChip(a.grade)}</td></tr>`).join("")}
          </tbody></table>` : ""}
      </div>`));
    $main.querySelector("[data-start]").addEventListener("click", () => {
      if (draft && !confirm("Discard your answers in progress and start a new attempt?")) return;
      state.drafts[mockKey(c.id, mock.id)] = { start: Date.now(), answers: {} };
      save();
      takeMock(c, mock);
    });
    const r = $main.querySelector("[data-resume]");
    if (r) r.addEventListener("click", () => takeMock(c, mock));
  }

  function questionText(q) {
    return renderMarkdown(String(q.question));
  }

  function takeMock(c, mock) {
    const key = mockKey(c.id, mock.id);
    const draft = state.drafts[key];
    const total = mock.questions.reduce((n, q) => n + q.points, 0);
    const end = draft.start + mock.minutes * 60 * 1000;
    window.scrollTo(0, 0);

    setView(mockHeader(c, mock, `
      <div class="exam-bar" role="region" aria-label="Exam status">
        <div class="timer" data-timer aria-live="off">--:--</div>
        <div class="small"><strong>${fmtPts(total)} points</strong> · <span data-answered></span></div>
        <button class="btn primary small" type="button" data-submit>Submit exam</button>
      </div>
      <form class="exam" data-exam onsubmit="return false">
        ${mock.questions.map((q, i) => `
          <section class="panel exam-q" id="q${i + 1}">
            <header class="exam-q-head">
              <span class="qnum">Question ${i + 1}</span>
              <span class="chip">${TYPE_LABEL[q.type] || q.type}</span>
              <span class="pts">${fmtPts(q.points)} pt${q.points === 1 ? "" : "s"}</span>
            </header>
            <div class="prose">${questionText(q)}</div>
            ${q.type === "mc"
              ? `<fieldset class="mc"><legend class="sr-only">Options for question ${i + 1}</legend>${q.options.map((o, j) => `
                  <label class="mc-option"><input type="radio" name="q${i}" value="${j}" ${draft.answers[i] === j ? "checked" : ""}><span class="letter">${"ABCD"[j]}</span><span>${inline(o)}</span></label>`).join("")}</fieldset>`
              : `<label class="sr-only" for="a${i}">Your answer to question ${i + 1}</label><textarea id="a${i}" name="q${i}" rows="${q.type === "calc" ? 9 : 6}" placeholder="${q.type === "calc" ? "Show your calculation steps and results…" : "Write your answer…"}">${esc(draft.answers[i] || "")}</textarea>`}
          </section>`).join("")}
        <div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" data-submit>Submit exam</button></div>
      </form>`));

    const form = $main.querySelector("[data-exam]");
    const timerEl = $main.querySelector("[data-timer]");
    const answeredEl = $main.querySelector("[data-answered]");

    function countAnswered() {
      return mock.questions.filter((q, i) => {
        const a = draft.answers[i];
        return q.type === "mc" ? a !== undefined && a !== null : String(a || "").trim().length > 0;
      }).length;
    }
    function updateAnswered() { answeredEl.textContent = `${countAnswered()}/${mock.questions.length} answered`; }

    form.addEventListener("input", (e) => {
      const m = e.target.name && e.target.name.match(/^q(\d+)$/);
      if (!m) return;
      const i = +m[1];
      draft.answers[i] = mock.questions[i].type === "mc" ? +e.target.value : e.target.value;
      save();
      updateAnswered();
    });

    function tick() {
      const left = end - Date.now();
      const abs = Math.abs(left);
      const mm = Math.floor(abs / 60000), ss = Math.floor((abs % 60000) / 1000);
      const t = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      if (left > 0) {
        timerEl.textContent = `⏱ ${t} left`;
        timerEl.className = "timer" + (left < 5 * 60000 ? " warn" : "");
      } else {
        timerEl.textContent = `Time's up (+${t})`;
        timerEl.className = "timer over";
      }
    }
    tick();
    updateAnswered();
    const interval = setInterval(tick, 1000);
    cleanup = () => clearInterval(interval);

    $main.querySelectorAll("[data-submit]").forEach((b) => b.addEventListener("click", () => {
      const missing = mock.questions.length - countAnswered();
      if (missing && !confirm(`${missing} question${missing === 1 ? " is" : "s are"} unanswered. Submit anyway?`)) return;
      submitMock(c, mock);
    }));
  }

  function submitMock(c, mock) {
    const key = mockKey(c.id, mock.id);
    const draft = state.drafts[key];
    const total = mock.questions.reduce((n, q) => n + q.points, 0);
    const attempt = {
      date: Date.now(),
      duration: Date.now() - draft.start,
      answers: draft.answers,
      checks: {},                 // question index -> [checked key-point indexes]
      perQuestion: [],
      points: 0, total, grade: 1,
    };
    const list = bucket(state.mocks, c.id)[mock.id] = mockAttempts(c.id, mock.id);
    list.push(attempt);
    delete state.drafts[key];
    scoreAttempt(mock, attempt);
    save();
    renderMockResult(c, mock, list.length - 1);
  }

  // Recompute points per question, total, grade from answers + self-grading ticks.
  function scoreAttempt(mock, attempt) {
    attempt.perQuestion = mock.questions.map((q, i) => {
      let pts = 0;
      if (q.type === "mc") pts = attempt.answers[i] === q.answer ? q.points : 0;
      else {
        const checked = attempt.checks[i] || [];
        pts = Math.min(q.points, checked.reduce((n, k) => n + ((q.keyPoints || [])[k]?.points || 0), 0));
      }
      return { pts, max: q.points, chapter: q.chapter, topic: q.topic, type: q.type };
    });
    attempt.points = attempt.perQuestion.reduce((n, p) => n + p.pts, 0);
    attempt.grade = swissGrade(attempt.points, attempt.total);
    attempt.weak = weakTopics(attempt);
  }

  // Topics where points were lost, ranked from most to least urgent.
  function weakTopics(attempt) {
    const map = new Map();
    for (const p of attempt.perQuestion) {
      if (!p.topic) continue;
      const k = p.chapter + "|" + p.topic;
      const e = map.get(k) || { chapter: p.chapter, topic: p.topic, lost: 0, max: 0 };
      e.lost += p.max - p.pts;
      e.max += p.max;
      map.set(k, e);
    }
    return [...map.values()].filter((e) => e.lost > 0)
      .sort((a, b) => b.lost - a.lost || b.lost / b.max - a.lost / a.max);
  }

  function answerText(q, a) {
    if (q.type === "mc") return a === undefined || a === null ? "(no answer)" : `${"ABCD"[a]}) ${q.options[a]}`;
    return String(a || "").trim() || "(no answer)";
  }

  function copyAnswersText(c, mock, attempt) {
    const total = attempt.total;
    const lines = [
      `HSG mock exam: ${mock.title}`,
      `Duration: ${mock.minutes} minutes · Total: ${fmtPts(total)} points`,
      `Please grade my answers strictly, like an HSG examiner: give points per question, say what is missing or wrong, and compute the Swiss grade (1 + 5 × points/total, rounded to 0.25).`,
      "",
    ];
    mock.questions.forEach((q, i) => {
      lines.push(`Question ${i + 1} (${fmtPts(q.points)} points, ${TYPE_LABEL[q.type] || q.type})`);
      lines.push(String(q.question));
      if (q.type === "mc") q.options.forEach((o, j) => lines.push(`  ${"ABCD"[j]}) ${o}`));
      lines.push(`My answer to question ${i + 1}: ${answerText(q, attempt.answers[i])}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  function renderMockResult(c, mock, attemptIndex) {
    const attempt = mockAttempts(c.id, mock.id)[attemptIndex];
    window.scrollTo(0, 0);

    function summaryHTML() {
      const g = attempt.grade;
      const pending = mock.questions.filter((q, i) => q.type !== "mc" && !(attempt.checks[i] || []).length).length;
      return `
        <div class="result-top">
          <div class="result-grade ${gradeClass(g)}">
            <div class="label">Grade</div>
            <div class="big">${fmtGrade(g)}</div>
            <div class="verdict">${g >= 4 ? "Pass" : "Fail"}</div>
          </div>
          <div class="result-meta">
            <div><strong>${fmtPts(attempt.points)} / ${fmtPts(attempt.total)} points</strong></div>
            <div class="small muted">Submitted ${fmtDate(attempt.date, true)} · time used ${Math.round(attempt.duration / 60000)} min</div>
            ${pending ? `<div class="notice small" style="margin-top:8px">${pending} open question${pending === 1 ? "" : "s"} still to self-grade below. Your grade updates as you tick the key points.</div>` : `<div class="small ok-text" style="margin-top:6px">✓ Saved to Progress</div>`}
          </div>
        </div>`;
    }

    function weakHTML() {
      const w = attempt.weak || [];
      if (!w.length) return `<p class="ok-text">No weak topics: full points everywhere. 🎉</p>`;
      return `<ol class="weak-list">${w.map((e) => {
        const ch = findChapter(c.id, e.chapter);
        return `<li><a href="#/course/${esc(c.id)}/ch/${esc(e.chapter)}/summary?concept=${esc(e.topic)}">${esc(conceptName(c.id, e.chapter, e.topic))}</a>
          <span class="small muted">${ch ? esc(chapterLabel(ch)) + " · " : ""}lost ${fmtPts(e.lost)} of ${fmtPts(e.max)} pts</span></li>`;
      }).join("")}</ol>`;
    }

    const qHTML = mock.questions.map((q, i) => {
      const p = attempt.perQuestion[i];
      const a = attempt.answers[i];
      let body;
      if (q.type === "mc") {
        const ok = a === q.answer;
        body = `
          <div class="options">${q.options.map((o, j) => `
            <div class="option static ${j === q.answer ? "correct" : j === a ? "wrong" : ""}"><span class="letter">${"ABCD"[j]}</span><span>${inline(o)}${j === a ? ' <span class="small muted">(your answer)</span>' : ""}</span></div>`).join("")}</div>
          ${a === undefined || a === null ? `<p class="bad-text small">No answer given.</p>` : ""}
          <div class="explanation ${ok ? "" : "bad"}"><strong>${ok ? "✓ Correct" : "✗ Incorrect"}</strong>${q.explanation ? `<div>${inline(q.explanation)}</div>` : ""}</div>`;
      } else {
        const checked = attempt.checks[i] || [];
        body = `
          <div class="my-answer"><div class="layer-label">Your answer</div><div class="answer-text">${esc(answerText(q, a))}</div></div>
          <div class="model-answer"><div class="layer-label">Model answer</div><div class="prose">${renderMarkdown(q.model || "")}</div></div>
          <div class="grading" data-grading="${i}">
            <div class="layer-label">Grade yourself: tick only what your answer clearly contains</div>
            ${(q.keyPoints || []).map((k, j) => `
              <label class="keypoint"><input type="checkbox" data-q="${i}" data-k="${j}" ${checked.includes(j) ? "checked" : ""}>
                <span>${inline(k.text)}</span><span class="kp-pts">+${fmtPts(k.points)}</span></label>`).join("")}
            <p class="small muted strict">Strict rule: give a key point only if it is correct <em>and</em> uses the right concept or term. Vague, partly wrong or merely implied answers get no point for that item. For calculations, a correct result without the method shown earns at most half of that item.</p>
          </div>`;
      }
      return `
        <section class="panel exam-q result-q" id="r${i + 1}">
          <header class="exam-q-head">
            <span class="qnum">Question ${i + 1}</span>
            <span class="chip">${TYPE_LABEL[q.type] || q.type}</span>
            <span class="pts ${p.pts === p.max ? "ok-text" : p.pts === 0 ? "bad-text" : ""}" data-pts="${i}">${fmtPts(p.pts)} / ${fmtPts(p.max)} pts</span>
          </header>
          <div class="prose">${questionText(q)}</div>
          ${body}
          ${q.topic ? `<div class="small" style="margin-top:8px"><a href="#/course/${esc(c.id)}/ch/${esc(q.chapter)}/summary?concept=${esc(q.topic)}">Review in summary: ${esc(conceptName(c.id, q.chapter, q.topic))} →</a></div>` : ""}
        </section>`;
    }).join("");

    setView(mockHeader(c, mock, `
      <div class="panel" data-summary>${summaryHTML()}</div>
      <div class="row no-print" style="margin:12px 0">
        <button class="btn" type="button" data-copy>📋 Copy my answers</button>
        <a class="btn" href="#/course/${esc(c.id)}/mock/${esc(mock.id)}">Back to exam overview</a>
        <span class="small muted">Copies all questions and your answers, numbered, to paste into Claude for detailed grading.</span>
      </div>
      <div class="panel">
        <h2>Weak topics <span class="small muted">(most urgent first)</span></h2>
        <div data-weak>${weakHTML()}</div>
      </div>
      <h2 class="section-title">Questions, model answers and your points</h2>
      ${qHTML}`));

    $main.querySelectorAll(".keypoint input").forEach((cb) => cb.addEventListener("change", () => {
      const i = +cb.dataset.q;
      const box = $main.querySelectorAll(`.keypoint input[data-q="${i}"]`);
      attempt.checks[i] = [...box].filter((x) => x.checked).map((x) => +x.dataset.k);
      scoreAttempt(mock, attempt);
      save();
      const p = attempt.perQuestion[i];
      const el = $main.querySelector(`[data-pts="${i}"]`);
      el.textContent = `${fmtPts(p.pts)} / ${fmtPts(p.max)} pts`;
      el.className = "pts " + (p.pts === p.max ? "ok-text" : p.pts === 0 ? "bad-text" : "");
      $main.querySelector("[data-summary]").innerHTML = summaryHTML();
      $main.querySelector("[data-weak]").innerHTML = weakHTML();
    }));

    $main.querySelector("[data-copy]").addEventListener("click", async () => {
      const ok = await copyText(copyAnswersText(c, mock, attempt));
      toast(ok ? "Copied: paste it into Claude" : "Copy failed: your browser blocked the clipboard");
    });
  }

  /* ---------- Today: study plan ---------- */

  // Build candidate tasks from progress; lower priority number = more urgent.
  function candidateTasks() {
    const tasks = [];
    for (const c of courses) {
      const data = content[c.id];
      const chs = data.chapters || [];
      chs.forEach((ch, idx) => {
        const base = { course: c.id, chapter: ch.id };
        const name = `${chapterLabel(ch)} (${c.name})`;
        const best = bestGrade(c.id, ch.id);
        const last = mockAttempts(c.id, ch.id).slice(-1)[0];
        const order = idx * 0.01;
        if (last && last.grade < 5 && (last.weak || []).length) {
          const topics = last.weak.slice(0, 3).map((w) => conceptName(c.id, w.chapter, w.topic));
          tasks.push({ ...base, kind: "review", id: `review:${c.id}:${ch.id}`,
            label: `Review your weak topics in ${name}: ${topics.join(", ")}`,
            href: `#/course/${c.id}/ch/${last.weak[0].chapter}/summary?concept=${last.weak[0].topic}`,
            reason: `Last mock grade ${fmtGrade(last.grade)}`, priority: last.grade - 4 + order });
        }
        if (best !== null && best < 4.5) {
          tasks.push({ ...base, kind: "mock", id: `remock:${c.id}:${ch.id}`,
            label: `Retake the mock exam for ${name}`, href: `#/course/${c.id}/mock/${ch.id}`,
            reason: `Best grade so far ${fmtGrade(best)}`, priority: 1 + best - 4 + order });
        }
        if (!isRead(c.id, ch.id)) {
          tasks.push({ ...base, kind: "read", id: `read:${c.id}:${ch.id}`,
            label: `Read the ${chapterLabel(ch)} summary of ${c.name}`, href: `#/course/${c.id}/ch/${ch.id}/summary`,
            reason: "Not read yet", priority: 2 + order });
        } else if (!practiceAttempts(c.id, ch.id).length && ch.practice.length) {
          tasks.push({ ...base, kind: "practice", id: `practice:${c.id}:${ch.id}`,
            label: `Do the ${chapterLabel(ch)} practice questions in ${c.name}`, href: `#/course/${c.id}/ch/${ch.id}/practice`,
            reason: "Summary read, not practised yet", priority: 2.3 + order });
        } else if (best === null && ch.mock) {
          tasks.push({ ...base, kind: "mock", id: `mock:${c.id}:${ch.id}`,
            label: `Take the ${chapterLabel(ch)} mock exam in ${c.name}`, href: `#/course/${c.id}/mock/${ch.id}`,
            reason: "Practised, no mock exam yet", priority: 2.5 + order });
        }
      });
      const full = getMock(c.id, "full");
      if (full && chs.length && chs.every((ch) => !ch.mock || mockAttempts(c.id, ch.id).length)) {
        const fb = bestGrade(c.id, "full");
        if (fb === null || fb < 4.5) {
          tasks.push({ course: c.id, chapter: "full", kind: "mock", id: `mock:${c.id}:full`,
            label: `Take the full-course mock exam in ${c.name}`, href: `#/course/${c.id}/mock/full`,
            reason: fb === null ? "All chapter mocks done" : `Best grade so far ${fmtGrade(fb)}`, priority: fb === null ? 2.7 : 1 + fb - 4 });
        }
      }
    }
    return tasks.sort((a, b) => a.priority - b.priority);
  }

  function pickTasks(exclude) {
    const all = candidateTasks().filter((t) => !exclude.has(t.id));
    const picked = [], perCourse = {}, perChapter = new Set();
    for (const t of all) {
      if (picked.length >= TODAY_MAX_TASKS) break;
      const ck = t.course + ":" + t.chapter;
      if ((perCourse[t.course] || 0) >= TODAY_MAX_PER_COURSE || perChapter.has(ck)) continue;
      picked.push(t);
      perCourse[t.course] = (perCourse[t.course] || 0) + 1;
      perChapter.add(ck);
    }
    // If the spreading rules left room, fill up with the next most urgent tasks.
    for (const t of all) {
      if (picked.length >= TODAY_MAX_TASKS) break;
      if (!picked.includes(t)) picked.push(t);
    }
    return picked;
  }

  function ensureTodayPlan() {
    const today = dayKey();
    if (!state.today || state.today.date !== today) {
      state.today = { date: today, tasks: pickTasks(new Set()), done: [] };
      save();
    }
    return state.today;
  }

  // A task also counts as done if you did the activity today.
  function taskDone(t) {
    if (state.today.done.includes(t.id)) return true;
    const since = startOfToday();
    if (t.kind === "read") return ((state.read[t.course] || {})[t.chapter] || 0) >= since;
    if (t.kind === "practice") return practiceAttempts(t.course, t.chapter).some((a) => a.date >= since);
    if (t.kind === "mock") return mockAttempts(t.course, t.chapter).some((a) => a.date >= since);
    return false;
  }

  function renderToday() {
    const plan = ensureTodayPlan();
    const items = plan.tasks.map((t) => ({ t, done: taskDone(t) }));
    const left = items.filter((x) => !x.done).length;
    const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    setView(`
      <h1>Today</h1>
      <p class="muted">${esc(dateLabel)} · ${items.length ? (left ? `${left} of ${items.length} tasks left` : "All tasks done. Great work! 🎉") : ""}</p>
      ${items.length ? `
      <ul class="todo">
        ${items.map(({ t, done }) => `
          <li class="todo-item ${done ? "done" : ""}" style="--c:${esc(courseById(t.course)?.color || "var(--accent)")}">
            <label class="todo-check"><input type="checkbox" data-task="${esc(t.id)}" ${done ? "checked" : ""}><span class="sr-only">Mark as done</span></label>
            <div class="todo-body">
              <a href="${esc(t.href)}">${esc(t.label)}</a>
              <div class="small muted">${esc(courseById(t.course)?.name || "")} · ${esc(t.reason)}</div>
            </div>
          </li>`).join("")}
      </ul>` : `<div class="panel"><p>Nothing to plan yet: there is no course content.</p></div>`}
      <div class="row" style="margin-top:16px">
        ${!left && items.length ? `<button class="btn primary" type="button" data-more>Give me more tasks</button>` : ""}
        <button class="btn small" type="button" data-rebuild>Rebuild today's plan</button>
      </div>
      <p class="small muted" style="margin-top:16px">How the plan is built: chapters where your last mock grade was lowest come first (review weak topics, then retake), then summaries you haven't read, practice you haven't done and mock exams you haven't taken. At most 2 tasks per course and 6 per day. A new plan is made every day; tasks tick themselves when you do them, or tick them by hand.</p>`);

    $main.querySelectorAll("[data-task]").forEach((cb) => cb.addEventListener("change", () => {
      const id = cb.dataset.task;
      plan.done = plan.done.filter((x) => x !== id);
      if (cb.checked) plan.done.push(id);
      save();
      renderToday();
    }));
    const more = $main.querySelector("[data-more]");
    if (more) more.addEventListener("click", () => {
      const exclude = new Set(plan.tasks.map((t) => t.id));
      const extra = pickTasks(exclude);
      if (!extra.length) { toast("Nothing else to do. Everything is covered!"); return; }
      plan.tasks.push(...extra);
      save();
      renderToday();
    });
    $main.querySelector("[data-rebuild]").addEventListener("click", () => {
      state.today = null;
      ensureTodayPlan();
      renderToday();
      toast("Plan rebuilt from your latest progress");
    });
  }

  /* ---------- Progress ---------- */

  // Bar chart of mock grades over time (single series, pass line at 4).
  function gradeChart(attempts) {
    const items = attempts.slice(-12);
    if (!items.length) return `<div class="chart-empty">No mock exams taken yet</div>`;
    const W = 320, H = 150, padL = 26, padR = 6, padT = 10, padB = 20;
    const cw = W - padL - padR, ch = H - padT - padB;
    const y = (g) => padT + ch - ((g - 1) / 5) * ch;
    const slot = cw / Math.max(items.length, 6);
    const bw = Math.min(28, slot - 4);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mock exam grades, last ${items.length} attempts">`;
    for (const g of [1, 4, 6]) {
      svg += `<line class="${g === 4 ? "pass-line" : "grid-line"}" x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}"/><text class="axis-label" x="${padL - 6}" y="${y(g) + 4}" text-anchor="end">${g}</text>`;
    }
    items.forEach((a, i) => {
      const top = y(a.grade), h = Math.max(2, padT + ch - top);
      const x = padL + i * slot + (slot - bw) / 2;
      const r = Math.min(4, bw / 2, h);
      const path = `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`;
      const label = `${fmtDate(a.date)} · ${a.label}: grade ${fmtGrade(a.grade)} (${fmtPts(a.points)}/${fmtPts(a.total)})`;
      svg += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${ch}" data-tip="${esc(label)}"/><path class="bar ${a.grade >= 4 ? "" : "fail"}" d="${path}"/>`;
    });
    svg += `<text class="axis-label" x="${padL}" y="${H - 4}">oldest</text><text class="axis-label" x="${W - padR}" y="${H - 4}" text-anchor="end">latest</text></svg>`;
    return svg;
  }

  function renderProgress() {
    const active = courses.filter((c) => content[c.id].chapters.length);
    const allAttempts = active.flatMap((c) => Object.values(state.mocks[c.id] || {}).flat());
    const totalCh = active.reduce((n, c) => n + content[c.id].chapters.length, 0);
    const totalRead = active.reduce((n, c) => n + courseProgress(c.id).read, 0);
    const avg = allAttempts.length ? allAttempts.reduce((n, a) => n + a.grade, 0) / allAttempts.length : null;
    const passed = allAttempts.filter((a) => a.grade >= 4).length;

    setView(`
      <h1>Progress</h1>
      <div class="stats">
        <div class="stat"><div class="v">${totalRead}/${totalCh}</div><div class="l">Summaries read</div></div>
        <div class="stat"><div class="v">${allAttempts.length}</div><div class="l">Mock exams taken</div></div>
        <div class="stat"><div class="v">${avg === null ? "–" : fmtGrade(Math.round(avg * 4) / 4)}</div><div class="l">Average mock grade</div></div>
        <div class="stat"><div class="v">${allAttempts.length ? passed + "/" + allAttempts.length : "–"}</div><div class="l">Mocks passed</div></div>
      </div>
      <div class="progress-grid">
        ${active.map((c) => {
          const data = content[c.id];
          const attempts = Object.entries(state.mocks[c.id] || {})
            .flatMap(([mid, list]) => list.map((a) => ({ ...a, label: mid === "full" ? "Full course" : chapterLabel(findChapter(c.id, mid) || { title: mid }) })))
            .sort((a, b) => a.date - b.date);
          const full = getMock(c.id, "full");
          return `
          <section class="panel" style="--c:${esc(c.color)}">
            <div class="course-head" style="margin-bottom:12px">
              <div class="course-icon" aria-hidden="true">${esc(c.icon)}</div>
              <h2><a href="#/course/${esc(c.id)}">${esc(c.name)}</a></h2>
            </div>
            <div class="table-wrap"><table class="progress-table">
              <thead><tr><th>Chapter</th><th>Summary</th><th>Practice</th><th>Mock</th></tr></thead>
              <tbody>
                ${data.chapters.map((ch) => {
                  const pb = bestPractice(c.id, ch.id), lg = lastGrade(c.id, ch.id);
                  return `<tr>
                    <td><a href="#/course/${esc(c.id)}/ch/${esc(ch.id)}/summary">${esc(chapterLabel(ch))}</a></td>
                    <td>${isRead(c.id, ch.id) ? '<span class="ok-text">✓</span>' : '<span class="muted">–</span>'}</td>
                    <td>${pb === null ? '<span class="muted">–</span>' : pb + "%"}</td>
                    <td>${lg === null ? '<span class="muted">–</span>' : gradeChip(lg)}</td></tr>`;
                }).join("")}
                ${full ? `<tr><td><a href="#/course/${esc(c.id)}/mock/full">Full-course mock</a></td><td></td><td></td><td>${lastGrade(c.id, "full") === null ? '<span class="muted">–</span>' : gradeChip(lastGrade(c.id, "full"))}</td></tr>` : ""}
              </tbody>
            </table></div>
            <div class="meter-label" style="margin-top:14px"><span>Mock exam grades</span><span>${attempts.length ? `best ${fmtGrade(Math.max(...attempts.map((a) => a.grade)))}` : ""}</span></div>
            ${gradeChart(attempts)}
            ${attempts.length ? `<details><summary>All results (${attempts.length})</summary>
              <table class="history-table"><thead><tr><th>Date</th><th>Exam</th><th>Points</th><th>Grade</th></tr></thead><tbody>
              ${attempts.slice().reverse().map((a) => `<tr><td>${fmtDate(a.date, true)}</td><td>${esc(a.label)}</td><td>${fmtPts(a.points)}/${fmtPts(a.total)}</td><td>${gradeChip(a.grade)}</td></tr>`).join("")}
              </tbody></table></details>` : ""}
          </section>`;
        }).join("")}
      </div>`);

    $main.querySelectorAll(".hit").forEach((el) => {
      const bar = el.nextElementSibling;
      const showTip = (e) => {
        $tooltip.textContent = el.dataset.tip;
        $tooltip.hidden = false;
        const r = el.getBoundingClientRect();
        const tw = $tooltip.offsetWidth;
        $tooltip.style.left = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2)) + "px";
        $tooltip.style.top = (r.top - 36) + "px";
        bar.classList.add("hover");
        if (e.type === "click") e.stopPropagation();
      };
      const hideTip = () => { $tooltip.hidden = true; bar.classList.remove("hover"); };
      el.addEventListener("mouseenter", showTip);
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", showTip);
    });
  }

  document.addEventListener("click", () => { $tooltip.hidden = true; });
  window.addEventListener("scroll", () => { $tooltip.hidden = true; }, { passive: true });

  /* ---------- Settings ---------- */

  function renderSettings() {
    setView(`
      <h1>Settings</h1>
      <section class="panel">
        <h2>Appearance</h2>
        <div class="settings-row">
          <span>Theme</span>
          <div class="seg" role="group" aria-label="Theme">
            ${["auto", "light", "dark"].map((t) => `<button type="button" data-theme-set="${t}" class="${state.theme === t ? "active" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
          </div>
        </div>
      </section>
      <section class="panel">
        <h2>Your data</h2>
        <p class="small muted">Progress is stored in this browser only. Export it to back it up or to move it to another device, then import it there.</p>
        <div class="row">
          <button class="btn" type="button" data-export>⬇ Export progress</button>
          <label class="btn" style="cursor:pointer">⬆ Import progress<input type="file" accept="application/json,.json" data-import hidden></label>
          <span class="spacer"></span>
          <select data-reset-course aria-label="Course to reset">
            <option value="">All courses</option>
            ${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
          </select>
          <button class="btn danger" type="button" data-reset>Reset progress</button>
        </div>
      </section>
      <section class="panel prose">
        <h2>Adding new PDFs</h2>
        <p>Your lecture PDFs are kept <strong>out of this public site</strong>. Upload new ones to your <strong>private</strong> repository <code>revision-hsg-cours</code>, into <code>cours/&lt;course&gt;/</code>, then ask Claude to update the summaries, practice questions and mock exams. Never upload PDFs to the public <code>revision-hsg</code> repository.</p>
      </section>`);

    $main.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => {
      state.theme = b.dataset.themeSet;
      save();
      applyTheme();
      renderSettings();
    }));
    $main.querySelector("[data-export]").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `hsg-revision-progress-${dayKey()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $main.querySelector("[data-import]").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (typeof data !== "object" || !data || !("mocks" in data || "read" in data || "practice" in data)) throw new Error("this is not a progress file");
        if (!confirm("Replace the progress in this browser with the imported file?")) return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        state = loadState();
        applyTheme();
        toast("Progress imported");
        renderSettings();
      } catch (err) {
        alert("Could not import this file: " + err.message);
      }
    });
    $main.querySelector("[data-reset]").addEventListener("click", () => {
      const id = $main.querySelector("[data-reset-course]").value;
      const name = id ? courseById(id).name : "ALL courses";
      if (!confirm(`Delete reading status, practice scores and mock results for ${name}? This cannot be undone.`)) return;
      const keys = ["read", "practice", "mocks"];
      if (id) {
        keys.forEach((k) => delete state[k][id]);
        Object.keys(state.drafts).filter((k) => k.startsWith(id + "/")).forEach((k) => delete state.drafts[k]);
      } else {
        keys.forEach((k) => (state[k] = {}));
        state.drafts = {};
      }
      state.today = null;
      save();
      toast("Progress reset");
    });
  }

  /* ---------- Boot ---------- */

  applyTheme();
  window.addEventListener("hashchange", route);
  loadAll().then(route).catch((e) => {
    const local = location.protocol === "file:";
    $main.innerHTML = `<div class="panel">
      <h1>Could not load the course data</h1>
      ${local
        ? `<p>Browsers block loading JSON files when a page is opened directly from disk. Start a tiny local server in the project folder instead:</p>
           <p><code>python3 -m http.server 8000</code></p><p>then open <a href="http://localhost:8000">http://localhost:8000</a>. On GitHub Pages this works automatically.</p>`
        : `<p>Check that <code>data/courses.json</code> exists and is valid JSON.</p>`}
      <p class="small muted">${esc(e.message)}</p></div>`;
  });
})();
