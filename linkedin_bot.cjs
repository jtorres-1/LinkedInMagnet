require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");

const SESSION_PATH = "./session.json";
const COMMENTED_PATH = "./commented.json";
const LOG_PATH = "./linkedin_bot.log";

const MAX_COMMENTS_PER_CYCLE = 10;
const MIN_DELAY_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 9 * 60 * 1000;
const CYCLE_INTERVAL_MS = 60 * 60 * 1000;

const DEVHIRE_QUERIES = [
  "looking for a developer",
  "need a Python developer",
  "need a web developer",
  "need automation built",
  "need a website built",
  "hiring a developer",
  "need a freelance developer",
  "need someone to build",
  "need an app built",
  "need a bot built",
  "need MVP built",
  "need AI integration",
];

const MAPZAP_QUERIES = [
  "need more leads",
  "struggling to find clients",
  "need more customers",
  "need business leads",
  "how to find clients",
  "need local business leads",
  "cold outreach help",
  "need a lead list",
  "client acquisition",
  "building a pipeline",
  "need more sales",
  "prospecting help",
];

const DEVHIRE_COMMENTS = [
  `Python dev in LA available this week. built live production tools including a Google Maps SaaS and automation pipelines. 48hr delivery, flat fee. DM me a scope`,
  `available for freelance work right now. i build websites, scrapers, automation bots, and AI integrations. flat fee, 48 hour delivery. DM me what you need built`,
  `Python developer in LA here. shipped a live Google Maps lead scraper SaaS, cold email pipelines, and automation bots in production. 48hr turnaround, flat fee. DM me`,
  `dev in LA available immediately. websites, scrapers, bots, AI integrations. flat fee only, 48 hour delivery. DM me what you need`,
];

