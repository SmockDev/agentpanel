const $ = (s) => document.querySelector(s);

/* The token lives in the URL fragment, never the query string, so it is not sent
   to the server in the request line and does not end up in access logs. Stash it
   and strip it from the address bar so a screenshot of the page does not leak
   the credential. */
let token = new URLSearchParams(location.hash.slice(1)).get("t") || localStorage.getItem("ap_token") || "";
if (location.hash) {
  localStorage.setItem("ap_token", token);
  history.replaceState(null, "", location.pathname);
}

let ws, term, watching = null, sessions = [], agentDims = null;

function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  ws.onopen = () => {
    setConn("live", "on");
    ws.send(JSON.stringify({ t: "hello", role: "viewer", token }));
    if (watching) ws.send(JSON.stringify({ t: "watch", id: watching }));
  };
  ws.onclose = () => {
    setConn("reconnecting", "off");
    setTimeout(connect, 1500); // phones drop sockets constantly, just come back
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function setConn(text, cls) {
  const el = $("#conn");
  el.textContent = text;
  el.className = "conn " + (cls || "");
}

function handle(m) {
  if (m.t === "denied") { setConn("bad token", "off"); ws.close(); return; }
  if (m.t === "sessions") { sessions = m.list; if (!watching) renderList(); return; }
  if (m.t === "snapshot") {
    term.reset();
    if (m.meta.cols) applyDims(m.meta.cols, m.meta.rows);
    term.write(m.d);
    $("#title").textContent = m.meta.agent;
    return;
  }
  if (m.t === "dims") { applyDims(m.cols, m.rows); return; }
  if (m.t === "out") { term.write(m.d); return; }
  if (m.t === "exit") { term.write(`\r\n\x1b[2m[exited ${m.code}]\x1b[m\r\n`); return; }
  if (m.t === "closed") { term.write("\r\n\x1b[2m[agent disconnected]\x1b[m\r\n"); return; }
  if (m.t === "gone") { showList(); }
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function renderList() {
  const list = $("#list");
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">no agents running<code>apanel run -- claude</code></div>';
    return;
  }
  list.innerHTML = "";
  for (const s of sessions) {
    const done = s.endedAt != null;
    const cls = done ? "done" : s.idle ? "wait" : "run";
    const state = done ? `exit ${s.exitCode}` : s.idle ? "needs you" : "running";
    const b = document.createElement("button");
    b.className = "row";
    b.innerHTML =
      `<span class="lamp ${cls}"></span>` +
      `<span class="meta"><span class="name">${esc(s.agent)}</span>` +
      `<span class="sub">${esc(s.host)} ${esc(s.cwd)}</span></span>` +
      `<span class="state ${s.idle && !done ? "wait" : ""}">${state} ${ago(s.startedAt)}</span>`;
    b.onclick = () => watch(s.id);
    list.appendChild(b);
  }
}

const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

function watch(id) {
  watching = id;
  $("#list").classList.add("hidden");
  $("#term").classList.remove("hidden");
  $("#bar").classList.remove("hidden");
  $("#back").classList.remove("hidden");

  if (!term) {
    term = new Terminal({
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 12, cursorBlink: false, scrollback: 4000,
      theme: { background: "#0A0B0D", foreground: "#E7E4DB" },
    });
    // No fit addon: fitting means resizing to *this* screen, which is exactly
    // what we must not do. applyDims sizes the font to the agent instead.
    term.open($("#term"));
    term.onData(sendInput);       // real keyboards still work
  }
  sendJSON({ t: "watch", id });
}

/* Match the terminal that is actually running the agent, and shrink the font
 * until those columns fit the phone. The alternative, resizing the agent's PTY
 * to the phone, reflows the terminal the developer is working in and rewraps
 * their scrollback. The desktop owns its dimensions; this end adapts. */
function applyDims(cols, rows) {
  if (!term || !cols || !rows) return;
  agentDims = { cols, rows };
  const box = $("#term");
  const width = box.clientWidth - 8; // padding
  const height = box.clientHeight - 8;
  if (width <= 0 || height <= 0) return;

  // xterm's default monospace glyph is about 0.6em wide and 1.2em tall.
  const byWidth = width / (cols * 0.6);
  const byHeight = height / (rows * 1.2);
  const size = Math.max(4, Math.min(16, Math.floor(Math.min(byWidth, byHeight))));

  term.options.fontSize = size;
  try {
    term.resize(cols, rows);
  } catch {}
}

function showList() {
  watching = null;
  $("#title").textContent = "agentpanel";
  $("#list").classList.remove("hidden");
  $("#term").classList.add("hidden");
  $("#bar").classList.add("hidden");
  $("#back").classList.add("hidden");
  renderList();
}

const sendJSON = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
const sendInput = (d) => sendJSON({ t: "in", d });

$("#back").onclick = showList;
$("#go").onclick = submit;
$("#msg").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

function submit() {
  const el = $("#msg");
  if (!el.value) return;
  sendInput(el.value + "\r");
  el.value = "";
}

for (const b of document.querySelectorAll("#keys button")) {
  b.onclick = () => {
    // data-k carries escapes as literal text, so unescape them here
    sendInput(b.dataset.k.replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\x1b/g, "\x1b").replace(/\\x03/g, "\x03"));
    $("#msg").focus();
  };
}

// Rotating the phone or opening the keyboard changes how much room we have, so
// recompute the font. The agent's column count never changes because of this.
addEventListener("resize", () => {
  if (watching && agentDims) applyDims(agentDims.cols, agentDims.rows);
});
setInterval(() => { if (!watching) renderList(); }, 10_000); // keep the ago() timers honest

if (!token) {
  $("#list").innerHTML = '<div class="empty">no token<code>open the link from `apanel link`</code></div>';
  setConn("no token", "off");
} else {
  connect();
}
