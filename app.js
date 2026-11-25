(() => {
  "use strict";
  const D = window.DATA;
  const S = D.stats;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => n.toLocaleString("en-US");
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n));
  const fdate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const sortName = (s) => s.toLowerCase().replace(/^the\s+/, "");
  const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
  const byId = Object.fromEntries(D.videos.map((v) => [v.id, v]));
  const isAnti = (g) => /anti-recommendation/.test(g.n);
  const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? "" : "s"}`;
  const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return !s.length ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const scrollBehavior = () => (reduceMotion.matches ? "auto" : "smooth");
  const PREVIEW = 8;

  // precompute search blobs. Each game matches on its own spelling AND its canonical name (g.c),
  // so "TMNT: Turtles in Time" also finds "Teenage Mutant Ninja Turtles: Turtles in Time".
  D.videos.forEach((v) => {
    v._t = norm(v.title);
    v._g = v.games.map((g) => norm(g.g) + (g.c ? "|" + norm(g.c) : ""));
    v._sys = new Set(v.games.map((g) => g.s));
  });

  /* ---------------- KPIs ---------------- */
  const years = Math.round(((new Date(S.last) - new Date(S.first)) / 3.15576e10) * 10) / 10;
  $("#kpis").innerHTML = [
    [S.videos, "videos"],
    [fmt(S.mentions), "game shout-outs"],
    [fmt(S.unique), "different games"],
    [S.systems, "systems"],
    [short(S.total_views), "views on these"],
    [years + " yrs", "of suggesting"],
  ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
  $("#foot-note").textContent = `Data pulled from ${S.channel_videos} TechDweeb uploads · ${fdate(S.first)} → ${fdate(S.last)}. Game names from video chapters & transcripts.`;

  /* ---------------- tabs + URL state ---------------- */
  const TABS = ["videos", "games", "stats"];
  const tabs = [...document.querySelectorAll("[data-tab]")];
  let tab = "videos";
  function showTab(name, write = true) {
    if (!TABS.includes(name)) name = "videos";
    tab = name;
    tabs.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1; // roving tabindex: only the active tab is in the Tab order
    });
    document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
    if (name === "stats") renderStats();
    if (name === "games") renderGames();
    if (write) writeURL();
  }
  tabs.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  // arrow / Home / End navigation between tabs (WAI-ARIA tabs pattern)
  $(".tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    const t = tabs[(n + tabs.length) % tabs.length];
    t.focus(); t.click();
  });

  const state = { q: "", type: "", sys: "", year: "", sort: "new" };
  const gstate = { q: "", sys: "", sort: "az", limit: 150 };
  function writeURL() {
    const p = new URLSearchParams();
    if (tab !== "videos") p.set("tab", tab);
    for (const k of ["q", "type", "sys", "year"]) if (state[k]) p.set(k, state[k]);
    if (state.sort !== "new") p.set("sort", state.sort);
    if (gstate.q) p.set("gq", gstate.q);
    if (gstate.sys) p.set("gsys", gstate.sys);
    if (gstate.sort !== "az") p.set("gsort", gstate.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  /* ---------------- video filters ---------------- */
  const sysList = S.systems_count.map(([s]) => s).filter((s) => s !== "Unspecified");
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  $("#f-sys").insertAdjacentHTML("beforeend", sysList.map((s) => opt(s, s)).join(""));
  $("#g-sys").insertAdjacentHTML("beforeend", sysList.map((s) => opt(s, s)).join(""));
  $("#f-year").insertAdjacentHTML("beforeend", Object.keys(S.per_year).reverse().map((y) => opt(y, y)).join(""));

  const ctrl = { q: $("#q"), type: $("#f-type"), sys: $("#f-sys"), year: $("#f-year"), sort: $("#f-sort") };
  let debounce;
  ctrl.q.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => { state.q = ctrl.q.value.trim(); renderVideos(); }, 120); });
  for (const k of ["type", "sys", "year", "sort"]) ctrl[k].addEventListener("change", () => { state[k] = ctrl[k].value; renderVideos(); });
  function resetVideos() {
    clearTimeout(debounce);
    Object.assign(state, { q: "", type: "", sys: "", year: "", sort: "new" });
    syncControls(); renderVideos();
    $("#toast").hidden = true;
  }
  $("#reset").addEventListener("click", resetVideos);
  $("#empty-reset").addEventListener("click", () => { resetVideos(); ctrl.q.focus(); });
  // push state into the form; anything the form can't represent (e.g. a junk ?sys= value) is dropped
  function syncControls() {
    for (const k in ctrl) { ctrl[k].value = state[k]; if (k !== "q") state[k] = ctrl[k].value || (k === "sort" ? "new" : ""); }
    if (!ctrl.sort.value) ctrl.sort.value = state.sort = "new";
  }

  const isHit = (v, i, g, qn) => (qn && v._g[i].includes(qn)) || (state.sys && g.s === state.sys);
  function matchVideo(v, qn) {
    if (state.type && v.type !== state.type) return false;
    if (state.year && !v.date.startsWith(state.year)) return false;
    if (state.sys && !v._sys.has(state.sys)) return false;
    if (qn && !v._t.includes(qn) && !v._g.some((g) => g.includes(qn))) return false;
    return true;
  }
  const sorters = {
    new: (a, b) => b.date.localeCompare(a.date),
    old: (a, b) => a.date.localeCompare(b.date),
    views: (a, b) => b.views - a.views,
    games: (a, b) => b.games.length - a.games.length || b.date.localeCompare(a.date),
  };

  // masonry: each card spans as many 2px grid rows as it is tall (+ its bottom margin)
  const ROW = 2, GAP = 22;
  const sizer = "ResizeObserver" in window ? new ResizeObserver((es) => es.forEach((e) => {
    e.target.style.gridRowEnd = `span ${Math.ceil((e.target.getBoundingClientRect().height + GAP) / ROW)}`;
  })) : null;
  const observeCards = (els) => sizer && els.forEach((c) => sizer.observe(c));

  const expanded = new Set();
  function renderVideos() {
    const qn = norm(state.q);
    const list = D.videos.filter((v) => matchVideo(v, qn)).sort(sorters[state.sort] || sorters.new);
    let msg = plural(list.length, "video");
    if (qn || state.sys) {
      // when hunting for something, count the matching games, not every game in the matching videos
      const hits = list.reduce((n, v) => n + v.games.filter((g, i) => !isAnti(g) && isHit(v, i, g, qn)).length, 0);
      msg += hits ? ` · ${plural(hits, "matching shout-out")}` : "";
    } else {
      msg += ` · ${plural(list.reduce((n, v) => n + v.games.filter((g) => !isAnti(g)).length, 0), "game shout-out")}`;
    }
    $("#count").textContent = msg;
    $("#empty").hidden = list.length > 0;
    if (sizer) sizer.disconnect();
    $("#grid").innerHTML = list.map((v) => card(v, qn)).join("");
    observeCards($("#grid").querySelectorAll(".card"));
    writeURL();
  }

  function card(v, qn) {
    const n = v.games.length;
    const filtering = !!(qn || state.sys);
    // when a search or system filter is active, show the whole list so matches are visible
    const showAll = expanded.has(v.id) || n <= PREVIEW + 2 || filtering;
    const shown = showAll ? v.games : v.games.slice(0, PREVIEW);
    const items = shown.map((g, i) => `<li class="${isAnti(g) ? "anti" : ""}">
        <button class="gname${isHit(v, i, g, qn) ? " hit" : ""}" type="button" data-game="${esc(g.c || g.g)}" title="Find every video with ${esc(g.c || g.g)}">${esc(g.g)}</button>
        <span class="sys">${esc(g.p || "")}</span>
        ${g.n ? `<span class="gnote">${esc(g.n)}</span>` : ""}
      </li>`).join("");
    const label = v.type === "review" ? "DGS review" : "List";
    const tip = v.type === "review" ? "Dusty Game Society review" : "Recommendation list";
    return `<article class="win card" data-id="${v.id}">
      <div class="win-bar"><span>${fdate(v.date)}</span><span class="tag ${v.type}" title="${tip}">${label}</span></div>
      <a class="thumb" href="${yt(v.id)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
        <img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy" decoding="async" width="320" height="180">
        <span class="play"><span>▶ WATCH</span></span>
        ${n ? `<span class="badge">${n} game${n === 1 ? "" : "s"}</span>` : ""}
      </a>
      <div class="card-body">
        <h3><a href="${yt(v.id)}" target="_blank" rel="noopener">${esc(v.title)}<span class="sr"> (opens YouTube)</span></a></h3>
        <p class="meta"><span>${fmt(v.views)} views</span><span>${v.dur} min</span></p>
        ${n ? `<ol class="glist">${items}</ol>` : `<p class="card-empty">${esc(v.empty || "No specific games named.")}</p>`}
        ${!showAll ? `<button class="btn btn-sm more" type="button" data-expand="${v.id}" aria-expanded="false">Show all ${n} games</button>` : ""}
        ${expanded.has(v.id) && n > PREVIEW + 2 && !filtering ? `<button class="btn btn-sm more" type="button" data-collapse="${v.id}" aria-expanded="true">Show less</button>` : ""}
      </div>
    </article>`;
  }

  // re-render just one card (no grid-wide repaint / thumbnail flash) and keep keyboard focus sensible
  function rerenderCard(id, focusSel) {
    const old = $(`.card[data-id="${CSS.escape(id)}"]`);
    if (!old) return;
    old.insertAdjacentHTML("afterend", card(byId[id], norm(state.q)));
    if (sizer) sizer.unobserve(old);
    old.remove();
    const fresh = $(`.card[data-id="${CSS.escape(id)}"]`);
    observeCards([fresh]);
    const f = $(focusSel, fresh);
    if (f) f.focus({ preventScroll: true });
    if (fresh.getBoundingClientRect().top < 0) fresh.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }

  $("#grid").addEventListener("click", (e) => {
    const ex = e.target.closest("[data-expand]"), co = e.target.closest("[data-collapse]"), g = e.target.closest("[data-game]");
    if (ex) { expanded.add(ex.dataset.expand); rerenderCard(ex.dataset.expand, `.glist li:nth-child(${PREVIEW + 1}) .gname`); }
    else if (co) { expanded.delete(co.dataset.collapse); rerenderCard(co.dataset.collapse, "[data-expand]"); }
    else if (g) searchGame(g.dataset.game);
  });

  function searchGame(name) {
    clearTimeout(debounce);
    Object.assign(state, { q: name, type: "", sys: "", year: "" });
    syncControls();
    showTab("videos");
    renderVideos();
    $(".toolbar").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    toast(`Showing every video with “${name}”`);
  }

  let toastT;
  function toast(msg) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span><button type="button">Clear filter</button>`;
    t.hidden = false;
    t.querySelector("button").onclick = () => { resetVideos(); ctrl.q.focus({ preventScroll: true }); };
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 6000);
  }

  /* ---------------- Games A–Z ---------------- */
  const G = D.games.map(([name, n, sys, vids, all]) => ({ name, n, sys, vids, all, _n: norm(name) }));
  const gctrl = { q: $("#gq"), sys: $("#g-sys"), sort: $("#g-sort") };
  gctrl.q.addEventListener("input", () => { gstate.q = gctrl.q.value.trim(); gstate.limit = 150; renderGames(); });
  gctrl.sys.addEventListener("change", () => { gstate.sys = gctrl.sys.value; gstate.limit = 150; renderGames(); });
  gctrl.sort.addEventListener("change", () => { gstate.sort = gctrl.sort.value; renderGames(); });
  $("#gmore").addEventListener("click", () => {
    const next = gstate.limit;
    gstate.limit += 300; renderGames();
    const row = $(`#gbody tr:nth-child(${next + 1}) .gn button`);
    if (row) row.focus({ preventScroll: true });
  });
  $("#gbody").addEventListener("click", (e) => { const b = e.target.closest("[data-game]"); if (b) searchGame(b.dataset.game); });
  function renderGames() {
    const qn = norm(gstate.q);
    // a game counts for a system if it was ever suggested on it, not just on its most common one
    let rows = G.filter((g) => (!qn || g._n.includes(qn)) && (!gstate.sys || g.all.includes(gstate.sys)));
    if (gstate.sort === "n") rows = [...rows].sort((a, b) => b.n - a.n || sortName(a.name).localeCompare(sortName(b.name)));
    $("#gcount").textContent = rows.length ? plural(rows.length, "game") : "No games match. Try fewer letters?";
    $("#gbody").innerHTML = rows.slice(0, gstate.limit).map((g) => `<tr>
      <td class="gn"><button type="button" data-game="${esc(g.name)}" title="Show every video with ${esc(g.name)}">${esc(g.name)}</button></td>
      <td class="sysc">${esc(g.sys)}${g.all.length > 1 ? ` <span class="plus" title="${esc(g.all.join(", "))}">+${g.all.length - 1}</span>` : ""}</td>
      <td class="num">${g.n}</td>
      <td class="vl"><div class="vlinks">${g.vids.map((id) => byId[id]).sort((a, b) => b.date.localeCompare(a.date))
        .map((v) => `<a href="${yt(v.id)}" target="_blank" rel="noopener" title="${esc(v.title)}">${esc(v.title)}</a>`).join("")}</div></td>
    </tr>`).join("");
    const left = rows.length - gstate.limit;
    $("#gmore").hidden = left <= 0;
    $("#gmore").textContent = `Show ${fmt(Math.min(300, left))} more (${fmt(left)} to go)`;
    writeURL();
  }

  /* ---------------- Stats ---------------- */
  let statsDone = false;
  const PAL = { orange: "#ff6700", purple: "#7a2d86", ink: "#040201", rust: "#bb4d3e", teal: "#0f9c96", sand: "#d9c6a5", grey: "#efe8de" };
  const winCard = (cls, file, title, lede, body) =>
    `<article class="win stat-card ${cls}"><div class="win-bar"><span>${file}</span><span class="win-btns" aria-hidden="true"><i></i><i></i></span></div>
     <div class="win-body"><h3>${title}</h3>${lede ? `<p class="lede">${lede}</p>` : ""}${body}</div></article>`;
  const stack = (cls, ...cards) => `<div class="stack ${cls}">${cards.join("")}</div>`;
  const bars = (rows, max, cls = "", clickAttr = null, fmtV = (v) => v) => `<div class="bars">${rows.map(([label, v, extra]) => `
      <div class="bar${clickAttr ? " click" : ""}" ${clickAttr ? `role="button" tabindex="0" ${clickAttr}="${esc(label)}" aria-label="${esc(label)}: ${v}"` : ""} title="${esc(label)}: ${fmt(v)}${extra ? " · " + esc(extra) : ""}">
        <span class="bar-l">${esc(label)}</span>
        <span class="bar-t" aria-hidden="true"><span class="bar-f ${cls}" style="width:${(v / max) * 100}%"></span></span>
        <span class="bar-v">${fmtV(v)}</span>
      </div>`).join("")}</div>`;
  const listAnd = (a) => (a.length < 3 ? a.join(" and ") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

  function renderStats() {
    if (statsDone) return; statsDone = true;
    const html = {};

    // 1. Most recommended games
    const TOP = 25;
    const tg = S.top_games.slice(0, TOP);
    const leaders = tg.filter((g) => g.n === tg[0].n);
    const cutN = tg[tg.length - 1].n;
    const moreTied = G.filter((g) => g.n === cutN).length - tg.filter((g) => g.n === cutN).length;
    const leadTxt = leaders.length === 1
      ? `<b>${esc(leaders[0].name)}</b> is the champ with ${tg[0].n} videos.`
      : `${listAnd(leaders.map((g) => `<b>${esc(g.name)}</b>`))} are tied at the top with ${tg[0].n} videos each.`;
    html.fame = winCard("s-7", "hall_of_fame.exe", "The Hall of Fame",
      `The ${TOP} games I keep bringing up in separate videos${moreTied > 0 ? ` (${moreTied} more are tied on ${cutN})` : ""}. Click one to see every video it’s in.`,
      bars(tg.map((g) => [g.name, g.n, g.sys]), tg[0].n, "", "data-sg") +
      `<p class="insight">${leadTxt} Meanwhile <b>${fmt(S.once)}</b> of ${fmt(S.unique)} games (${Math.round((S.once / S.unique) * 100)}%) only ever got suggested once.</p>`);

    // 2. Retro vs modern + mini facts
    const eraMap = Object.fromEntries(S.era);
    const eraTotal = S.era.reduce((n, [, v]) => n + v, 0);
    const eraCols = { Retro: PAL.orange, Modern: PAL.purple, Tabletop: PAL.teal, Unspecified: PAL.sand };
    const segs = S.era.map(([k, v]) => `<div style="flex:${v};background:${eraCols[k] || PAL.sand}" title="${k}: ${v}">${v / eraTotal > 0.08 ? Math.round((v / eraTotal) * 100) + "%" : ""}</div>`).join("");
    const retroPct = Math.round(((eraMap.Retro || 0) / eraTotal) * 100);
    html.era = winCard("", "retro_vs_modern.ini", "Retro vs. Modern",
      "Every game shout-out, sorted by whether it runs on old hardware or something modern (new PC games, PICO-8, Android).",
      `<div class="split" role="img" aria-label="${S.era.map(([k, v]) => `${k} ${v}`).join(", ")}">${segs}</div>
       <div class="legend">${S.era.map(([k, v]) => `<span><i style="background:${eraCols[k] || PAL.sand}"></i>${k} · ${v}</span>`).join("")}</div>
       <div class="mini mt">
         <div><b>${S.avg_list}</b><span>avg games per list</span></div>
         <div><b>${S.median_list}</b><span>median list size</span></div>
         <div><b>${Math.max(...S.scatter.map((s) => s.n))}</b><span>biggest list</span></div>
       </div>
       <p class="insight">About <b>${retroPct}%</b> of everything I suggest is ${retroPct >= 50 ? "retro. Shocking, I know." : "retro. Wait, really?"}</p>`);

    // 3. Systems
    const sc = S.systems_count.filter(([s]) => s !== "Unspecified");
    html.systems = winCard("s-5", "systems.cfg", "Shout-outs by System",
      "Click a system to filter the video list by it.",
      bars(sc, sc[0][1], "k", "data-ss"));

    // 4. Views comparison
    const vc = S.view_cmp;
    const VLAB = { "Recommendation lists": "Game lists", "Hardware / tech / other": "Hardware & other", "Single-game reviews": "DGS reviews" };
    const vorder = Object.keys(VLAB).filter((k) => vc[k]);
    const vmax = Math.max(...vorder.map((k) => vc[k].median));
    const rl = vc["Recommendation lists"], hw = vc["Hardware / tech / other"];
    const lift = Math.round((rl.median / hw.median - 1) * 100);
    html.views = winCard("", "do_lists_win.exe", "Do Game Lists Get More Views?",
      `Median views per video across all ${S.channel_videos} of my uploads, grouped by video type.`,
      bars(vorder.map((k) => [VLAB[k], vc[k].median, `${vc[k].n} videos · mean ${fmt(vc[k].mean)}`]), vmax, "p", null, short) +
      `<div class="mini mt">${vorder.map((k) => `<div><b>${vc[k].n}</b><span>${esc(VLAB[k])}</span></div>`).join("")}</div>
       <p class="insight">Game lists pull a median of <b>${short(rl.median)}</b> views, <b>${Math.abs(lift)}% ${lift >= 0 ? "more" : "fewer"}</b> than my hardware videos. Dusty Game Society reviews are a labour of love (and it shows in the views).</p>`);

    // 5. Over time
    const py = S.per_year, ys = Object.keys(py);
    const tot = (y) => py[y].lists + py[y].reviews;
    const ymax = Math.max(...ys.map(tot));
    const colsHtml = ys.map((y) => `<div class="col" title="${y}: ${py[y].lists} lists, ${py[y].reviews} reviews, ${py[y].games} games">
        <span class="top">${tot(y)}</span>
        <div class="seg" style="height:${(py[y].reviews / ymax) * 85}%;background:${PAL.purple}"></div>
        <div class="seg" style="height:${(py[y].lists / ymax) * 85}%;background:${PAL.orange}"></div>
      </div>`).join("");
    const peak = ys.reduce((a, b) => (py[b].games > py[a].games ? b : a));
    const growing = ys.every((y, i) => !i || tot(y) > tot(ys[i - 1]));
    const partial = S.first.slice(5) > "01-31" ? ` (${ys[0]} only counts from ${fdate(S.first).replace(/,.*/, "")}, when this all started)` : "";
    html.time = winCard("s-6", "timeline.log", growing ? "Suggesting More Every Year" : "Suggestions Over Time",
      `Recommendation lists &amp; Dusty Game Society reviews uploaded per year${partial}.`,
      `<div class="cols" role="img" aria-label="${ys.map((y) => `${y}: ${py[y].lists} lists and ${py[y].reviews} reviews`).join("; ")}">${colsHtml}</div>
       <div class="col-l" aria-hidden="true">${ys.map((y) => `<span>${y}</span>`).join("")}</div>
       <div class="legend mt-s"><span><i style="background:${PAL.orange}"></i>Recommendation lists</span><span><i style="background:${PAL.purple}"></i>DGS reviews</span></div>
       <p class="insight"><b>${peak}</b> was the big one: <b>${fmt(py[peak].games)}</b> game shout-outs in a single year.</p>`);

    // 6. List length vs views scatter
    html.scatter = winCard("s-7 scatter", "length_vs_views.plt", "Does a Longer List = More Views?",
      "Each dot is a recommendation list. Hover (or tap) for the title, click (or tap again) to watch.", scatterSVG() + scatterInsight());

    // 7. Themes
    const th = S.themes;
    html.themes = winCard("s-5", "list_themes.txt", "What Kind of Lists Do I Make?",
      "Recommendation lists grouped by the theme in their title.",
      bars(th, th[0][1], "p") +
      `<p class="insight"><b>${esc(th[0][0])}</b> ${th[0][0] === "Hidden gems" ? "are my whole personality, apparently" : "win, apparently"}: ${th[0][1]} of ${S.lists} lists.</p>`);

    // 8. Most viewed
    html.top = winCard("s-6", "most_watched.exe", "Most Watched",
      "The recommendation lists and reviews with the most views. Thank you, algorithm.",
      `<ol class="toplist">${S.top_viewed.map((v) => `<li><a href="${yt(v.id)}" target="_blank" rel="noopener">${esc(v.t)}</a><span class="v" title="${fmt(v.views)} views">${short(v.views)}</span></li>`).join("")}</ol>`);

    // 9. System mix by year (top 6 systems)
    const topSys = sc.slice(0, 6).map(([s]) => s);
    const sysCols = [PAL.orange, PAL.ink, PAL.purple, PAL.teal, PAL.rust, PAL.sand];
    const mix = ys.map((y) => {
      const m = Object.fromEntries(S.year_sys[y] || []);
      const all = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      const other = all - topSys.reduce((n, s) => n + (m[s] || 0), 0);
      const desc = topSys.filter((s) => m[s]).map((s) => `${s} ${Math.round((m[s] / all) * 100)}%`).join(", ");
      return `<div class="mix-row"><span>${y}</span>
        <div class="split" role="img" aria-label="${y}: ${esc(desc)}, other ${Math.round((other / all) * 100)}%">${topSys.map((s, i) => m[s] ? `<div style="flex:${m[s]};background:${sysCols[i]}" title="${y} · ${esc(s)}: ${m[s]}"></div>` : "").join("")}${other ? `<div style="flex:${other};background:${PAL.grey}" title="${y} · Other: ${other}"></div>` : ""}</div></div>`;
    }).join("");
    // biggest swing in share between the first and last year, so the sentence stays true if the data changes
    const share = (y, sys) => { const m = Object.fromEntries(S.year_sys[y] || []), t = Object.values(m).reduce((a, b) => a + b, 0) || 1; return Math.round(((m[sys] || 0) / t) * 100); };
    const [y0, y1] = [ys[0], ys[ys.length - 1]];
    const swing = topSys.map((s) => [s, share(y0, s), share(y1, s)]).sort((a, b) => Math.abs(b[2] - b[1]) - Math.abs(a[2] - a[1]))[0];
    const mixInsight = `<p class="insight"><b>${esc(swing[0])}</b> went from <b>${swing[1]}%</b> of my shout-outs in ${y0} to <b>${swing[2]}%</b> in ${y1}. ${swing[2] > swing[1] ? "I regret nothing." : "Sorry, old friend."}</p>`;
    html.mix = winCard("s-7", "system_mix_by_year.ini", "How My Taste Shifted",
      "Share of each year’s shout-outs going to my six most-suggested systems (grey = everything else).",
      mix + `<div class="legend mt-s">${topSys.map((s, i) => `<span><i style="background:${sysCols[i]}"></i>${esc(s)}</span>`).join("")}<span><i style="background:${PAL.grey}"></i>Other</span></div>` + mixInsight);

    // paired so the two cards in each row end up roughly the same height
    $("#stats").innerHTML = [
      html.fame, stack("s-5", html.era, html.views),
      html.systems, html.scatter,
      html.time, html.top,
      html.themes, html.mix,
    ].join("");
    wireStats();
  }

  function scatterSVG() {
    const pts = S.scatter, W = 560, H = 350, P = { l: 56, r: 14, t: 12, b: 52 };
    const xmax = Math.ceil(Math.max(...pts.map((p) => p.n)) / 10) * 10;
    const raw = Math.max(...pts.map((p) => p.views)) / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw), ymax = step * 4;
    const x = (n) => P.l + (n / xmax) * (W - P.l - P.r), y = (v) => H - P.b - (v / ymax) * (H - P.t - P.b);
    let g = "";
    for (let i = 0; i <= 4; i++) { const v = (ymax / 4) * i; g += `<line class="gl" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`; }
    for (let i = 0; i <= xmax; i += 10) g += `<text x="${x(i)}" y="${H - P.b + 20}" text-anchor="middle">${i}</text>`;
    g += `<line class="ax" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/><line class="ax" x1="${P.l}" x2="${P.l}" y1="${P.t}" y2="${H - P.b}"/>`;
    g += `<text x="${(W + P.l) / 2}" y="${H - 6}" text-anchor="middle">games in the list →</text><text x="${P.l + 8}" y="${P.t + 16}">↑ views</text>`;
    const dots = pts.map((p) => `<circle class="dot" tabindex="0" role="link" aria-label="${esc(p.t)}: ${p.n} games, ${fmt(p.views)} views" r="6" cx="${x(p.n).toFixed(1)}" cy="${y(p.views).toFixed(1)}" data-id="${p.id}" data-tip="${esc(p.t)} — ${p.n} games, ${fmt(p.views)} views"></circle>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Scatter plot of list length versus views">${g}${dots}</svg>`;
  }
  function scatterInsight() {
    const pts = S.scatter, n = pts.length;
    const mx = pts.reduce((a, p) => a + p.n, 0) / n, my = pts.reduce((a, p) => a + p.views, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    pts.forEach((p) => { sxy += (p.n - mx) * (p.views - my); sxx += (p.n - mx) ** 2; syy += (p.views - my) ** 2; });
    const r = sxy / Math.sqrt(sxx * syy);
    const big = pts.filter((p) => p.n >= 20).map((p) => p.views), small = pts.filter((p) => p.n < 10).map((p) => p.views);
    const word = Math.abs(r) < 0.1 ? "basically no" : Math.abs(r) < 0.3 ? "a weak" : Math.abs(r) < 0.5 ? "a moderate" : "a strong";
    const dir = Math.abs(r) < 0.1 ? "" : r >= 0 ? " positive" : " negative";
    return `<p class="insight">Correlation r = <b>${r.toFixed(2)}</b>: ${word}${dir} link. Lists with 20+ games get a median of <b>${short(median(big))}</b> views vs <b>${short(median(small))}</b> for lists under 10. So… more games, please?</p>`;
  }

  function wireStats() {
    const root = $("#stats");
    let tip, tipFor = null, lastPointer = "mouse";
    const hideTip = () => { if (tip) tip.hidden = true; tipFor = null; };
    const showTip = (el, cx, cy) => {
      if (!tip) { tip = document.createElement("div"); tip.className = "tip"; tip.setAttribute("aria-hidden", "true"); document.body.appendChild(tip); }
      tip.textContent = el.dataset.tip; tip.hidden = false; tipFor = el;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(cx + 14, innerWidth - w - 8)) + "px";
      tip.style.top = (cy + 14 + h > innerHeight - 8 ? cy - h - 10 : cy + 14) + "px";
    };
    const act = (el) => {
      if (el.dataset.sg) searchGame(el.dataset.sg);
      else if (el.dataset.ss) {
        clearTimeout(debounce);
        Object.assign(state, { q: "", type: "", sys: el.dataset.ss, year: "" });
        syncControls(); showTab("videos"); renderVideos();
        $(".toolbar").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        toast(`Showing videos with ${el.dataset.ss} games`);
      } else if (el.dataset.id) { hideTip(); window.open(yt(el.dataset.id), "_blank", "noopener"); }
    };
    root.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType; });
    root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-sg],[data-ss],[data-id]");
      if (!el) return hideTip();
      // on touch there's no hover: first tap shows the title, second tap on the same dot opens it
      if (el.dataset.id && lastPointer === "touch" && tipFor !== el) { const r = el.getBoundingClientRect(); return showTip(el, r.left, r.bottom); }
      act(el);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = e.target.closest("[data-sg],[data-ss],[data-id]"); if (el) { e.preventDefault(); act(el); }
    });
    root.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      const d = e.target.closest(".dot"); if (d) showTip(d, e.clientX, e.clientY); else hideTip();
    });
    root.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hideTip(); });
    root.addEventListener("focusin", (e) => { const d = e.target.closest(".dot"); if (d) { const r = d.getBoundingClientRect(); showTip(d, r.right, r.bottom); } });
    root.addEventListener("focusout", hideTip);
    addEventListener("scroll", () => { if (tip && !tip.hidden) hideTip(); }, { passive: true });
  }

  /* ---------------- boot ---------------- */
  const p = new URLSearchParams(location.search);
  for (const k of ["q", "type", "sys", "year", "sort"]) if (p.get(k)) state[k] = p.get(k);
  gstate.q = p.get("gq") || "";
  gstate.sort = p.get("gsort") || "az";
  gstate.sys = p.get("gsys") || "";
  for (const k in gctrl) { gctrl[k].value = gstate[k]; if (k !== "q") gstate[k] = gctrl[k].value || (k === "sort" ? "az" : ""); }
  syncControls();
  tab = TABS.includes(p.get("tab")) ? p.get("tab") : "videos"; // set before rendering so writeURL keeps ?tab=
  renderVideos();
  showTab(tab);
})();
