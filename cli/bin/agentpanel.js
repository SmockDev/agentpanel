#!/usr/bin/env node
// agentpanel
//
// Today `run` wraps an agent in a PTY and mirrors it transparently while keeping
// a copy of the output. The relay and the phone UI plug into that copy next.

import { wrap } from "../lib/wrap.js";

const VERSION = "0.1.0";
const SITE = "https://agentpanel.run";

const HELP = `
agentpanel ${VERSION}
See and steer all your coding agents from one place.

  apanel run -- <agent> [args]   wrap an agent and capture its session
  apanel link                    register this machine                (not built)
  apanel status                  list lines on this machine           (not built)
  apanel --version               print version

Works by wrapping a terminal, so any agent counts: Claude Code, Codex,
Gemini CLI, whatever you switch to next.

  apanel run -- claude
  apanel run -- codex --model gpt-5.6

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
  const startedAt = Date.now();
  let bytes = 0;
  let idleReports = 0;

  let code;
  try {
    code = await wrap(agent, agentArgs, {
      onOutput: (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
      },
      onIdle: () => {
        idleReports++;
      },
    });
  } catch (err) {
    if (err.code === "ENOENT_AGENT") {
      console.error(`${err.message}. Is it installed and on your PATH?`);
      process.exitCode = 127; // conventional "command not found"
      return;
    }
    throw err;
  }

  // Written to stderr so it never pollutes piped stdout from the agent.
  console.error(
    `\n[agentpanel] ${agent} exited ${code} after ${fmtDuration(Date.now() - startedAt)}, ` +
      `${fmtBytes(bytes)} captured${idleReports ? `, went quiet ${idleReports}x` : ""}`
  );
  process.exitCode = code;
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
  case "status":
    console.log(`agentpanel ${VERSION}: \`${cmd}\` is not built yet.\n${SITE}`);
    process.exitCode = 1;
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
