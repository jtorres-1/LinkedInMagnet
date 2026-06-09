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
  "looking to hire a developer",
  "need someone to build",
  "need a full stack developer",
  "need an app built",
  "need a scraper built",
  "need AI integration",
  "need a bot built",
  "need MVP built",
];

const MAPZAP_QUERIES = [
  "need more leads",
  "struggling to find clients",
  "need more customers",
  "need business leads",
  "how to find clients",
  "lead generation problems",
  "need local business leads",
  "cold outreach help",
  "need a lead list",
  "finding new clients",
  "need more sales",
  "prospecting help",
  "need prospects",
  "client acquisition",
  "building a pipeline",
];

const DEVHIRE_COMMENTS = [
  `Python dev in LA available this week. built live production tools including a Google Maps SaaS and automation pipelines. 48hr delivery, flat fee. DM me a scope`,
  `available for freelance work right now. i build websites, scrapers, automation bots, and AI integrations. flat fee, 48 hour delivery. DM me what you need built`,
  `Python developer in LA here. shipped a live Google Maps lead scraper SaaS, cold email pipelines, and automation bots in production. 48hr turnaround, flat fee. DM me a scope`,
  `dev in LA available immediately. websites, scrapers, bots, AI integrations. flat fee only, 48 hour delivery. DM me what you need`,
  `Python and Node.js developer available this week. live production projects including a SaaS with Stripe payments and automation bots. flat fee, fast turnaround. DM me`,
];

const MAPZAP_COMMENTS = [
  `built something that might help — mapzap.org pulls 100 local business leads from Google Maps in 60 seconds as a CSV. $49/month unlimited searches, free preview available`,
  `this might solve it — mapzap.org scrapes 100 local businesses from Google Maps in 60 seconds. name, phone, address, website as a CSV. $49/month unlimited, free preview at mapzap.org`,
  `built a tool for exactly this — mapzap.org pulls 100 local business leads in 60 seconds. type a niche and city, get a CSV instantly. $49/month unlimited searches`,
  `mapzap.org might help here. pulls 100 local business leads from Google Maps in 60 seconds as a downloadable CSV. $49/month unlimited, free preview no card needed`,
  `built mapzap.org for this exact problem. type any business type and city, get 100 leads with names, phones, addresses, websites as a CSV in 60 seconds. $49/month unlimited`,
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
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(rand(3000, 5000));
  if (page.url().includes("login") || page.url().includes("authwall")) {
    throw new Error("Session expired. Run linkedin_login.cjs again.");
  }
  log("INFO", "Session loaded.");
}

async function searchPosts(page, query) {
  log("SEARCH", `Searching: "${query}"`);
  const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=date_posted`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(rand(3000, 5000));

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(rand(1500, 2500));
  }

  const posts = await page.evaluate(() => {
    const results = [];
    const postEls = Array.from(document.querySelectorAll('.feed-shared-update-v2, [data-urn*="activity"]'));

    for (const post of postEls) {
      // Get post text
      const textEl = post.querySelector('.feed-shared-text, .attributed-text-segment-list__content, [class*="commentary"]');
      if (!textEl) continue;
      const text = textEl.innerText?.toLowerCase() || '';
      if (!text || text.length < 20) continue;

      // Get post ID from data-urn
      const urn = post.getAttribute('data-urn') || post.closest('[data-urn]')?.getAttribute('data-urn') || '';
      const postId = urn.replace(/[^0-9]/g, '') || Math.random().toString(36).substr(2, 9);

      // Get author
      const authorEl = post.querySelector('.feed-shared-actor__name, .update-components-actor__name');
      const author = authorEl?.innerText?.trim() || 'unknown';

      // Find comment button
      const commentBtn = post.querySelector('[aria-label*="comment"], [data-control-name="comment"]');

      if (!postId) continue;

      results.push({ postId, author, text: text.substring(0, 200), hasCommentBtn: !!commentBtn });
    }

    return results;
  });

  log("SEARCH", `Found ${posts.length} posts for "${query}"`);
  return posts;
}

async function commentOnPost(page, post, commentText) {
  try {
    // Navigate to post directly if we have an ID
    await page.goto(`https://www.linkedin.com/feed/`, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(rand(2000, 3000));

    // Search again to find the post
    const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(post.searchQuery)}&sortBy=date_posted`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(rand(3000, 5000));

    // Find and click comment button on matching post
    const clicked = await page.evaluate((postId, authorName) => {
      const postEls = Array.from(document.querySelectorAll('.feed-shared-update-v2, [data-urn*="activity"]'));
      for (const post of postEls) {
        const urn = post.getAttribute('data-urn') || post.closest('[data-urn]')?.getAttribute('data-urn') || '';
        const id = urn.replace(/[^0-9]/g, '');
        const author = post.querySelector('.feed-shared-actor__name, .update-components-actor__name')?.innerText?.trim() || '';
        if (id === postId || author === authorName) {
          const commentBtn = post.querySelector('[aria-label*="comment"], [aria-label*="Comment"]');
          if (commentBtn) { commentBtn.click(); return true; }
        }
      }
      return false;
    }, post.postId, post.author);

    if (!clicked) {
      log("SKIP", `Could not find comment button for post by ${post.author}`);
      return "no_btn";
    }

    await sleep(rand(2000, 3000));

    // Type comment
    const editor = await page.evaluateHandle(() => {
      return document.querySelector('.ql-editor, [contenteditable="true"][role="textbox"], [data-placeholder*="comment"]') || null;
    });

    const editorEl = editor.asElement();
    if (!editorEl) {
      log("SKIP", `No comment editor found`);
      return "no_editor";
    }

    await editorEl.click();
    await sleep(rand(1000, 2000));
    await page.keyboard.type(commentText, { delay: rand(30, 60) });
    await sleep(rand(2000, 3000));

    // Submit comment
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const submitBtn = btns.find(b =>
        b.innerText?.trim().toLowerCase() === 'post' ||
        b.getAttribute('aria-label')?.toLowerCase().includes('post comment') ||
        b.className?.includes('comment-post')
      );
      if (submitBtn) { submitBtn.click(); return true; }
      return false;
    });

    if (!submitted) {
      log("ERROR", `Could not submit comment for post by ${post.author}`);
      return "no_submit";
    }

    await sleep(rand(3000, 5000));
    log("COMMENTED", `${post.author} — "${post.text.substring(0, 60)}..."`);
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

    // Shuffle to vary which queries we hit each cycle
    allQueries.sort(() => Math.random() - 0.5);

    for (const { query, type } of allQueries) {
      if (commentsThisCycle >= MAX_COMMENTS_PER_CYCLE) {
        log("INFO", `Hit max comments (${MAX_COMMENTS_PER_CYCLE}). Stopping.`);
        break;
      }

      const posts = await searchPosts(page, query);

      for (const post of posts) {
        if (commentsThisCycle >= MAX_COMMENTS_PER_CYCLE) break;
        if (commented[post.postId]) {
          log("SKIP", `Already commented on post by ${post.author}`);
          continue;
        }

        post.searchQuery = query;
        const commentText = type === "DEVHIRE" ? pick(DEVHIRE_COMMENTS) : pick(MAPZAP_COMMENTS);
        const result = await commentOnPost(page, post, commentText);

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
