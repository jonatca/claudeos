/**
 * QUICK-PROMPT FOCUS-TRAP UI E2E — drives the REAL renderer in a headless browser and proves the
 * Ctrl+G i overlay TRAPS keyboard focus: the overlay is a small centered box (not a full-screen
 * backdrop), so without the trap a click on a pane/queue row behind it steals focus and you can't
 * type back into the box. This reproduces that exact click and asserts focus stays put.
 *
 *   node dist/test/quick_prompt_ui.js
 */
import type { Browser, Page } from "playwright";
import { check, summary } from "./helpers";
import { startDemoServer, DemoServer, sleep } from "./e2e_boot";

// Bleeding-edge-Ubuntu shim (same as e2e_ui): set BEFORE requiring playwright.
if (!process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
  try {
    const rel = require("fs").readFileSync("/etc/os-release", "utf8");
    const id = (rel.match(/^ID=(.*)$/m) || [])[1]?.replace(/"/g, "");
    const ver = parseFloat(((rel.match(/^VERSION_ID=(.*)$/m) || [])[1] || "").replace(/"/g, ""));
    if (id === "ubuntu" && ver > 24.04) process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu24.04-x64";
  } catch {}
}
const { chromium } = require("playwright");

const activeId = (page: Page) => page.evaluate(() => (document.activeElement && (document.activeElement as HTMLElement).id) || "");
const qpValue = (page: Page) => page.evaluate(() => (document.getElementById("quickprompt-input") as HTMLTextAreaElement)?.value);
const selDataI = (page: Page) => page.evaluate(() => { const s = document.querySelector("#queue li.sel"); return s ? s.getAttribute("data-i") : null; });

// poll until a live xterm has mounted (the demo streams a real PTY into #term-host)
async function waitForTerm(page: Page, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await page.locator("#term-host .xterm").count()) > 0 && await page.evaluate(() => !!(window as any).cockpitTerm)) return true;
    await sleep(120);
  }
  return false;
}

async function openQuickPrompt(page: Page) {
  // focus pane A deterministically, then Ctrl+G then i.
  try { await page.locator("#pane-A-body").click({ position: { x: 8, y: 8 } }); } catch {}
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press("ArrowLeft");
  await sleep(120);
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press("i");
  await sleep(150);
}

