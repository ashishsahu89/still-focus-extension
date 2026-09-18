import { chromium } from "playwright";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pageUrl = new URL(pathToFileURL(join(root, "intervention.html")));
pageUrl.searchParams.set("url", "https://www.youtube.com/");
pageUrl.searchParams.set("host", "youtube.com");
pageUrl.searchParams.set("label", "YouTube");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  });
  await page.goto(pageUrl.toString(), { waitUntil: "load" });
  await page.locator("#intention:not([disabled])").waitFor({ timeout: 12_000 });
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;transition:none!important}"
  });
  await page.screenshot({
    path: join(root, "assets/store-screenshot-intervention-1280x800.png"),
    type: "png"
  });
} finally {
  await browser.close();
}

console.log("Rendered assets/store-screenshot-intervention-1280x800.png (1280 × 800)");
