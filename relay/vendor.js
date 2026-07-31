import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Copy xterm out of node_modules and into public/vendor so the viewer loads
 * everything from our own origin. A CDN would be one line shorter and put a third
 * party in the request path of a page that streams live terminal output, source
 * code and whatever secrets happen to be on screen included. It also means the
 * VPS only needs `ws` at runtime, not the whole xterm toolchain. */

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "public", "vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
];

for (const [from, to] of files) {
  copyFileSync(join(here, "node_modules", from), join(out, to));
  console.log("vendored", to);
}
