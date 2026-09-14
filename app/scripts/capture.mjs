// Capture a Tauri (WebView2) window via the Chrome DevTools Protocol.
// Usage: node scripts/capture.mjs [outFile] [pageLabel] [waitMs]
//   - Requires the app to be started with:
//       $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   - The screenshot is the raw webview content (no window frame, no desktop).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CDP_URL = process.env.WEBVIEW_CDP_URL ?? "http://127.0.0.1:9222";
const outDir = path.resolve(process.cwd(), "captures");
const args = process.argv.slice(2);
const outFile = path.resolve(outDir, args[0] ?? `capture-${Date.now()}.png`);
const label = (args[1] ?? "main").toLowerCase();
const waitMs = Number(args[2] ?? 1500);

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(CDP_URL);
const pages = browser.contexts().flatMap((c) => c.pages());
console.log("pages:");
for (const p of pages) console.log(`  [${p.title()}] ${p.url()}`);

const infos = await Promise.all(
  pages.map(async (p) => ({
    page: p,
    title: (await p.title()).toLowerCase(),
    url: p.url().toLowerCase(),
  })),
);
const found = infos.find((i) => i.title.includes(label) || i.url.includes(label));
const page = (found ?? infos[0]).page;
if (!page) throw new Error("no webview page found on " + CDP_URL);

await page.waitForTimeout(waitMs);
await page.screenshot({ path: outFile });
console.log("saved:", outFile);
await browser.close();
