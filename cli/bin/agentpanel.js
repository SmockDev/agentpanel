#!/usr/bin/env node
// agentpanel
//
// `run` wraps an agent in a PTY, mirrors it to the local terminal, and (if this
// machine is linked) streams it to a relay so you can watch and steer from a
// phone. The relay is always optional: if it is unreachable the agent still runs
// exactly as it would without this tool.

import qrcode from "qrcode-terminal";
import { wrap } from "../lib/wrap.js";
import { connectRelay } from "../lib/relay.js";
import { readConfig, writeConfig, parseLink, configPath } from "../lib/config.js";

const VERSION = "0.2.0";
const SITE = "https://agentpanel.run";

const HELP = `
agentpanel ${VERSION}
See and steer all your coding agents from one place.

  apanel run -- <agent> [args]   wrap an agent, stream it if linked
  apanel link <url>              link this machine to a relay
  apanel status [--qr]           show link status, --qr for the phone link
  apanel --version               print version

Works by wrapping a terminal, so any agent counts: Claude Code, Codex,
Gemini CLI, whatever you switch to next.

  apanel run -- claude
  apanel run -- codex --model gpt-5.6
  apanel link https://agentpanel.run/#t=YOUR_TOKEN

${SITE}
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`;
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

async function run() {
  // Everything after `--` belongs to the agent, not to us. Without the separator
  // we would eat flags meant for it.
  const sep = argv.indexOf("--");
  const rest = sep === -1 ? argv.slice(1) : argv.slice(sep + 1);

  if (rest.length === 0) {
    console.error("nothing to run.\n\n  apanel run -- claude\n");
    process.exitCode = 1;
    return;
  }

  const [agent, ...agentArgs] = rest;
  const cfg = readConfig();
  const startedAt = Date.now();
  let bytes = 0;
  let idleReports = 0;
  let relay = null;
  let controls = null;

  if (cfg?.ws && cfg?.token) {
    relay = connectRelay({
      ws: cfg.ws,
      token: cfg.token,
      agent,
      cwd: process.cwd(),
      // Remote keystrokes go into the same PTY as local ones.
      onInput: (d) => controls?.write(d),
      onResize: (cols, rows) => controls?.resize(cols, rows),
      onStatus: ({ state }) => {
        // Only ever warn. Never interrupt the run.
        if (state === "denied") console.error("[agentpanel] relay rejected the token, running local only");
      },
    });
  }

  let code;
  try {
    code = await wrap(agent, agentArgs, {
      onStart: (c) => {
        controls = c;
      },
      onOutput: (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        relay?.send(chunk);
      },
      onIdle: () => {
        idleReports++;
        relay?.idle();
      },
    });
  } catch (err) {
    if (err.code === "ENOENT_AGENT") {
      console.error(`${err.message}. Is it installed and on your PATH?`);
      relay?.close();
      process.exitCode = 127; // conventional "command not found"
      return;
    }
    relay?.close();
    throw err;
  }

  relay?.exit(code);
  relay?.close();

  // Written to stderr so it never pollutes piped stdout from the agent.
  console.error(
    `\n[agentpanel] ${agent} exited ${code} after ${fmtDuration(Date.now() - startedAt)}, ` +
      `${fmtBytes(bytes)} captured${idleReports ? `, went quiet ${idleReports}x` : ""}`
  );
  process.exitCode = code;
}

async function link() {
  const url = argv.find((a, i) => i > 0 && !a.startsWith("-") && argv[i - 1] !== "--token");
  if (!url) {
    console.error("usage: apanel link https://your-relay/#t=TOKEN [--token TOKEN]");
    process.exitCode = 1;
    return;
  }

  let cfg;
  try {
    cfg = parseLink(url, flag("--token"));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }

  /* Check it answers before saving, so a typo surfaces now rather than silently
   * doing nothing the next time an agent is run. A first TLS handshake from a
   * cold start can be slow, so this is generous, and `fetch` hides the real
   * reason in `cause` where an unwrapped message just says "fetch failed". */
  if (!argv.includes("--force")) {
    try {
      const res = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
    } catch (e) {
      const why = e.cause?.code || e.cause?.message || e.message;
      console.error(`could not reach ${cfg.url}\nreason: ${why}`);
      console.error(`\nif the relay is fine and this is your network, link anyway:\n  apanel link <url> --force`);
      process.exitCode = 1;
      return;
    }
  }

  writeConfig(cfg);
  console.log(`linked to ${cfg.url}`);
  // Length only. Enough to spot a truncated or empty capture, without printing
  // the credential itself into a terminal or a screenshot.
  console.log(`token: ${cfg.token.length} characters`);
  console.log(`saved to ${configPath}\n`);
  showViewerLink(cfg);
  console.log(`\nnow run:\n  apanel run -- claude`);
}

/* Getting the viewer open on a phone is the one step that has to happen on a
 * different device, and the token is far too long to retype. A QR code turns
 * that into pointing a camera at the terminal. */
function showViewerLink(cfg) {
  const link = `${cfg.url}/#t=${cfg.token}`;
  console.log("open on your phone:");
  qrcode.generate(link, { small: true });
  console.log(link);
}

async function status() {
  const cfg = readConfig();
  if (!cfg) {
    console.log(`not linked.\n\n  apanel link ${SITE}/#t=YOUR_TOKEN`);
    return;
  }
  process.stdout.write(`linked to ${cfg.url} ... `);
  try {
    const res = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    console.log(`up, ${body.sessions} session${body.sessions === 1 ? "" : "s"} running`);
  } catch (e) {
    console.log(`unreachable (${e.message})`);
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--qr")) {
    console.log();
    showViewerLink(cfg);
  } else {
    console.log(`\nrun \`apanel status --qr\` for the phone link`);
  }
}

switch (cmd) {
  case "-v":
  case "--version":
    console.log(VERSION);
    break;

  case "run":
    await run();
    break;

  case "link":
    await link();
    break;

  case "status":
    await status();
    break;

  case undefined:
  case "-h":
  case "--help":
  case "help":
    console.log(HELP);
    break;

  default:
    console.log(`unknown command: ${cmd}\ntry \`apanel --help\``);
    process.exitCode = 1;
}

// node-pty holds the event loop open after the child is gone, so say so explicitly.
process.exit(process.exitCode ?? 0);
