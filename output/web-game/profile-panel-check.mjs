import fs from "node:fs";
import { chromium } from "playwright";

const outDir = "output/web-game";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push({ type: "console.error", text: msg.text() });
});
page.on("pageerror", (err) => errors.push({ type: "pageerror", text: String(err) }));

await page.goto("http://localhost:3000/world.html", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);

const points = [
  { x: 640, y: 360 },
  { x: 620, y: 370 },
  { x: 670, y: 360 },
  { x: 600, y: 350 },
  { x: 700, y: 380 }
];

let opened = false;
for (const p of points) {
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
  opened = await page.evaluate(() => document.getElementById("profile-panel")?.classList.contains("visible") ?? false);
  if (opened) break;
}

if (!opened) {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  await page.mouse.click(Math.floor(viewport.width * 0.51), Math.floor(viewport.height * 0.56));
  await page.waitForTimeout(300);
  opened = await page.evaluate(() => document.getElementById("profile-panel")?.classList.contains("visible") ?? false);
}

await page.screenshot({ path: `${outDir}/profile-stats-panel.png`, fullPage: true });
const panelText = await page.evaluate(() => document.getElementById("profile-panel")?.innerText ?? "");
fs.writeFileSync(`${outDir}/profile-stats-panel.txt`, panelText, "utf-8");
fs.writeFileSync(`${outDir}/profile-stats-errors.json`, JSON.stringify(errors, null, 2), "utf-8");

await browser.close();
console.log(JSON.stringify({ opened, panelTextPreview: panelText.slice(0, 260), errors: errors.length }, null, 2));