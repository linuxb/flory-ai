// Renders architecture.html (the animation scene beside this script) into the two
// README hero images, doc/animations/architecture-dark.gif and -light.gif. A GIF
// cannot react to prefers-color-scheme, so the scene is drawn once per theme and
// the README picks between them with a <picture> element.
//
//   cd doc/animations/src && npm install     # puppeteer-core + gifenc, once
//   node doc/animations/src/render.mjs       # both themes
//   THEME=light node doc/animations/src/render.mjs
//
// The scene is deterministic: window.__render(t) draws the frame at loop phase
// t in [0, 1), so re-rendering an unchanged scene is byte-for-byte reproducible.
// Frames are diffed against their predecessor and unchanged pixels are written as
// the transparent index with disposal 1, which is what keeps a 1280x768, 96-frame
// loop compact. Override the browser with CHROME=..., the output directory with
// OUTDIR=..., and the loop shape with FRAMES=..., DELAY=... (1/100 s), COLORS=...
import puppeteer from 'puppeteer-core';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRAMES = Number(process.env.FRAMES || 96);
const DELAY  = Number(process.env.DELAY  || 8);      // 1/100 s per frame
const COLORS = Number(process.env.COLORS || 200);
const HERE   = path.dirname(new URL(import.meta.url).pathname);
const OUTDIR = process.env.OUTDIR || path.join(HERE, '..');
const SCENE  = 'file://' + path.join(HERE, 'architecture.html');
const THEMES = process.env.THEME ? [process.env.THEME] : ['dark', 'light'];

async function capture(page, theme) {
    await page.evaluate((name) => window.__setTheme(name), theme);
    const frames = [];
    for (let i = 0; i < FRAMES; i++) {
        const b64 = await page.evaluate((t) => {
            window.__render(t);
            return window.__pixels();
        }, i / FRAMES);
        frames.push(new Uint8Array(Buffer.from(b64, 'base64')));
        if (i % 12 === 0) process.stdout.write(`  ${theme}: captured ${i}/${FRAMES}\r`);
    }
    console.log(`  ${theme}: captured ${FRAMES}/${FRAMES}`);
    return frames;
}

// One palette for the whole loop, sampled across it, so colours never shift.
function buildPalette(frames, W, H) {
    const step = 3;
    const sampled = frames.filter((_, i) => i % 4 === 0);
    const sample = new Uint8Array(sampled.length * Math.floor((W * H) / step) * 4);
    let o = 0;
    for (const f of sampled) {
        for (let p = 0; p < W * H; p += step) {
            const q = p * 4;
            sample[o++] = f[q]; sample[o++] = f[q + 1]; sample[o++] = f[q + 2]; sample[o++] = 255;
        }
    }
    return quantize(sample.subarray(0, o), COLORS - 1, { format: 'rgb565', oneBitAlpha: false });
}

function encode(frames, palette, W, H, out) {
    const TI = palette.length;                       // transparent index
    const gif = GIFEncoder();
    let prev = null;
    for (let i = 0; i < frames.length; i++) {
        const idx = applyPalette(frames[i], palette, 'rgb565');
        let data = idx, transparent = false;
        if (prev) {                                  // only ship what actually moved
            data = new Uint8Array(idx.length);
            for (let p = 0; p < idx.length; p++) data[p] = idx[p] === prev[p] ? TI : idx[p];
            transparent = true;
        }
        gif.writeFrame(data, W, H, {
            palette: i === 0 ? palette.concat([[0, 0, 0]]) : undefined,
            delay: DELAY * 10,
            transparent,
            transparentIndex: TI,
            dispose: 1,
            first: i === 0,
            repeat: 0,
        });
        prev = idx;
    }
    gif.finish();
    fs.writeFileSync(out, Buffer.from(gif.bytes()));
    return fs.statSync(out).size;
}

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 800, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => { window.__noAuto = true; });
await page.goto(SCENE, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
const { W, H } = await page.evaluate(() => window.__size);
console.log(`scene ${W}x${H}, ${FRAMES} frames @ ${DELAY * 10}ms, themes: ${THEMES.join(', ')}`);

for (const theme of THEMES) {
    const frames = await capture(page, theme);
    const palette = buildPalette(frames, W, H);
    const out = path.join(OUTDIR, `architecture-${theme}.gif`);
    const bytes = encode(frames, palette, W, H, out);
    console.log(`  ${theme}: ${palette.length} colours -> ${out} ${(bytes / 1048576).toFixed(2)} MB`);
}
await browser.close();
