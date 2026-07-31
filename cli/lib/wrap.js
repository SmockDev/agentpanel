import { spawn } from "@lydell/node-pty";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

/* Wrap any terminal program in a pseudo-terminal so that:
 *
 *   1. it still behaves exactly as if you ran it directly (colours, spinners,
 *      interactive prompts, raw keystrokes), and
 *   2. we get a copy of everything it prints.
 *
 * The PTY is what makes this tool-agnostic. Agents check isatty() and degrade to
 * plain non-interactive output when they see a pipe, so piping would change the
 * behaviour of the thing we are supposed to be transparently observing. A PTY
 * means Claude Code, Codex, Gemini and whatever ships next all work with no
 * integration on their side.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/* ConPTY announces itself on every new pseudo-console with a fixed preamble, and
 * one of those codes is \x1b[2J: erase display. Passing it through would wipe the
 * user's scrollback every single time they wrapped an agent. It is Windows
 * setting up its console, not the agent talking, so it does not belong in either
 * the local terminal or the captured stream. */
const CONPTY_PREAMBLE = /^(?:\x1b\[\?(?:9001|1004)h|\x1b\[\?25l|\x1b\[2J|\x1b\[m|\x1b\[H)+/;

/* ConPTY does NOT do PATHEXT resolution, unlike CreateProcess or a shell. Bare
 * "npm" spawns something that exits 2 with no output; bare "claude" throws
 * outright. Since agents are almost always installed as .cmd shims by npm, the
 * tool would be broken on Windows for every real agent without this. Resolving
 * here (rather than shelling out through cmd.exe) also avoids an extra process
 * and keeps argv intact, which matters when agent flags contain quotes. */
export function resolveExecutable(cmd) {
  if (process.platform !== "win32") return cmd; // execvp handles lookup
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd) ? cmd : null;

  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);

  /* Extensions BEFORE the bare name. Node ships both `npm` (a bash script with no
   * extension) and `npm.cmd` in the same directory; Windows cannot execute the
   * former, and trying it first gets you a silent exit 193. Users who type an
   * explicit "foo.exe" are still fine, since the bare pass catches it last. */
  for (const dir of dirs) {
    for (const ext of [...exts, ""]) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {string}   cmd   program to run, e.g. "claude"
 * @param {string[]} args  its arguments
 * @param {object}   handlers
 * @param {(chunk:string)=>void}         handlers.onOutput  every chunk the child prints
 * @param {(info:{idleMs:number})=>void} [handlers.onIdle]  fired when output stops
 * @param {number}                       [handlers.idleAfterMs=4000]
 * @returns {Promise<number>} the child's exit code
 */
export function wrap(cmd, args, handlers = {}) {
  const { onOutput = () => {}, onIdle, idleAfterMs = 4000 } = handlers;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = Boolean(stdin.isTTY);

  const file = resolveExecutable(cmd);
  if (!file) {
    const err = new Error(`could not find \`${cmd}\` on PATH`);
    err.code = "ENOENT_AGENT";
    return Promise.reject(err);
  }

  const child = spawn(file, args, {
    name: process.env.TERM || "xterm-256color",
    cols: stdout.columns || DEFAULT_COLS,
    rows: stdout.rows || DEFAULT_ROWS,
    cwd: process.cwd(),
    env: process.env,
  });

  /* Hand out a writer so something other than the local keyboard can drive the
   * agent. This is what makes the product "steer" rather than just "watch": a
   * keystroke arriving from a phone goes down the same pipe as one typed here,
   * and the agent cannot tell the difference. */
  handlers.onStart?.({
    write: (data) => {
      try { child.write(data); } catch {}
    },
    resize: (cols, rows) => {
      try { child.resize(cols, rows); } catch {}
    },
  });

  /* Idle detection is the seed of the feature that makes this a product rather
   * than a remote terminal: knowing which of your sessions is sitting there
   * waiting for a human. A silence timer is a crude first approximation. It will
   * need to get smarter, since a real prompt usually ends without a newline, but
   * it is enough to prove the signal exists. */
  let idleTimer = null;
  let lastOutputAt = Date.now();
  const armIdle = () => {
    if (!onIdle) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => onIdle({ idleMs: Date.now() - lastOutputAt }), idleAfterMs);
  };

  /* ConPTY does not deliver the preamble as one chunk. In practice the mode-set
   * codes arrive first and the screen clear lands in a later read, so stripping
   * only chunk one leaves the \x1b[2J intact. Stay in stripping mode until a
   * chunk carries something that is not preamble, then never look again: the same
   * codes are legitimate once the agent is actually drawing. */
  let inPreamble = process.platform === "win32";
  child.onData((chunk) => {
    if (inPreamble) {
      chunk = chunk.replace(CONPTY_PREAMBLE, "");
      if (!chunk) return; // pure preamble, nothing of the agent's in it yet
      inPreamble = false;
    }
    lastOutputAt = Date.now();
    stdout.write(chunk); // transparent passthrough: the local terminal is unchanged
    onOutput(chunk); // our copy
    armIdle();
  });

  // Keystrokes straight through. Raw mode means Ctrl-C, arrow keys and any TUI
  // the agent draws reach the child untouched instead of being handled by us.
  let onStdin = null;
  if (interactive) {
    stdin.setRawMode(true);
    stdin.resume();
    onStdin = (data) => child.write(data.toString("utf8"));
    stdin.on("data", onStdin);
  }

  /* Keep the child's idea of the window in sync, or TUIs wrap at the wrong
   * column. The local terminal is the only thing allowed to set this size: a
   * viewer on a phone must never reshape the terminal someone is working in. */
  const onResize = () => {
    const cols = stdout.columns || DEFAULT_COLS;
    const rows = stdout.rows || DEFAULT_ROWS;
    try {
      child.resize(cols, rows);
    } catch {
      /* child already gone */
    }
    handlers.onDims?.(cols, rows);
  };
  stdout.on("resize", onResize);
  handlers.onDims?.(stdout.columns || DEFAULT_COLS, stdout.rows || DEFAULT_ROWS);

  /* Restoring the terminal is not optional. Leaving stdin in raw mode means the
   * user's shell stops echoing what they type, which reads as "this tool broke my
   * terminal". This has to run on every exit path, including a crash. */
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearTimeout(idleTimer);
    stdout.off("resize", onResize);
    if (interactive) {
      if (onStdin) stdin.off("data", onStdin);
      try {
        stdin.setRawMode(false);
      } catch {}
      stdin.pause();
    }
  };
  process.on("exit", restore);

  return new Promise((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      restore();
      try {
        child.kill();
      } catch {}
      resolve(signal ? 128 + signal : exitCode);
    });
  });
}
