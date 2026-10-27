const $ = (sel) => document.querySelector(sel);
const STATUS_INTERVAL_MS = 30_000;

let config = null;
let activeCategory = "All";
const cardsById = new Map();

// ---------- Dashboard ----------

function renderIcon(el, icon, name) {
  if (/^(https?:)?\/\/|^\/|\.(svg|png|webp|jpg)$/i.test(icon)) {
    const img = new Image();
    img.src = icon;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => (el.textContent = name[0]);
    el.append(img);
  } else {
    el.textContent = icon || name[0];
  }
}

function renderGrid() {
  const grid = $("#grid");
  grid.replaceChildren();
  cardsById.clear();
  const tpl = $("#card-tpl");

  for (const cat of config.categories) {
    const section = document.createElement("section");
    section.className = "category";
    section.dataset.category = cat.name;
    const h2 = document.createElement("h2");
    h2.innerHTML = `<span></span><span class="count"></span>`;
    h2.firstChild.textContent = `${cat.icon} ${cat.name}`.trim();
    const list = document.createElement("div");
    list.className = "cards";

    for (const s of cat.services) {
      const card = tpl.content.firstElementChild.cloneNode(true);
      card.href = s.url;
      card.dataset.search = [s.name, s.description, s.category, s.via, ...s.tags].join(" ").toLowerCase();
      card.querySelector(".name").textContent = s.name;
      card.querySelector(".desc").textContent = s.description;
      const via = card.querySelector(".via");
      via.textContent = s.via;
      via.dataset.via = s.via;
      renderIcon(card.querySelector(".icon"), s.icon, s.name);
      const dot = card.querySelector(".dot");
      dot.dataset.state = s.monitored ? "checking" : "unmonitored";
      dot.title = s.monitored ? "Checking…" : "Not monitored";
      list.append(card);
      cardsById.set(s.id, card);
    }
    section.append(h2, list);
    grid.append(section);
  }
  applyFilter();
}

function renderFilters() {
  const nav = $("#filters");
  nav.replaceChildren();
  for (const name of ["All", ...config.categories.map((c) => c.name)]) {
    const b = document.createElement("button");
    b.textContent = name;
    b.setAttribute("aria-pressed", String(name === activeCategory));
    b.onclick = () => {
      activeCategory = name;
      nav.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      applyFilter();
    };
    nav.append(b);
  }
}

function applyFilter() {
  const q = $("#search").value.trim().toLowerCase();
  let shown = 0;
  for (const section of document.querySelectorAll("section.category")) {
    const catMatch = activeCategory === "All" || section.dataset.category === activeCategory;
    let visible = 0;
    for (const card of section.querySelectorAll(".card")) {
      const ok = catMatch && (!q || card.dataset.search.includes(q));
      card.hidden = !ok;
      if (ok) visible++;
    }
    section.hidden = visible === 0;
    section.querySelector(".count").textContent = visible ? `· ${visible}` : "";
    shown += visible;
  }
  let empty = $("#grid .empty");
  if (!shown && !empty) {
    empty = document.createElement("p");
    empty.className = "empty muted";
    empty.textContent = "No services match.";
    $("#grid").append(empty);
  } else if (shown && empty) empty.remove();
}

async function refreshStatus() {
  try {
    const res = await fetch("api/status");
    if (!res.ok) throw new Error(res.statusText);
    const status = await res.json();
    const counts = { up: 0, down: 0, degraded: 0 };
    for (const [id, s] of Object.entries(status)) {
      const card = cardsById.get(id);
      if (!card) continue;
      const dot = card.querySelector(".dot");
      dot.dataset.state = s.state;
      dot.title =
        s.state === "up" ? `Up · HTTP ${s.code} · ${s.ms} ms`
        : s.state === "down" ? `Down · ${s.detail ?? ""}`
        : s.state === "degraded" ? `Degraded · HTTP ${s.code}`
        : "Not monitored";
      card.querySelector(".latency").textContent = s.state === "up" ? `${s.ms} ms` : s.state === "down" ? "offline" : "";
      if (s.state in counts) counts[s.state]++;
    }
    renderSummary(counts);
  } catch (err) {
    console.warn("status check failed", err);
  }
}

function renderSummary({ up, down, degraded }) {
  const pill = (color, label) => `<span class="pill"><i style="background:var(${color})"></i>${label}</span>`;
  $("#summary").innerHTML =
    pill("--up", `${up} up`) +
    (degraded ? pill("--warn", `${degraded} degraded`) : "") +
    (down ? pill("--down", `${down} down`) : "");
}

