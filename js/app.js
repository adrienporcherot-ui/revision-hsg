/* HSG Revision: static single-page app.
 * Content lives in data/*.json, progress in localStorage. No build step, no server. */
(function () {
  "use strict";

  const STORAGE_KEY = "hsg-revision-v1";
  const DAY = 24 * 60 * 60 * 1000;
  const MASTERED_DAYS = 3;     // a card counts as mastered once its review interval reaches 3 days
  const HARD_REQUEUE = 3;      // a card rated "hard" comes back after this many cards in the same session

  const $main = document.getElementById("main");
  const $tooltip = document.getElementById("tooltip");

  /* ---------- Utilities ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Stable id for a card/question: explicit "id" if given, otherwise a hash of its text.
  function hashId(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return "h" + (h >>> 0).toString(36);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function todayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parseDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function daysUntil(iso) {
    const d = parseDate(iso);
    if (!d) return null;
    return Math.round((d - todayStart()) / DAY);
  }

  function fmtDate(iso) {
    const d = parseDate(iso);
    return d ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "No date set";
  }

  function fmtInterval(days) {
    if (days < 1) return "again soon";
    if (days < 1.5) return "1 day";
    if (days < 30) return Math.round(days) + " days";
    return Math.round(days / 30) + " mo";
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  /* ---------- Storage ---------- */

  function loadState() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (e) { s = {}; }
    s.examDates = s.examDates || {};
    s.cards = s.cards || {};
    s.quizzes = s.quizzes || {};
    s.theme = s.theme || "auto";
    return s;
  }

  let state = loadState();

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast("Could not save progress (browser storage unavailable)."); }
  }

  /* ---------- Theme ---------- */

  const themeBtn = document.getElementById("theme-toggle");
  const svg = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const THEME_ICONS = {
    auto: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
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
  const content = {};        // courseId -> content JSON (or {error})

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    return res.json();
  }

  function normalise(course, data) {
    data.flashcards = (data.flashcards || []).map((c) => ({ ...c, id: c.id || hashId(c.front) }));
    data.quiz = (data.quiz || []).map((q) => ({ ...q, id: q.id || hashId(q.question) }));
    data.summary = data.summary || [];
    return data;
  }

  async function loadAll() {
    const index = await fetchJSON("data/courses.json");
    courses = index.courses || [];
    await Promise.all(courses.map(async (c) => {
      try { content[c.id] = normalise(c, await fetchJSON("data/" + c.file)); }
      catch (e) { content[c.id] = { error: e.message, flashcards: [], quiz: [], summary: [] }; }
    }));
  }

  function examDate(c) { return state.examDates[c.id] || c.examDate || ""; }

  /* ---------- Spaced repetition ---------- */

  function cardState(courseId, cardId) {
    return (state.cards[courseId] || {})[cardId];
  }

  function isDue(cs, now) { return !cs || cs.due <= now; }

  // Next interval (in days) for each rating, given the current card state.
  function nextInterval(cs, rating) {
    const iv = cs ? cs.interval : 0;
    if (rating === "hard") return 0;
    if (rating === "medium") return iv < 1 ? 1 : Math.max(1, iv * 1.5);
    return iv < 1 ? MASTERED_DAYS : iv * 2.5; // easy
  }

  function rateCard(courseId, cardId, rating) {
    const now = Date.now();
    const bucket = state.cards[courseId] || (state.cards[courseId] = {});
    const cs = bucket[cardId] || { interval: 0, reps: 0, lapses: 0 };
    const iv = nextInterval(cs, rating);
    cs.interval = iv;
    cs.reps += 1;
    if (rating === "hard") cs.lapses += 1;
    cs.last = rating;
    cs.lastReview = now;
    // Hard cards are due again right away (and come back later in the same session).
    cs.due = rating === "hard" ? now : now + iv * DAY;
    bucket[cardId] = cs;
    save();
  }

  function courseStats(courseId) {
    const data = content[courseId] || { flashcards: [] };
    const now = Date.now();
    let mastered = 0, seen = 0, due = 0, hard = 0;
    for (const card of data.flashcards) {
      const cs = cardState(courseId, card.id);
      if (cs) {
        seen++;
        if (cs.interval >= MASTERED_DAYS) mastered++;
        if (cs.last === "hard") hard++;
      }
      if (isDue(cs, now)) due++;
    }
    const total = data.flashcards.length;
    const quizzes = state.quizzes[courseId] || [];
    const pcts = quizzes.map((q) => Math.round((q.score / q.total) * 100));
    return {
      total, mastered, seen, due, hard,
      pct: total ? Math.round((mastered / total) * 100) : 0,
      quizzes,
      best: pcts.length ? Math.max(...pcts) : null,
      avg: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      last: pcts.length ? pcts[pcts.length - 1] : null,
    };
  }

  /* ---------- Markdown (small subset, for summaries) ---------- */

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown(src) {
    const lines = Array.isArray(src) ? src : String(src).split("\n");
    let html = "";
    let i = 0;
    const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const level = m[1].length + 1; // "#" -> h2, "##" -> h3, "###" -> h4
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
        while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*\||\s*>|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) parts.push(lines[i++]);
        html += `<p>${inline(parts.join(" "))}</p>`;
      }
    }
    return html;
  }

  /* ---------- Router ---------- */

  let cleanup = null; // per-view teardown (keyboard listeners)

  function setView(html) {
    if (cleanup) { cleanup(); cleanup = null; }
    $main.innerHTML = html;
    window.scrollTo(0, 0);
  }

  function setActiveNav(name) {
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  }

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    $tooltip.hidden = true;
    if (parts[0] === "course" && parts[1]) {
      const course = courses.find((c) => c.id === parts[1]);
      if (!course) return renderNotFound();
      setActiveNav("home");
      const tab = parts[2] || "flashcards";
      if (tab === "quiz") return renderQuiz(course);
      if (tab === "summary") return renderSummary(course);
      return renderFlashcards(course);
    }
    if (parts[0] === "progress") { setActiveNav("progress"); return renderProgress(); }
    if (parts[0] === "settings") { setActiveNav("settings"); return renderSettings(); }
    setActiveNav("home");
    renderHome();
  }

  function renderNotFound() {
    setView(`<div class="panel"><h1>Not found</h1><p>This course does not exist. <a href="#/">Back to courses</a></p></div>`);
  }

  /* ---------- Home ---------- */

  function countdownHTML(c) {
    const iso = examDate(c);
    const d = daysUntil(iso);
    if (d === null) return `<div class="countdown passed"><span class="days">No exam date</span></div>`;
    if (d < 0) return `<div class="countdown passed"><span class="days">Exam passed</span><span class="unit">${-d} day${d === -1 ? "" : "s"} ago</span></div>`;
    if (d === 0) return `<div class="countdown soon"><span class="days">Today</span><span class="unit">Good luck! 🍀</span></div>`;
    const weeks = d >= 14 ? ` · ${Math.floor(d / 7)} weeks` : "";
    return `<div class="countdown ${d <= 7 ? "soon" : ""}"><span class="days">${d}</span><span class="unit">day${d === 1 ? "" : "s"} to go${weeks}</span></div>`;
  }

  function courseCardHTML(c) {
    const s = courseStats(c.id);
    const data = content[c.id];
    const badge = data.error ? `<span class="chip warn">Could not load</span>` : data.placeholder ? `<span class="chip warn">Sample content</span>` : "";
    return `
      <article class="course-card" style="--c:${esc(c.color)}" data-course="${esc(c.id)}">
        <div class="course-head">
          <div class="course-icon" aria-hidden="true">${esc(c.icon || c.name[0])}</div>
          <div>
            <h2><a href="#/course/${esc(c.id)}">${esc(c.name)}</a></h2>
            ${badge}
          </div>
        </div>
        ${countdownHTML(c)}
        <div class="date-line" data-date-line>
          <span>📅 ${esc(fmtDate(examDate(c)))}</span>
          <button class="link-btn" type="button" data-edit-date>Edit date</button>
        </div>
        <div>
          <div class="meter-label"><span>Cards mastered</span><span>${s.mastered}/${s.total} · ${s.pct}%</span></div>
          <div class="meter" role="progressbar" aria-valuenow="${s.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(c.name)} cards mastered"><span style="width:${s.pct}%"></span></div>
        </div>
        <div class="row small muted">
          <span>${s.due} card${s.due === 1 ? "" : "s"} due</span>·
          <span>${s.last === null ? "No quiz yet" : "Last quiz " + s.last + "%"}</span>
        </div>
        <div class="card-actions">
          <a class="btn" href="#/course/${esc(c.id)}/flashcards">Cards</a>
          <a class="btn" href="#/course/${esc(c.id)}/quiz">Quiz</a>
          <a class="btn" href="#/course/${esc(c.id)}/summary">Summary</a>
        </div>
      </article>`;
  }

  function renderHome() {
    const sorted = courses.slice().sort((a, b) => {
      const da = daysUntil(examDate(a)), db = daysUntil(examDate(b));
      const ka = da === null ? 1e9 : da < 0 ? 1e8 - da : da;
      const kb = db === null ? 1e9 : db < 0 ? 1e8 - db : db;
      return ka - kb;
    });
    const next = sorted.find((c) => (daysUntil(examDate(c)) ?? -1) >= 0);
    const totalDue = courses.reduce((n, c) => n + courseStats(c.id).due, 0);
    const nd = next ? daysUntil(examDate(next)) : null;
    setView(`
      <section class="hero">
        <div>
          <h1>Your exams</h1>
          <p class="muted">${totalDue} flashcard${totalDue === 1 ? "" : "s"} due for review today. Courses are sorted by exam date.</p>
        </div>
        ${next ? `<div class="hero-stat"><div class="big">${nd === 0 ? "Today" : nd + " d"}</div><div class="muted small">until ${esc(next.name)}</div></div>` : ""}
      </section>
      <section class="grid">${sorted.map(courseCardHTML).join("")}</section>`);

    $main.querySelectorAll("[data-edit-date]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest("[data-course]");
        const c = courses.find((x) => x.id === card.dataset.course);
        const line = card.querySelector("[data-date-line]");
        line.innerHTML = `
          <span class="date-edit">
            <input type="date" value="${esc(examDate(c))}" aria-label="Exam date for ${esc(c.name)}">
            <button class="btn small primary" type="button" data-save>Save</button>
            <button class="btn small" type="button" data-cancel>Cancel</button>
          </span>`;
        const input = line.querySelector("input");
        input.focus();
        line.querySelector("[data-save]").addEventListener("click", () => {
          state.examDates[c.id] = input.value;
          save();
          renderHome();
          toast("Exam date saved");
        });
        line.querySelector("[data-cancel]").addEventListener("click", renderHome);
      });
    });
  }

  /* ---------- Course shell ---------- */

  function courseShell(c, tab, body) {
    const data = content[c.id];
    const s = courseStats(c.id);
    const notice = data.error
      ? `<div class="notice">Could not load <code>data/${esc(c.file)}</code> (${esc(data.error)}). Check that the file exists and is valid JSON.</div>`
      : data.placeholder
        ? `<div class="notice">Sample content: no course PDFs were found for this course. Replace <code>data/${esc(c.file)}</code> with your own material.</div>`
        : "";
    return `
      <div style="--c:${esc(c.color)}">
        <a class="back" href="#/">← All courses</a>
        <div class="course-header">
          <div class="course-icon" aria-hidden="true">${esc(c.icon || c.name[0])}</div>
          <div>
            <h1>${esc(c.name)}</h1>
            <div class="small muted">${data.title && data.title !== c.name ? esc(data.title) + " · " : ""}${s.pct}% mastered · exam ${esc(fmtDate(examDate(c)))}</div>
          </div>
        </div>
        ${notice}
        <nav class="tabs" aria-label="Course sections">
          <a href="#/course/${esc(c.id)}/flashcards" class="${tab === "flashcards" ? "active" : ""}">Flashcards <span class="muted">(${data.flashcards.length})</span></a>
          <a href="#/course/${esc(c.id)}/quiz" class="${tab === "quiz" ? "active" : ""}">Quiz <span class="muted">(${data.quiz.length})</span></a>
          <a href="#/course/${esc(c.id)}/summary" class="${tab === "summary" ? "active" : ""}">Summary</a>
        </nav>
        <div id="view">${body}</div>
      </div>`;
  }

  function topics(items) {
    return [...new Set(items.map((x) => x.topic).filter(Boolean))];
  }

  function topicSelect(items, id) {
    const t = topics(items);
    if (t.length < 2) return "";
    return `<label class="field">Topic
      <select id="${id}"><option value="">All topics</option>${t.map((x) => `<option>${esc(x)}</option>`).join("")}</select>
    </label>`;
  }

  /* ---------- Flashcards ---------- */

  function renderFlashcards(c) {
    const data = content[c.id];
    const s = courseStats(c.id);
    if (!data.flashcards.length) {
      setView(courseShell(c, "flashcards", `<div class="panel">No flashcards yet. Add some to <code>data/${esc(c.file)}</code>.</div>`));
      return;
    }
    setView(courseShell(c, "flashcards", `
      <div class="panel setup">
        <div class="stats">
          <div class="stat"><div class="v">${s.due}</div><div class="l">Due now</div></div>
          <div class="stat"><div class="v">${s.total - s.seen}</div><div class="l">Never studied</div></div>
          <div class="stat"><div class="v">${s.hard}</div><div class="l">Marked hard</div></div>
          <div class="stat"><div class="v">${s.pct}%</div><div class="l">Mastered</div></div>
        </div>
        ${topicSelect(data.flashcards, "fc-topic")}
        <div class="mode-options">
          <button class="mode-option" type="button" data-mode="due">
            <strong>Review due cards</strong>
            <span>Spaced repetition: new cards, hard cards first, then the ones scheduled for today.</span>
          </button>
          <button class="mode-option" type="button" data-mode="hard">
            <strong>Hard cards only</strong>
            <span>Drill the cards you last rated “hard”.</span>
          </button>
          <button class="mode-option" type="button" data-mode="all">
            <strong>All cards (cram)</strong>
            <span>Every card, shuffled, regardless of schedule. Ideal right before the exam.</span>
          </button>
        </div>
        <p class="small muted">How it works: rate each card. <b>Hard</b> → it comes back a few cards later and again tomorrow. <b>Medium</b> → tomorrow, then at growing intervals. <b>Easy</b> → in ${MASTERED_DAYS}+ days. A card counts as <b>mastered</b> once its interval reaches ${MASTERED_DAYS} days.</p>
      </div>`));

    $main.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      const sel = document.getElementById("fc-topic");
      startStudy(c, b.dataset.mode, sel ? sel.value : "");
    }));
  }

  function buildQueue(c, mode, topic) {
    const now = Date.now();
    let cards = content[c.id].flashcards.filter((x) => !topic || x.topic === topic);
    if (mode === "all") return shuffle(cards);
    if (mode === "hard") return shuffle(cards.filter((x) => (cardState(c.id, x.id) || {}).last === "hard"));
    cards = cards.filter((x) => isDue(cardState(c.id, x.id), now));
    // Priority: hard first, then overdue reviews, then new cards (in file order).
    const rank = (x) => {
      const cs = cardState(c.id, x.id);
      if (!cs) return 2;
      return cs.last === "hard" ? 0 : 1;
    };
    const groups = [0, 1, 2].map((r) => cards.filter((x) => rank(x) === r));
    return [...shuffle(groups[0]), ...shuffle(groups[1]), ...groups[2]];
  }

  function startStudy(c, mode, topic) {
    const queue = buildQueue(c, mode, topic);
    const view = document.getElementById("view");
    if (!queue.length) {
      view.innerHTML = `<div class="panel study" style="text-align:center">
        <h2>Nothing to review 🎉</h2>
        <p class="muted">${mode === "hard" ? "No cards are currently marked hard." : "All cards for this selection are scheduled for later."}</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" type="button" data-cram>Study all cards anyway</button>
          <a class="btn" href="#/course/${esc(c.id)}/quiz">Take a quiz</a>
        </div></div>`;
      view.querySelector("[data-cram]").addEventListener("click", () => startStudy(c, "all", topic));
      return;
    }
    const totalUnique = new Set(queue.map((x) => x.id)).size;
    const done = new Set();
    const counts = { easy: 0, medium: 0, hard: 0 };
    let current = null;
    let flipped = false;

    function show() {
      current = queue.shift();
      flipped = false;
      if (!current) return finish();
      const cs = cardState(c.id, current.id);
      view.innerHTML = `
        <div class="study">
          <div class="study-top">
            <span>${done.size} / ${totalUnique} done${queue.length ? ` · ${queue.length + 1} left in queue` : ""}</span>
            <button class="btn small" type="button" data-stop>End session</button>
          </div>
          <div class="progressbar"><span style="width:${(done.size / totalUnique) * 100}%"></span></div>
          <div class="flashcard" tabindex="0" role="button" aria-label="Flashcard, press to reveal the answer">
            <div class="flashcard-inner">
              <div class="face front">
                ${current.topic ? `<span class="chip tag">${esc(current.topic)}</span>` : ""}
                <div class="q">${esc(current.front)}</div>
                <div class="hint">Tap to reveal the answer</div>
              </div>
              <div class="face back">
                ${current.topic ? `<span class="chip tag">${esc(current.topic)}</span>` : ""}
                <div class="small muted" style="margin:14px 0 6px">${esc(current.front)}</div>
                <div class="a">${esc(current.back)}</div>
              </div>
            </div>
          </div>
          <div class="rate" hidden>
            <button class="btn hard" type="button" data-rate="hard">Hard<small>${fmtInterval(nextInterval(cs, "hard"))}</small></button>
            <button class="btn medium" type="button" data-rate="medium">Medium<small>${fmtInterval(nextInterval(cs, "medium"))}</small></button>
            <button class="btn easy" type="button" data-rate="easy">Easy<small>${fmtInterval(nextInterval(cs, "easy"))}</small></button>
          </div>
          <p class="kbd-hint">Space: flip · 1: hard · 2: medium · 3: easy</p>
        </div>`;
      const card = view.querySelector(".flashcard");
      card.addEventListener("click", flip);
      view.querySelectorAll("[data-rate]").forEach((b) => b.addEventListener("click", () => rate(b.dataset.rate)));
      view.querySelector("[data-stop]").addEventListener("click", finish);
      card.focus({ preventScroll: true });
      // Size the card to fit the longer of its two faces.
      const inner = card.querySelector(".flashcard-inner");
      const h = Math.max(...[...card.querySelectorAll(".face")].map((f) => f.scrollHeight));
      inner.style.minHeight = Math.max(300, h) + "px";
    }

    function flip() {
      flipped = !flipped;
      view.querySelector(".flashcard").classList.toggle("flipped", flipped);
      if (flipped) view.querySelector(".rate").hidden = false;
    }

    function rate(r) {
      if (!current || !flipped) return;
      rateCard(c.id, current.id, r);
      counts[r]++;
      if (r === "hard") queue.splice(Math.min(HARD_REQUEUE, queue.length), 0, current);
      else done.add(current.id);
      show();
    }

    function finish() {
      const s = courseStats(c.id);
      current = null;
      view.innerHTML = `
        <div class="panel study" style="text-align:center">
          <h2>Session complete</h2>
          <div class="stats">
            <div class="stat"><div class="v" style="color:var(--good)">${counts.easy}</div><div class="l">Easy</div></div>
            <div class="stat"><div class="v" style="color:var(--warn)">${counts.medium}</div><div class="l">Medium</div></div>
            <div class="stat"><div class="v" style="color:var(--bad)">${counts.hard}</div><div class="l">Hard</div></div>
          </div>
          <p>${s.mastered} of ${s.total} cards mastered (${s.pct}%).</p>
          <div class="row" style="justify-content:center">
            <button class="btn primary" type="button" data-again>Back to flashcards</button>
            <a class="btn" href="#/course/${esc(c.id)}/quiz">Take a quiz</a>
          </div>
        </div>`;
      view.querySelector("[data-again]").addEventListener("click", () => renderFlashcards(c));
    }

    function onKey(e) {
      if (!current || e.target.matches("input, select, textarea")) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
      else if (flipped && ["1", "2", "3"].includes(e.key)) rate(["hard", "medium", "easy"][+e.key - 1]);
    }
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);
    show();
  }

  /* ---------- Quiz ---------- */

  function renderQuiz(c) {
    const data = content[c.id];
    if (!data.quiz.length) {
      setView(courseShell(c, "quiz", `<div class="panel">No quiz questions yet. Add some to <code>data/${esc(c.file)}</code>.</div>`));
      return;
    }
    const s = courseStats(c.id);
    const n = data.quiz.length;
    const sizes = [5, 10, 20].filter((x) => x < n);
    setView(courseShell(c, "quiz", `
      <div class="panel setup">
        <div class="stats">
          <div class="stat"><div class="v">${n}</div><div class="l">Questions</div></div>
          <div class="stat"><div class="v">${s.quizzes.length}</div><div class="l">Attempts</div></div>
          <div class="stat"><div class="v">${s.best === null ? "–" : s.best + "%"}</div><div class="l">Best score</div></div>
          <div class="stat"><div class="v">${s.last === null ? "–" : s.last + "%"}</div><div class="l">Last score</div></div>
        </div>
        <div class="row">
          ${topicSelect(data.quiz, "qz-topic")}
          <label class="field">Questions
            <select id="qz-size">${sizes.map((x) => `<option value="${x}" ${x === 10 ? "selected" : ""}>${x}</option>`).join("")}<option value="all" ${sizes.includes(10) ? "" : "selected"}>All (${n})</option></select>
          </label>
        </div>
        <div><button class="btn primary" type="button" data-start>Start quiz</button></div>
      </div>`));
    $main.querySelector("[data-start]").addEventListener("click", () => {
      const topic = (document.getElementById("qz-topic") || {}).value || "";
      const size = document.getElementById("qz-size").value;
      let pool = shuffle(data.quiz.filter((q) => !topic || q.topic === topic));
      if (size !== "all") pool = pool.slice(0, +size);
      startQuiz(c, pool, topic);
    });
  }

  function startQuiz(c, questions, topic) {
    const view = document.getElementById("view");
    let idx = 0, score = 0, answered = false;
    const mistakes = [];

    function show() {
      const q = questions[idx];
      answered = false;
      // Shuffle the options but remember which one is correct.
      const opts = shuffle(q.options.map((text, i) => ({ text, correct: i === q.answer })));
      view.innerHTML = `
        <div class="panel study">
          <div class="study-top"><span>Question ${idx + 1} of ${questions.length}</span><span>Score: ${score}</span></div>
          <div class="progressbar"><span style="width:${(idx / questions.length) * 100}%"></span></div>
          ${q.topic ? `<span class="chip">${esc(q.topic)}</span>` : ""}
          <div class="quiz-q">${esc(q.question)}</div>
          <div class="options">
            ${opts.map((o, i) => `<button class="option" type="button" data-i="${i}"><span class="letter">${"ABCDEFGH"[i]}</span><span>${esc(o.text)}</span></button>`).join("")}
          </div>
          <div data-feedback></div>
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
            <strong>${ok ? "✓ Correct!" : "✗ Not quite. The correct answer is: " + esc(right)}</strong>
            ${q.explanation ? esc(q.explanation) : ""}
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
      (state.quizzes[c.id] = state.quizzes[c.id] || []).push({ date: Date.now(), score, total: questions.length, topic: topic || undefined });
      save();
      const msg = pct >= 90 ? "Excellent! 🎉" : pct >= 70 ? "Well done! 👍" : pct >= 50 ? "Getting there, keep practising." : "Keep going: review the flashcards and try again.";
      view.innerHTML = `
        <div class="panel study">
          <div style="text-align:center">
            <h2>Your score</h2>
            <div class="score-big">${pct}%</div>
            <p class="muted">${score} of ${questions.length} correct · ${msg}</p>
            <div class="row" style="justify-content:center">
              <button class="btn primary" type="button" data-retry>New quiz</button>
              ${mistakes.length ? `<button class="btn" type="button" data-mistakes>Retry my mistakes (${mistakes.length})</button>` : ""}
              <a class="btn" href="#/progress">See progress</a>
            </div>
          </div>
          ${mistakes.length ? `<h3 style="margin-top:24px">Review your mistakes</h3>
          <ul class="review-list">${mistakes.map((m) => `
            <li><strong>${esc(m.q.question)}</strong><br>
              <span style="color:var(--bad)">Your answer: ${esc(m.chosen)}</span><br>
              <span style="color:var(--good)">Correct: ${esc(m.q.options[m.q.answer])}</span>
              ${m.q.explanation ? `<div class="small muted" style="margin-top:4px">${esc(m.q.explanation)}</div>` : ""}
            </li>`).join("")}</ul>` : ""}
        </div>`;
      view.querySelector("[data-retry]").addEventListener("click", () => renderQuiz(c));
      const mb = view.querySelector("[data-mistakes]");
      if (mb) mb.addEventListener("click", () => startQuiz(c, shuffle(mistakes.map((m) => m.q)), topic));
    }

    function onKey(e) {
      if (e.target.matches("input, select, textarea")) return;
      const k = e.key.toUpperCase();
      const i = "ABCDEFGH".indexOf(k) >= 0 ? "ABCDEFGH".indexOf(k) : "12345678".indexOf(e.key);
      if (!answered && i >= 0) {
        const b = view.querySelector(`.option[data-i="${i}"]`);
        if (b) b.click();
      }
    }
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);
    show();
  }

  /* ---------- Summary ---------- */

  function renderSummary(c) {
    const data = content[c.id];
    if (!data.summary.length) {
      setView(courseShell(c, "summary", `<div class="panel">No summary yet. Add one to <code>data/${esc(c.file)}</code>.</div>`));
      return;
    }
    const toc = data.summary.length > 1
      ? `<nav class="toc" aria-label="Sections">${data.summary.map((s, i) => `<a href="#" data-jump="sec-${i}"><span class="chip">${esc(s.title)}</span></a>`).join("")}</nav>`
      : "";
    const sections = data.summary.map((s, i) => `
      <section class="panel prose summary-section" id="sec-${i}">
        <h2>${esc(s.title)}</h2>
        ${renderMarkdown(s.content || "")}
      </section>`).join("");
    const sources = (data.sources || []).length
      ? `<p class="small muted">Sources: ${data.sources.map((x) => `<code>${esc(x.split("/").pop())}</code>`).join(", ")}</p>` : "";
    setView(courseShell(c, "summary", `
      <div class="row no-print" style="margin-bottom:12px">${toc}<span class="spacer"></span><button class="btn small" type="button" data-print>Print / PDF</button></div>
      ${sections}
      ${sources}`));
    $main.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.jump).scrollIntoView({ behavior: "smooth" });
    }));
    $main.querySelector("[data-print]").addEventListener("click", () => window.print());
  }

  /* ---------- Progress ---------- */

  // Bar chart of the last quiz scores (percent), single series.
  function scoreChart(quizzes) {
    const items = quizzes.slice(-12);
    if (!items.length) return `<div class="chart-empty">No quizzes taken yet</div>`;
    const W = 320, H = 150, padL = 30, padR = 6, padT = 10, padB = 20;
    const cw = W - padL - padR, ch = H - padT - padB;
    const slot = cw / Math.max(items.length, 6);
    const bw = Math.min(28, slot - 4);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Quiz scores, last ${items.length} attempts">`;
    for (const v of [0, 50, 100]) {
      const y = padT + ch - (v / 100) * ch;
      svg += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/><text class="axis-label" x="${padL - 6}" y="${y + 4}" text-anchor="end">${v}%</text>`;
    }
    items.forEach((q, i) => {
      const pct = Math.round((q.score / q.total) * 100);
      const h = Math.max(2, (pct / 100) * ch);
      const x = padL + i * slot + (slot - bw) / 2;
      const y = padT + ch - h;
      const r = Math.min(4, bw / 2, h);
      // Rounded top, square base anchored to the baseline.
      const path = `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z`;
      const label = `${new Date(q.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: ${q.score}/${q.total} (${pct}%)`;
      svg += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${ch}" data-tip="${esc(label)}"/><path class="bar" d="${path}"/>`;
    });
    svg += `<text class="axis-label" x="${padL}" y="${H - 4}">oldest</text><text class="axis-label" x="${W - padR}" y="${H - 4}" text-anchor="end">latest</text></svg>`;
    return svg;
  }

  function renderProgress() {
    const all = courses.map((c) => ({ c, s: courseStats(c.id) }));
    const totalCards = all.reduce((n, x) => n + x.s.total, 0);
    const totalMastered = all.reduce((n, x) => n + x.s.mastered, 0);
    const totalQuizzes = all.reduce((n, x) => n + x.s.quizzes.length, 0);
    const allPcts = all.flatMap((x) => x.s.quizzes.map((q) => (q.score / q.total) * 100));
    const avg = allPcts.length ? Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length) : null;

    setView(`
      <h1>Progress</h1>
      <div class="stats">
        <div class="stat"><div class="v">${totalCards ? Math.round((totalMastered / totalCards) * 100) : 0}%</div><div class="l">Cards mastered (${totalMastered}/${totalCards})</div></div>
        <div class="stat"><div class="v">${all.reduce((n, x) => n + x.s.due, 0)}</div><div class="l">Cards due today</div></div>
        <div class="stat"><div class="v">${totalQuizzes}</div><div class="l">Quizzes taken</div></div>
        <div class="stat"><div class="v">${avg === null ? "–" : avg + "%"}</div><div class="l">Average quiz score</div></div>
      </div>
      <div class="progress-grid">
        ${all.map(({ c, s }) => `
          <section class="panel" style="--c:${esc(c.color)}">
            <div class="course-head" style="margin-bottom:12px">
              <div class="course-icon" aria-hidden="true">${esc(c.icon || c.name[0])}</div>
              <h2><a href="#/course/${esc(c.id)}">${esc(c.name)}</a></h2>
            </div>
            <div class="meter-label"><span>Cards mastered</span><span>${s.mastered}/${s.total} · ${s.pct}%</span></div>
            <div class="meter"><span style="width:${s.pct}%"></span></div>
            <div class="row small muted" style="margin:8px 0 14px">
              <span>Studied ${s.seen}/${s.total}</span>· <span>${s.due} due</span>· <span>${s.hard} hard</span>
            </div>
            <div class="meter-label"><span>Quiz scores</span><span>${s.quizzes.length ? `best ${s.best}% · avg ${s.avg}%` : ""}</span></div>
            ${scoreChart(s.quizzes)}
            ${s.quizzes.length ? `<details><summary>Score history (${s.quizzes.length})</summary>
              <table class="history-table"><thead><tr><th>Date</th><th>Topic</th><th>Score</th></tr></thead><tbody>
              ${s.quizzes.slice().reverse().map((q) => `<tr><td>${new Date(q.date).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${esc(q.topic || "All")}</td><td>${q.score}/${q.total} (${Math.round((q.score / q.total) * 100)}%)</td></tr>`).join("")}
              </tbody></table></details>` : ""}
          </section>`).join("")}
      </div>`);

    // Hover/tap tooltips on the bars.
    $main.querySelectorAll(".hit").forEach((el) => {
      const bar = el.nextElementSibling;
      const showTip = (e) => {
        $tooltip.textContent = el.dataset.tip;
        $tooltip.hidden = false;
        const r = el.getBoundingClientRect();
        const tw = $tooltip.offsetWidth;
        const x = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
        $tooltip.style.left = x + "px";
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
        <h2>Exam dates</h2>
        <div class="settings-list">
          ${courses.map((c) => `
            <div class="settings-row">
              <span><strong>${esc(c.name)}</strong><br><span class="small muted">${(() => { const d = daysUntil(examDate(c)); return d === null ? "No date" : d < 0 ? "Passed" : d + " days left"; })()}</span></span>
              <input type="date" value="${esc(examDate(c))}" data-date="${esc(c.id)}" aria-label="Exam date for ${esc(c.name)}">
            </div>`).join("")}
        </div>
        <p class="small muted">Changes are saved automatically. Default dates come from <code>data/courses.json</code>.</p>
      </section>
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
        <p class="small muted">Progress is stored in this browser (localStorage). Export it to back it up or to move it to another device, then import it there.</p>
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
      </section>`);

    $main.querySelectorAll("[data-date]").forEach((inp) => inp.addEventListener("change", () => {
      state.examDates[inp.dataset.date] = inp.value;
      save();
      toast("Exam date saved");
      renderSettings();
    }));
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
      a.download = `hsg-revision-progress-${new Date().toISOString().slice(0, 10)}.json`;
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
        if (typeof data !== "object" || !data || !("cards" in data || "quizzes" in data || "examDates" in data)) throw new Error("not a progress file");
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
      const name = id ? courses.find((c) => c.id === id).name : "ALL courses";
      if (!confirm(`Delete flashcard progress and quiz history for ${name}? This cannot be undone.`)) return;
      if (id) { delete state.cards[id]; delete state.quizzes[id]; }
      else { state.cards = {}; state.quizzes = {}; }
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
