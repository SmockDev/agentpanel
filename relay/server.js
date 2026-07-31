import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

/* The relay is a switchboard, nothing more. Agents dial in and push their
 * terminal output; viewers dial in and watch, and can type back. The relay never
 * interprets the stream, it only copies bytes between the two sides and keeps
 * enough scrollback that opening your phone mid-session shows the current screen
 * instead of an empty box.
 *
 * Deliberately stateless on disk. Sessions live in memory and die with the
 * process. Agent output contains source code and whatever secrets happen to be
 * on screen, so the less of it that touches a disk we own, the better.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
/* Bind to loopback by default. In production Caddy terminates TLS and proxies in,
 * so the relay itself should never be reachable over plain HTTP from outside:
 * the token is a bearer credential and the stream is your source code. */
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.AGENTPANEL_TOKEN;

if (!TOKEN || TOKEN.length < 16) {
  console.error("AGENTPANEL_TOKEN must be set and at least 16 chars");
  process.exit(1);
}

/* Compare in constant time. A naive === leaks the token one character at a time
 * to anyone willing to measure, and this token is the only thing standing between
 * the internet and a live shell. */
function validToken(given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false; // length is not secret, contents are
  return timingSafeEqual(a, b);
}

const MAX_SCROLLBACK = 256 * 1024;
const PUBLIC = join(__dirname, "public");

const ASSETS = {
  "/vendor/xterm.js": { file: "vendor/xterm.js", type: "text/javascript; charset=utf-8" },
  "/vendor/addon-fit.js": { file: "vendor/addon-fit.js", type: "text/javascript; charset=utf-8" },
  "/vendor/xterm.css": { file: "vendor/xterm.css", type: "text/css; charset=utf-8" },
};

/** id -> { id, agent, cwd, host, startedAt, endedAt, exitCode, buffer, sock, viewers:Set } */
const sessions = new Map();

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

function sessionSummary(s) {
  return {
    id: s.id,
    agent: s.agent,
    cwd: s.cwd,
    host: s.host,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    exitCode: s.exitCode ?? null,
    idle: s.idle,
    bytes: s.totalBytes,
  };
}

function broadcastSessionList() {
  const list = [...sessions.values()].map(sessionSummary);
  for (const s of sessions.values()) {
    for (const v of s.viewers) send(v, { t: "sessions", list });
  }
  for (const v of lobby) send(v, { t: "sessions", list });
}

// Viewers that have connected but are not watching anything specific yet.
const lobby = new Set();

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  /* Static serving is deliberately a whitelist rather than a path join against
   * user input. Mapping URLs onto the filesystem is how servers end up handing
   * out /etc/passwd to anyone who types ../, and this box holds an SSH key. */
  const asset = ASSETS[req.url];
  if (asset) {
    res.writeHead(200, { "content-type": asset.type, "cache-control": "public,max-age=604800" });
    res.end(readFileSync(join(PUBLIC, asset.file)));
    return;
  }

  try {
    const html = readFileSync(join(PUBLIC, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      // Everything is same-origin now, so say so and mean it.
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:",
    });
    res.end(html);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let role = null;
  let session = null;

  /* Nothing is trusted until the first message authenticates. An unauthenticated
   * socket that never says hello is dropped by the heartbeat. */
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!role) {
      if (msg.t !== "hello" || !validToken(msg.token)) {
        send(ws, { t: "denied" });
        ws.close(4001, "unauthorized");
        return;
      }
      role = msg.role === "agent" ? "agent" : "viewer";

      if (role === "agent") {
        session = {
          id: randomUUID().slice(0, 8),
          agent: String(msg.agent || "agent").slice(0, 64),
          cwd: String(msg.cwd || "").slice(0, 200),
          host: String(msg.host || "").slice(0, 64),
          startedAt: Date.now(),
          idle: false,
          totalBytes: 0,
          buffer: "",
          sock: ws,
          viewers: new Set(),
        };
        sessions.set(session.id, session);
        send(ws, { t: "ready", id: session.id });
        console.log(`[+] ${session.id} ${session.agent} from ${session.host}`);
        broadcastSessionList();
      } else {
        lobby.add(ws);
        send(ws, { t: "sessions", list: [...sessions.values()].map(sessionSummary) });
      }
      return;
    }

    if (role === "agent") {
      if (msg.t === "out" && typeof msg.d === "string") {
        session.totalBytes += msg.d.length;
        session.idle = false;
        session.buffer += msg.d;
        if (session.buffer.length > MAX_SCROLLBACK) {
          session.buffer = session.buffer.slice(-MAX_SCROLLBACK);
        }
        for (const v of session.viewers) send(v, { t: "out", d: msg.d });
      } else if (msg.t === "idle") {
        session.idle = true;
        broadcastSessionList();
      } else if (msg.t === "exit") {
        session.exitCode = msg.code ?? null;
        session.endedAt = Date.now();
        for (const v of session.viewers) send(v, { t: "exit", code: session.exitCode });
        broadcastSessionList();
      }
      return;
    }

    // viewer
    if (msg.t === "watch") {
      const target = sessions.get(msg.id);
      if (!target) return send(ws, { t: "gone" });
      lobby.delete(ws);
      if (session) session.viewers.delete(ws);
      session = target;
      session.viewers.add(ws);
      /* Replay the buffer so the viewer sees the current screen. Raw bytes,
       * escape sequences and all, because the terminal emulator on the other end
       * needs to replay the same state the local terminal is already in. */
      send(ws, { t: "snapshot", d: session.buffer, meta: sessionSummary(session) });
    } else if (msg.t === "in" && typeof msg.d === "string" && session) {
      // This is the "steer" half. Straight through to the agent's stdin.
      send(session.sock, { t: "in", d: msg.d });
    } else if (msg.t === "resize" && session) {
      send(session.sock, { t: "resize", cols: msg.cols, rows: msg.rows });
    }
  });

  ws.on("close", () => {
    lobby.delete(ws);
    if (role === "agent" && session) {
      for (const v of session.viewers) send(v, { t: "closed" });
      /* Keep the session listed briefly after the agent drops so a viewer opening
       * the app right after a run still sees how it ended, rather than the
       * session vanishing the instant the process exits. */
      setTimeout(() => {
        sessions.delete(session.id);
        broadcastSessionList();
      }, 60_000);
      console.log(`[-] ${session.id} ${session.agent}`);
      broadcastSessionList();
    } else if (role === "viewer" && session) {
      session.viewers.delete(ws);
    }
  });
});

/* Phones drop connections constantly: screen lock, wifi to cellular, tunnels
 * timing out. Without a heartbeat the relay accumulates half-open sockets that
 * look alive and silently swallow output. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => console.log(`relay on ${HOST}:${PORT}`));
