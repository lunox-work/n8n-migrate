// Renders assets/mapping.gif from assets/src/mapping.html, frame by frame through its render(t).
// Needs Playwright and gifenc + pngjs, none installed here:
//   PLAYWRIGHT=<dir with node_modules/playwright> GIFDEPS=<dir with node_modules/{gifenc,pngjs}> \
//     [PW_CHANNEL=chrome] node assets/src/gif.mjs [--fps 50]
// One palette for the whole GIF; a pixel that did not change since the previous frame is written
// transparent (frames are kept, not disposed), and identical frames merge into one longer frame.
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"))("playwright");
const deps = createRequire(path.resolve(process.env.GIFDEPS ?? process.cwd(), "package.json"));
const { PNG } = deps("pngjs");
const gifenc = await import(pathToFileURL(deps.resolve("gifenc")).href);
const { GIFEncoder, quantize, applyPalette } = gifenc.quantize ? gifenc : gifenc.default;
const fps = Number(process.argv[process.argv.indexOf("--fps") + 1]) || 50;

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
await page.addInitScript(() => (window.__frames = true));
await page.goto(pathToFileURL(path.join(here, "mapping.html")).href);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);
const n = Math.round(duration * fps);
const width = 960;
const height = 540;
const grab = async (t) => {
  await page.evaluate((t) => window.render(t), t);
  const png = PNG.sync.read(await page.locator("#scene").screenshot());
  return new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
};

// Palette from a spread of frames; index 255 is kept free for transparency. Frames are then rendered and encoded
// one at a time, so a long loop never holds every raw frame in memory.
const step = Math.max(1, Math.floor(n / 32));
const sample = [];
for (let f = 0; f < n; f += step) sample.push(await grab(f / fps));
const joined = new Uint8Array(sample.reduce((a, f) => a + f.length, 0));
let o = 0;
for (const f of sample) joined.set(f, (o += f.length) - f.length);
const palette = quantize(joined, 255);
const T = palette.length;
palette.push([255, 0, 255]);

const gif = GIFEncoder();
let prev = null;
let pending = null;
const flush = () => pending && gif.writeFrame(pending.index, width, height, { palette: pending.first ? palette : undefined, delay: pending.delay, transparent: !pending.first, transparentIndex: T, dispose: 1 });
for (let f = 0; f < n; f++) {
  const idx = applyPalette(await grab(f / fps), palette.slice(0, T));
  if (prev && idx.every((v, i) => v === prev[i])) {
    pending.delay += 1000 / fps;
    continue;
  }
  flush();
  let out = idx;
  if (prev) {
    out = idx.slice();
    for (let i = 0; i < out.length; i++) if (out[i] === prev[i]) out[i] = T;
  }
  pending = { index: out, delay: 1000 / fps, first: !prev };
  prev = idx;
}
flush();
await browser.close();
gif.finish();
const file = path.join(root, "assets", "mapping.gif");
writeFileSync(file, gif.bytes());
console.log(`${path.relative(root, file)}: ${n} frames at ${fps} fps, ${(statSync(file).size / 1048576).toFixed(2)} MiB`);
