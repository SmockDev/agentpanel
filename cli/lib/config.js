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
  const token = explicitToken || new URLSearchParams(u.hash.slice(1)).get("t");
  if (!token) throw new Error("no token found. pass --token, or use the full link with #t=");
  const ws = (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host;
  return { url: u.origin, ws, token };
}
