require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle2" });
  console.log("Log in manually then press Enter...");
  process.stdin.once("data", async () => {
    const cookies = await page.cookies();
    fs.writeFileSync("./session.json", JSON.stringify(cookies));
    console.log("Session saved.");
    await browser.close();
    process.exit(0);
  });
})();
