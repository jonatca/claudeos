// Copy renderer static assets (html, css) into dist after tsc.
const fs = require("fs");
const path = require("path");
const src = path.resolve(__dirname, "../src/renderer");
const dst = path.resolve(__dirname, "../dist/renderer");
fs.mkdirSync(dst, { recursive: true });
for (const f of ["index.html", "styles.css", "logo.png"]) {
  if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log("copied renderer assets -> dist/renderer");

// vendor: bundle xterm.js locally (no CDN) for the real-terminal view.
const vendorDst = path.join(dst, "vendor");
fs.mkdirSync(vendorDst, { recursive: true });
const vendorFiles = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-webgl/lib/addon-webgl.js", "addon-webgl.js"], // P4: GPU-fast renderer
  ["@xterm/addon-clipboard/lib/addon-clipboard.js", "addon-clipboard.js"], // OSC-52 clipboard -> operator clipboard
  // diff2html (GitHub-style split diff) + highlight.js theme — bundled locally, no CDN.
  ["diff2html/bundles/js/diff2html-ui.min.js", "diff2html-ui.min.js"],
  ["diff2html/bundles/css/diff2html.min.css", "diff2html.min.css"],
  ["highlight.js/styles/github-dark.min.css", "github-dark.min.css"],
];
for (const [rel, out] of vendorFiles) {
  const f = path.resolve(__dirname, "../node_modules", rel);
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(vendorDst, out));
  else console.warn("WARN: vendor file missing:", rel);
}
console.log("copied xterm vendor -> dist/renderer/vendor");

// web shim (plain JS, not compiled by tsc) -> dist/server
const wsrc = path.resolve(__dirname, "../src/server/webapi.js");
const wdst = path.resolve(__dirname, "../dist/server");
fs.mkdirSync(wdst, { recursive: true });
if (fs.existsSync(wsrc)) {
  fs.copyFileSync(wsrc, path.join(wdst, "webapi.js"));
  console.log("copied webapi.js -> dist/server");
}
