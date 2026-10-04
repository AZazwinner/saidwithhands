// Visual check: screenshots of the main screen and the teach-a-sign flow at 390 and 1440 px, light and
// dark. Uses Chromium's fake camera (a test pattern, so the app shows its "no hand" state).
// Usage: npm run dev, then `node scripts/screenshots.mjs [baseUrl]`. Output: screenshots/ (gitignored).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const sizes = [
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "1440", viewport: { width: 1440, height: 900 } },
];
const schemes = ["light", "dark"];

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

async function startCamera(page) {
  await page.getByRole("button", { name: "Start camera" }).click();
  await page.getByText(/hand in view/i).first().waitFor({ timeout: 30000 });
}

for (const size of sizes) {
  for (const scheme of schemes) {
    const tag = `${size.name}-${scheme}`;
    const ctx = await browser.newContext({
      viewport: size.viewport,
      colorScheme: scheme,
      permissions: ["camera"],
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();

    // Main screen: camera off, then running (no hand), then a transcript filled with sample tokens.
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600); // hero entrance + first field frame
    await page.mouse.move(size.viewport.width * 0.4, size.viewport.height * 0.5);
    await page.mouse.move(size.viewport.width * 0.6, size.viewport.height * 0.35, { steps: 12 });
    await page.screenshot({ path: `${OUT}/hero-${tag}.png` });
    await page.evaluate(() => window.scrollTo({ top: 760, behavior: "instant" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/scrolled-nav-${tag}.png` });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: `${OUT}/main-off-${tag}.png`, fullPage: true });
    await startCamera(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/main-running-${tag}.png`, fullPage: true });

    // Mock (DOM only, for styling review): a filled transcript and a best guess, using the same classes.
    await page.evaluate(() => {
      const card = document.querySelector('section[aria-label="Transcript"]');
      const body = card.firstElementChild;
      const L = (v, cls = "") => `<button class="rounded-control px-0 ${cls}">${v}</button>`;
      body.querySelector("p").outerHTML =
        `<p class="mt-3 text-xl leading-tight break-words md:text-2xl md:leading-tight">` +
        L("M", "underline decoration-warning decoration-dotted decoration-2 underline-offset-8") +
        `<sub class="text-xs text-warning">/N</sub>` + L("Y") + `<span> </span>` +
        `<span class="mx-1 inline-block rounded-control bg-surface-2 px-2">MEDICATION</span><span> </span>` +
        L("P") + L("L", "text-accent") + L("E") + L("A", "bg-accent text-accent-fg") + L("S") + L("E") +
        `<span class="caret ml-1 inline-block h-[0.9em] w-px translate-y-[0.12em] bg-accent"></span></p>`;
      const guess = document.createElement("div");
      guess.className = "border-t border-border p-4 md:p-6";
      guess.innerHTML = `<section><div class="flex items-baseline justify-between gap-4"><h2 class="label">Best guess</h2><span class="text-xs text-muted tabular-nums">Gemini, 1.1 s</span></div>
        <p class="mt-2 min-h-8 text-xl leading-tight">My medication, <span class="underline decoration-accent decoration-dotted decoration-2 underline-offset-4">please</span>.</p>
        <p class="label mt-4">Recognized signs</p>
        <p class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-sm text-muted"><span class="text-accent">N→M</span><span>Y</span><span class="w-2"></span><span>MEDICATION</span><span class="w-2"></span><span>P</span><span class="text-warning">K→L*</span><span>E</span><span>A</span><span>S</span><span class="line-through">E</span></p>
        <p class="mt-3 flex items-center gap-2 text-xs text-muted">Spoken with the browser voice. ElevenLabs is unavailable.</p></section>`;
      card.insertBefore(guess, card.children[1]);
      document.querySelectorAll("button[disabled]").forEach((b) => b.textContent?.includes("Speak") && (b.disabled = false));
    });
    await page.screenshot({ path: `${OUT}/main-filled-mock-${tag}.png` });

    // Teach a sign: open the sheet, name it, start recording (countdown, then recording).
    await page.goto(`${BASE}/teach`);
    await page.waitForLoadState("networkidle");
    await startCamera(page);
    await page.getByRole("button", { name: "Teach a sign" }).click();
    await page.waitForTimeout(900); // smooth scroll on phones
    await page.screenshot({ path: `${OUT}/teach-1-name-${tag}.png` });
    await page.getByPlaceholder("e.g. my medication").fill("my medication");
    await page.getByRole("button", { name: "Start recording" }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/teach-2-countdown-${tag}.png` });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/teach-2-recording-${tag}.png` });

    await ctx.close();
    console.log("done", tag);
  }
}
await browser.close();
