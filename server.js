// index.js
// Local Playwright render server for testing
// Usage: GET /render?url=<ENCODED_URL>&raw=true|false
// npm i express playwright

import express from "express";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "3", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "30000", 10); // ms
const GOTO_WAIT = process.env.GOTO_WAIT || "networkidle"; // 'networkidle' or 'load'

const app = express();

// Simple semaphore for concurrency control
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENCY) {
      active++;
      return resolve();
    }
    queue.push(resolve);
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) {
    active++;
    next();
  }
}

let browser;

async function startBrowser() {
  console.log("Launching chromium...");
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  console.log("Chromium launched.");
}

async function stopBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("Chromium closed.");
    } catch (e) {
      console.warn("Error closing browser:", e.message || e);
    }
  }
}

// Helper: normalize and validate target URL
function normalizeUrl(raw) {
  if (!raw) return null;
  try {
    // if path-style passed like /https://example.com/..., remove leading slash
    let u = raw.trim();
    if (u.startsWith("/http://") || u.startsWith("/https://")) u = u.replace(/^\/+/, "");
    // add protocol if missing? we expect full URL
    const parsed = new URL(u);
    return parsed.toString();
  } catch (err) {
    return null;
  }
}

// Render endpoint
app.get("/render", async (req, res) => {
  const rawUrl = req.query.url;
  const rawFlag = req.query.raw === "true";
  const target = normalizeUrl(rawUrl);

  if (!target) {
    return res.status(400).json({ error: "Missing or invalid 'url' query param. Use full URL: ?url=https://example.com" });
  }

  // Acquire slot
  await acquire();
  let page;
  try {
    // Create context & page
    const context = await browser.newContext({
      userAgent: req.headers["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      locale: "tr-TR",
      // optionally emulate viewport / device if needed
    });

    page = await context.newPage();

    // optional headers
    await page.setExtraHTTPHeaders({
      "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      "referer": req.headers.referer || "https://www.google.com/"
    });

    // navigate
    const response = await page.goto(target, {
      waitUntil: GOTO_WAIT,
      timeout: NAV_TIMEOUT
    });

    if (!response) {
      // e.g. navigation failed
      res.status(502).send("No response from target (navigation failed).");
      await page.close();
      await context.close();
      return;
    }

    const status = response.status();

    // If binary/resource and user asked for raw, return buffer
    const contentType = (response.headers()["content-type"] || "").toLowerCase();

    if (rawFlag) {
      // get response body of main resource (may be null)
      try {
        const ab = await response.body();
        if (ab) {
          // send as octet-stream with original content-type when available
          res.setHeader("Content-Type", contentType || "application/octet-stream");
          res.status(status).send(Buffer.from(ab));
        } else {
          res.status(204).send("No body from target resource.");
        }
      } catch (e) {
        res.status(500).send("Error retrieving raw body: " + String(e.message || e));
      } finally {
        await page.close();
        await context.close();
        return;
      }
    }

    // For normal HTML: let page finish JS and return content
    // Optionally we can wait for a selector known to appear, but networkidle is usually enough
    const content = await page.content();

    // Basic Cloudflare challenge detection: if found, return 403 with hint
    const lower = content.toLowerCase();
    if (lower.includes("just a moment") || lower.includes("cf-browser-verification") || lower.includes("__cf_chl_jschl_tk__")) {
      res.status(403).send("Cloudflare challenge detected in rendered HTML. Playwright rendered the page but challenge present.");
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(content);
    }

    await page.close();
    await context.close();

  } catch (err) {
    console.error("Render error:", err);
    if (page) try { await page.close(); } catch(_) {}
    res.status(500).send("Render error: " + String(err.message || err));
  } finally {
    release();
  }
});

// health
app.get("/health", (req, res) => res.send("ok"));

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received - shutting down...");
  await stopBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received - shutting down...");
  await stopBrowser();
  process.exit(0);
});

// start
(async () => {
  try {
    await startBrowser();
    app.listen(PORT, () => {
      console.log(`Playwright render server listening on http://localhost:${PORT}`);
      console.log(`MAX_CONCURRENCY=${MAX_CONCURRENCY}, NAV_TIMEOUT=${NAV_TIMEOUT}, GOTO_WAIT=${GOTO_WAIT}`);
    });
  } catch (err) {
    console.error("Failed to start browser:", err);
    process.exit(1);
  }
})();
