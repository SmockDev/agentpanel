import WebSocket from "ws";
import { hostname } from "node:os";

/* The relay connection is strictly optional and must stay that way.
 *
 * If the relay is down, unreachable, slow, or rejects the token, `apanel run`
 * still has to behave exactly like running the agent directly. Losing remote
 * visibility is an inconvenience; killing someone's live coding session because
 * a VPS rebooted is the kind of thing that gets a tool uninstalled and never
 * reinstalled. So every failure path here is swallowed on purpose, and nothing
 * in this file is ever awaited by the code that runs the agent.
 */

const MAX_QUEUE = 256 * 1024; // bytes held while the socket is still connecting

export function connectRelay({ ws: wsUrl, token, agent, cwd, onInput, onStatus = () => {} }) {
  let sock = null;
  let open = false;
  let closed = false;
  let queue = [];
  let queued = 0;
  let retry = 0;
  let sessionId = null;
  // The terminal reports its size the moment it starts, which is normally before
  // the socket finishes connecting. Hold the latest and send it on open.
  let dims = null;

  const dial = () => {
    if (closed) return;
    let s;
    try {
      s = new WebSocket(wsUrl);
    } catch {
      return schedule();
    }
    sock = s;

    s.on("open", () => {
      open = true;
      retry = 0;
      s.send(JSON.stringify({ t: "hello", role: "agent", token, agent, cwd, host: hostname() }));
      if (dims) s.send(JSON.stringify({ t: "dims", ...dims }));
      for (const chunk of queue) s.send(JSON.stringify({ t: "out", d: chunk }));
      queue = [];
      queued = 0;
    });

    s.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.t === "ready") {
        sessionId = m.id;
        onStatus({ state: "live", id: sessionId });
      } else if (m.t === "denied") {
        closed = true; // a bad token will not fix itself by retrying
        onStatus({ state: "denied" });
        try { s.close(); } catch {}
      } else if (m.t === "in" && typeof m.d === "string") {
        onInput?.(m.d);
      }
    });

    s.on("close", () => {
      open = false;
      if (!closed) { onStatus({ state: "offline" }); schedule(); }
    });
    // Without a handler, an ECONNREFUSED from ws throws on the process and takes
    // the agent down with it. That is the exact failure this file exists to avoid.
    s.on("error", () => {});
  };

  const schedule = () => {
    if (closed) return;
    const wait = Math.min(30_000, 1000 * 2 ** retry++); // back off, do not hammer
    setTimeout(dial, wait).unref?.();
  };

  dial();

  return {
    get id() { return sessionId; },
    send(chunk) {
      if (closed) return;
      if (open) {
        try { sock.send(JSON.stringify({ t: "out", d: chunk })); } catch {}
        return;
      }
      /* Hold a bounded amount while connecting so a viewer joining right after
       * startup still sees the beginning. Drop the oldest past the cap rather
       * than growing without limit. */
      queue.push(chunk);
      queued += chunk.length;
      while (queued > MAX_QUEUE && queue.length > 1) queued -= queue.shift().length;
    },
    idle() {
      if (open) try { sock.send(JSON.stringify({ t: "idle" })); } catch {}
    },
    dims(cols, rows) {
      dims = { cols, rows };
      if (open) try { sock.send(JSON.stringify({ t: "dims", cols, rows })); } catch {}
    },
    exit(code) {
      if (open) try { sock.send(JSON.stringify({ t: "exit", code })); } catch {}
    },
    close() {
      closed = true;
      try { sock?.close(); } catch {}
    },
  };
}
