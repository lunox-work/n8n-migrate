// Renders the README hero (assets/hero.png, from index.html at 2x) and the plugin icon
// (.claude-plugin/icon.png, 1024 px, from assets/icon.svg). Needs Playwright, not installed here:
//   PLAYWRIGHT=<dir containing node_modules/playwright> node assets/src/render.mjs [hero|icon]
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const require = createRequire(path.resolve(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
const { chromium } = require("playwright");
const only = process.argv[2];

const browser = await chromium.launch();
try {
  if (!only || only === "hero") {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(path.join(here, "index.html")).href);
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#hero").screenshot({ path: path.join(root, "assets", "hero.png") });
    await page.close();
  }
  if (!only || only === "icon") {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(root, "assets", "icon.svg")).href);
    await page.screenshot({ path: path.join(root, ".claude-plugin", "icon.png"), clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    await page.close();
  }
} finally {
  await browser.close();
}