async function run(page: Page) {
  console.log("\n== Quick-prompt focus trap (Ctrl+G i) ==");
  await page.waitForSelector("#queue li", { timeout: 15000 });
  await openQuickPrompt(page);

  check("overlay is visible after Ctrl+G i", await page.locator("#quickprompt-overlay").isVisible());
  check("textarea is focused on open", (await activeId(page)) === "quickprompt-input", "active=" + (await activeId(page)));

  await page.keyboard.type("hello from the quick prompt");
  const selBefore = await selDataI(page);

  // THE BUG REPRO: click a queue row behind the small overlay box.
  await page.locator("#queue li").nth(2).click({ force: true });
  await sleep(150);
  check("focus STAYS on the textarea after clicking a background row", (await activeId(page)) === "quickprompt-input", "active=" + (await activeId(page)));
  check("typed text is preserved after the background click", (await qpValue(page)) === "hello from the quick prompt");
  check("overlay still open after background click", await page.locator("#quickprompt-overlay").isVisible());
  check("background click did NOT change the queue selection (stopPropagation)", selBefore === (await selDataI(page)));

  // click directly on the other pane body too.
  await page.locator("#pane-B-body").click({ position: { x: 40, y: 40 }, force: true });
  await sleep(120);
  check("focus STAYS on the textarea after clicking pane B", (await activeId(page)) === "quickprompt-input", "active=" + (await activeId(page)));

  await page.keyboard.type("!");
  check("can keep typing after background clicks", (await qpValue(page)) === "hello from the quick prompt!");

  // Esc closes and RELEASES the trap.
  await page.keyboard.press("Escape");
  await sleep(120);
  check("Esc closes the overlay", !(await page.locator("#quickprompt-overlay").isVisible()));
  await page.locator("#queue li").nth(1).click({ force: true });
  await sleep(120);
  check("after close, background clicks work normally again (trap released)", (await activeId(page)) !== "quickprompt-input");

  // ── PRIORITY FIELD (Ctrl+Enter reveals it; plain Enter would send WITH it; no newline leaks) ──
  console.log("\n== Quick-prompt priority field (Ctrl+Enter) ==");
  const prioVal = (p: Page) => p.evaluate(() => (document.getElementById("quickprompt-prio") as HTMLInputElement)?.value);
  await openQuickPrompt(page);
  check("overlay re-opens for the priority test", await page.locator("#quickprompt-overlay").isVisible());
  check("priority row is hidden by default (importance = none)", !(await page.locator("#quickprompt-prio-row").isVisible()));
  await page.keyboard.type("do the thing");
  // Ctrl+Enter → reveal + jump to the priority field, WITHOUT inserting a newline in the textarea.
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await sleep(150);
  check("Ctrl+Enter reveals the priority row", await page.locator("#quickprompt-prio-row").isVisible());
  check("Ctrl+Enter moves focus to the priority field", (await activeId(page)) === "quickprompt-prio", "active=" + (await activeId(page)));
  check("Ctrl+Enter did NOT insert a newline into the prompt", (await qpValue(page)) === "do the thing");
  await page.keyboard.type("80");
  check("a number types into the priority field", (await prioVal(page)) === "80");
  // the focus pin must NOT yank focus back to the textarea while the prio field is the active sibling
  await page.evaluate(() => { const r = (window as any).cockpitRender; for (let i = 0; i < 6; i++) r && r(); });
  await sleep(60);
  check("focus STAYS on the priority field across render ticks (in-overlay sibling)", (await activeId(page)) === "quickprompt-prio", "active=" + (await activeId(page)));
  // re-opening the quick prompt resets the priority back to none (blank + hidden).
  await page.keyboard.press("Escape");
  await sleep(120);
  await openQuickPrompt(page);
  check("priority resets to none on re-open (row hidden again)", !(await page.locator("#quickprompt-prio-row").isVisible()));
  check("priority field value resets to blank on re-open", (await prioVal(page)) === "");
  await page.keyboard.press("Escape");
  await sleep(120);

  // ── RENDER-TICK FLICKER (FIX QP) ──────────────────────────────────────────────────────────
  // The other repro is a CLICK. This one is the background RENDER TICK: with a terminal pane
  // focused, every render() called applyKeyboardTarget() → term.focus(), yanking focus off the
  // open quick-prompt textarea. The blur handler refocused on setTimeout(0), so a keystroke in the
  // gap leaked into the terminal — "every ~Nth letter types into the terminal", paced by the tick.
  console.log("\n== Quick-prompt survives render ticks over a focused terminal (FIX QP) ==");
  // open a live terminal for the selected task and focus it
  await page.locator("#queue li").first().click({ force: true });
  await sleep(120);
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press("t"); // master t — open Terminal in the focused pane (bare keys are gated)
  const termUp = await waitForTerm(page);
  check("a terminal mounts for the regression case", termUp);
  await page.locator("#term-xterm").click(); // focus the terminal pane (keystrokes → PTY)
  await sleep(120);

  // open the quick prompt OVER the focused terminal — the exact user scenario
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press("i");
  await sleep(150);
  check("overlay opens over a focused terminal", await page.locator("#quickprompt-overlay").isVisible());
  check("textarea focused on open (over terminal)", (await activeId(page)) === "quickprompt-input", "active=" + (await activeId(page)));

  // Hammer the render path the way the background tick does, and check focus SYNCHRONOUSLY in the
  // SAME JS turn — before the textarea's blur handler heals it on setTimeout(0). That transient gap
  // is exactly where a real keystroke leaked into the terminal; the steady state always looks fine.
  const stolenDuringTick = await page.evaluate(() => {
    const r = (window as any).cockpitRender;
    const id = () => (document.activeElement && (document.activeElement as HTMLElement).id) || "";
    let stolen = false;
    for (let i = 0; i < 8; i++) { r && r(); if (id() !== "quickprompt-input") stolen = true; }
    return stolen;
  });
  check("render tick does NOT steal focus from the box (no flicker gap)", !stolenDuringTick);

  // steady state is also intact, and a keystroke lands in the box, not the terminal behind it.
  await sleep(60);
  check("focus STAYS on the textarea across render ticks (steady state)",
    (await activeId(page)) === "quickprompt-input", "active=" + (await activeId(page)));
  await page.keyboard.type("typed-after-tick");
  check("keystrokes after render ticks type into the box, not the terminal",
    (await qpValue(page)) === "typed-after-tick");

  await page.keyboard.press("Escape");
  await sleep(120);
  check("Esc closes the over-terminal overlay", !(await page.locator("#quickprompt-overlay").isVisible()));
}

(async () => {
  let browser: Browser | null = null;
  let SRV: DemoServer | null = null;
  let code = 2;
  try {
    SRV = await startDemoServer();
    console.log("demo server up:", SRV.base);
    browser = (await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-gl=swiftshader"] })) as Browser;
    const ctx = await browser!.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (e) => console.error("  [page error]", String(e).slice(0, 160)));
    await page.goto(SRV!.base, { waitUntil: "domcontentloaded" });
    await run(page);
    code = summary();
  } catch (e) {
    console.error("\nQUICK-PROMPT UI ERROR:", e);
    if (SRV) console.error("--- server log tail ---\n" + SRV.log().slice(-1200));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (SRV) await SRV.stop(); } catch {}
  }
  process.exit(code);
})();