function tickClock() {
  const now = new Date();
  $("#clock").textContent = now.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ---------- Agent ----------

const agent = {
  sessionId: sessionStorage.getItem("miggles-session") || null,
  busy: false,
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Small, safe markdown subset: code blocks, inline code, bold, italics, links, bullet lists.
function renderMarkdown(src) {
  const blocks = escapeHtml(src).split(/```/);
  return blocks
    .map((chunk, i) => {
      if (i % 2) return `<pre><code>${chunk.replace(/^\w*\n/, "")}</code></pre>`;
      return chunk
        .split(/\n{2,}/)
        .map((para) => {
          const inline = (t) =>
            t
              .replace(/`([^`]+)`/g, "<code>$1</code>")
              .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
              .replace(/(^|[\s(])_([^_]+)_/g, "$1<em>$2</em>")
              .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
          const lines = para.split("\n").filter((l) => l.trim());
          if (lines.length && lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
            return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>`).join("")}</ul>`;
          }
          return para.trim() ? `<p>${inline(para).replace(/\n/g, "<br>")}</p>` : "";
        })
        .join("");
    })
    .join("");
}

function addMsg(kind, text = "") {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  if (kind === "bot") div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  $("#agent-log").append(div);
  scrollLog();
  return div;
}

const scrollLog = () => ($("#agent-log").scrollTop = $("#agent-log").scrollHeight);

const TOOL_LABELS = {
  list_services: "Looking up services…",
  check_services: "Checking service status…",
  server_stats: "Reading server stats…",
};

async function sendMessage(text) {
  if (agent.busy || !text.trim()) return;
  agent.busy = true;
  $("#agent-form button").disabled = true;
  document.querySelector(".chips")?.remove();
  addMsg("user", text);

  let bubble = null;
  let buffer = "";
  const ensureBubble = () => {
    if (!bubble) {
      bubble = addMsg("bot");
      bubble.classList.add("typing");
    }
    return bubble;
  };
  ensureBubble();

  try {
    const res = await fetch("api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: agent.sessionId, text }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      const events = pending.split("\n\n");
      pending = events.pop();
      for (const raw of events) {
        const event = raw.match(/^event: (.+)$/m)?.[1];
        const data = JSON.parse(raw.match(/^data: (.+)$/m)?.[1] ?? "{}");
        if (event === "session") {
          agent.sessionId = data.id;
          sessionStorage.setItem("miggles-session", data.id);
        } else if (event === "text") {
          buffer += data.delta;
          ensureBubble().innerHTML = renderMarkdown(buffer);
          scrollLog();
        } else if (event === "tool") {
          // Finish the current bubble, show what the agent is doing, start a fresh one.
          if (bubble && !buffer.trim()) bubble.remove();
          else bubble?.classList.remove("typing");
          bubble = null;
          buffer = "";
          const note = document.createElement("div");
          note.className = "tool-note";
          note.textContent = `🔧 ${TOOL_LABELS[data.name] ?? data.name}`;
          $("#agent-log").append(note);
          ensureBubble();
        } else if (event === "error") {
          throw new Error(data.message);
        }
      }
    }
  } catch (err) {
    if (bubble && !buffer.trim()) bubble.remove();
    bubble = null;
    addMsg("error", err.message);
  } finally {
    if (bubble && !buffer.trim()) bubble.remove();
    bubble?.classList.remove("typing");
    agent.busy = false;
    $("#agent-form button").disabled = false;
    scrollLog();
  }
}

function setupAgent() {
  const panel = $("#agent");
  const fab = $("#agent-fab");
  fab.hidden = false;
  const open = (state) => {
    panel.hidden = !state;
    fab.hidden = state;
    fab.setAttribute("aria-expanded", String(state));
    if (state) $("#agent-input").focus();
  };
  fab.onclick = () => open(true);
  $("#agent-close").onclick = () => open(false);
  $("#agent-reset").onclick = async () => {
    if (agent.sessionId) {
      fetch("api/agent/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: agent.sessionId }),
      });
    }
    agent.sessionId = null;
    sessionStorage.removeItem("miggles-session");
    $("#agent-log").replaceChildren();
    addMsg("bot", "New conversation. What do you need?");
  };

  const input = $("#agent-input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#agent-form").requestSubmit();
    }
  });
  $("#agent-form").onsubmit = (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = "";
    input.style.height = "auto";
    sendMessage(text);
  };
  for (const chip of document.querySelectorAll(".chip")) chip.onclick = () => sendMessage(chip.textContent);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) open(false);
  });
}

// ---------- Boot ----------

async function boot() {
  const res = await fetch("api/config");
  config = await res.json();
  document.title = config.title;
  $("#title").textContent = config.title;
  $("#subtitle").textContent = config.user ? `${config.subtitle}  ·  ${config.user}` : config.subtitle;

  renderFilters();
  renderGrid();
  if (config.agent?.enabled) setupAgent();

  $("#search").addEventListener("input", applyFilter);
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      e.preventDefault();
      $("#search").focus();
    }
  });

  tickClock();
  setInterval(tickClock, 15_000);
  refreshStatus();
  setInterval(() => document.visibilityState === "visible" && refreshStatus(), STATUS_INTERVAL_MS);
}

boot().catch((err) => {
  $("#grid").innerHTML = `<p class="empty muted">Couldn't load the dashboard: ${escapeHtml(err.message)}</p>`;
});