const MAPZAP_COMMENTS = [
  `built something that might help — mapzap.org pulls 100 local business leads from Google Maps in 60 seconds as a CSV. $49/month unlimited searches, free preview available`,
  `this might solve it — mapzap.org scrapes 100 local businesses from Google Maps in 60 seconds. name, phone, address, website as a CSV. $49/month unlimited, free preview at mapzap.org`,
  `built a tool for exactly this — mapzap.org pulls 100 local business leads in 60 seconds. type a niche and city, get a CSV instantly. $49/month unlimited searches`,
  `mapzap.org might help here. pulls 100 local business leads from Google Maps in 60 seconds as a downloadable CSV. $49/month unlimited, free preview no card needed`,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function log(tag, msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${tag}: ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function loadCommented() {
  if (!fs.existsSync(COMMENTED_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(COMMENTED_PATH)); } catch { return {}; }
}

function saveCommented(commented) {
  fs.writeFileSync(COMMENTED_PATH, JSON.stringify(commented, null, 2));
}

async function loadSession(page) {
  if (!fs.existsSync(SESSION_PATH)) throw new Error("No session. Run linkedin_login.cjs first.");
  const cookies = JSON.parse(fs.readFileSync(SESSION_PATH));
  await page.setCookie(...cookies);
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(rand(3000, 5000));
  if (page.url().includes("login") || page.url().includes("authwall")) {
    throw new Error("Session expired. Run linkedin_login.cjs again.");
  }
  log("INFO", "Session loaded.");
}

async function searchAndComment(page, query, type, commented) {
  log("SEARCH", `Searching: "${query}" [${type}]`);

  try {
    // Navigate to LinkedIn search for posts
    await page.goto(`https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=date_posted`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await sleep(rand(4000, 6000));

    // Scroll to load posts
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await sleep(rand(1500, 2500));
    }

    // Get all post containers
    const postCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-urn*="activity"], .search-results__list > li').length;
    });
    log("SEARCH", `Found ${postCount} posts for "${query}"`);

    // Process each post
    const posts = await page.evaluate(() => {
      const results = [];
      const containers = Array.from(document.querySelectorAll('[data-urn*="activity"]'));
      for (const container of containers) {
        const urn = container.getAttribute('data-urn') || '';
        const postId = urn.replace(/[^0-9]/g, '').slice(-10);
        if (!postId) continue;

        // Get text
        const textEl = container.querySelector(
          '.feed-shared-text span[dir="ltr"], .attributed-text-segment-list__content, .feed-shared-inline-show-more-text'
        );
        const text = textEl?.innerText?.toLowerCase() || '';
        if (!text || text.length < 20) continue;

        // Get author
        const authorEl = container.querySelector('.feed-shared-actor__name, .update-components-actor__name span[aria-hidden="true"]');
        const author = authorEl?.innerText?.trim() || 'unknown';

        // Check for comment button
        const commentBtn = container.querySelector('[aria-label*="omment"], [data-control-name*="comment"]');

        results.push({ postId, author, text: text.substring(0, 150), hasBtn: !!commentBtn });
      }
      return results;
    });

    return posts;
  } catch (err) {
    log("ERROR", `Search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function commentOnPost(page, query, post, commentText) {
  try {
    // Re-search to find the post fresh
    await page.goto(`https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=date_posted`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await sleep(rand(3000, 5000));

    // Scroll to load
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await sleep(rand(1000, 2000));
    }

    // Find and click comment button on matching post
    const commentBtnHandle = await page.evaluateHandle((postId, author) => {
      const containers = Array.from(document.querySelectorAll('[data-urn*="activity"]'));
      for (const container of containers) {
        const urn = container.getAttribute('data-urn') || '';
        const id = urn.replace(/[^0-9]/g, '').slice(-10);
        const authorEl = container.querySelector('.feed-shared-actor__name, .update-components-actor__name span[aria-hidden="true"]');
        const containerAuthor = authorEl?.innerText?.trim() || '';

        if (id === postId || containerAuthor === author) {
          // Find comment button
          const btns = Array.from(container.querySelectorAll('button'));
          const commentBtn = btns.find(b =>
            b.getAttribute('aria-label')?.toLowerCase().includes('comment') ||
            b.innerText?.toLowerCase().trim() === 'comment'
          );
          if (commentBtn) return commentBtn;
        }
      }
      return null;
    }, post.postId, post.author);

    const commentBtn = commentBtnHandle.asElement();
    if (!commentBtn) {
      log("SKIP", `No comment button found for post by ${post.author}`);
      return "no_btn";
    }

    await commentBtn.click();
    await sleep(rand(2000, 3000));

    // Find the comment text area that appeared
    const editorHandle = await page.evaluateHandle(() => {
      return document.querySelector('.ql-editor[contenteditable="true"]') ||
             document.querySelector('[contenteditable="true"][data-placeholder*="omment"]') ||
             document.querySelector('[contenteditable="true"][role="textbox"]') ||
             null;
    });

    const editor = editorHandle.asElement();
    if (!editor) {
      log("SKIP", `No comment editor found for post by ${post.author}`);
      return "no_editor";
    }

    await editor.click();
    await sleep(rand(1000, 1500));
    await page.keyboard.type(commentText, { delay: rand(30, 60) });
    await sleep(rand(2000, 3000));

    // Click post/submit button
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const submitBtn = btns.find(b =>
        b.innerText?.trim().toLowerCase() === 'post' ||
        b.getAttribute('aria-label')?.toLowerCase().includes('post comment') ||
        (b.className?.includes('comment') && b.innerText?.trim().toLowerCase() === 'post')
      );
      if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return true; }
      return false;
    });

    if (!submitted) {
      // Try pressing Enter as fallback
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await sleep(rand(2000, 3000));
      log("INFO", `Used Ctrl+Enter fallback for ${post.author}`);
    }

    await sleep(rand(3000, 5000));
    log("COMMENTED", `@${post.author} — "${post.text.substring(0, 60)}..."`);
    return "commented";

  } catch (err) {
    log("ERROR", `Comment failed for ${post.author}: ${err.message}`);
    return "error";
  }
}

async function runCycle() {
  const commented = loadCommented();
  let commentsThisCycle = 0;

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    await loadSession(page);

    const allQueries = [
      ...DEVHIRE_QUERIES.map(q => ({ query: q, type: "DEVHIRE" })),
      ...MAPZAP_QUERIES.map(q => ({ query: q, type: "MAPZAP" })),
    ];

    // Shuffle queries each cycle
    allQueries.sort(() => Math.random() - 0.5);

    for (const { query, type } of allQueries) {
      if (commentsThisCycle >= MAX_COMMENTS_PER_CYCLE) {
        log("INFO", `Hit max comments (${MAX_COMMENTS_PER_CYCLE}). Stopping.`);
        break;
      }

      const posts = await searchAndComment(page, query, type, commented);

      for (const post of posts) {
        if (commentsThisCycle >= MAX_COMMENTS_PER_CYCLE) break;
        if (commented[post.postId]) {
          log("SKIP", `Already commented on post by ${post.author}`);
          continue;
        }

        const commentText = type === "DEVHIRE" ? pick(DEVHIRE_COMMENTS) : pick(MAPZAP_COMMENTS);
        const result = await commentOnPost(page, query, post, commentText);

        if (result === "commented") {
          commented[post.postId] = new Date().toISOString();
          saveCommented(commented);
          commentsThisCycle++;
          log("INFO", `${commentsThisCycle}/${MAX_COMMENTS_PER_CYCLE} comments this cycle. Waiting ${Math.round(MIN_DELAY_MS / 60000)} to ${Math.round(MAX_DELAY_MS / 60000)}min...`);
          await sleep(rand(MIN_DELAY_MS, MAX_DELAY_MS));
        }

        await sleep(rand(3000, 6000));
      }

      await sleep(rand(5000, 10000));
    }

  } catch (err) {
    log("ERROR", `Cycle failed: ${err.message}`);
  }

  await browser.close();
  log("INFO", `Cycle complete. Commented on ${commentsThisCycle} posts.`);
}

(async () => {
  console.log("=".repeat(60));
  console.log("LinkedInMagnet -- Post Comment Bot");
  console.log("=".repeat(60));

  while (true) {
    await runCycle();
    log("INFO", `Next cycle in ${Math.round(CYCLE_INTERVAL_MS / 60000)} minutes.`);
    await sleep(CYCLE_INTERVAL_MS);
  }
})();
