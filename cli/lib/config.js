import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".agentpanel");
const FILE = join(DIR, "config.json");

export function readConfig() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeConfig(cfg) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + "\n");
  /* This file holds the token that grants keystroke access to live agent
   * sessions. On a shared box, mode 600 is the difference between "my sessions"
   * and "anyone with a login can type into my agents". No-op on Windows, where
   * the user profile directory is already restricted. */
  try {
    chmodSync(FILE, 0o600);
  } catch {}
}

export const configPath = FILE;

/** Accepts what `apanel link` prints: a URL that may carry `#t=TOKEN`. */
export function parseLink(input, explicitToken) {
  const u = new URL(input);
  const raw = explicitToken || new URLSearchParams(u.hash.slice(1)).get("t");
  if (!raw) throw new Error("no token found. pass --token, or use the full link with #t=");

  /* Shells mangle tokens in ways that are invisible until auth fails later.
   * PowerShell captures multi-line command output as an array and joins it with
   * spaces; copy-paste picks up trailing newlines. Catch it here, where the fix
   * is obvious, rather than at "relay rejected the token" an hour later. */
  const token = raw.trim();
  if (!token) throw new Error("token is empty after trimming whitespace");
  if (/\s/.test(token)) {
    throw new Error(
      `token contains whitespace, so it was probably captured wrong.\n` +
        `got ${token.length} characters. expected one unbroken string.`
    );
  }

  const ws = (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host;
  return { url: u.origin, ws, token };
}
