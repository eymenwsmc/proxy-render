// index.js
// Local Playwright render server for testing
// Usage: GET /render?url=<ENCODED_URL>&raw=true|false
// npm i express playwright

import express from "express";
import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "3", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT || "30000", 10); // ms
const GOTO_WAIT = process.env.GOTO_WAIT || "networkidle"; // 'networkidle' or 'load'

const app = express();
app.use(express.json({ limit: "1mb" }));

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

// Use persistent context to keep cookies (cf_clearance) and session
let persistentContext;
const USER_DATA_DIR = path.join(process.cwd(), "user-data");

async function startBrowser() {
  console.log("Launching chromium persistent context...");
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  persistentContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    colorScheme: "light",
  });

  // Basic stealth: remove webdriver flag, set plugins/languages
  await persistentContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["tr-TR", "tr", "en-US", "en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      // MASK_WEBGL_VENDOR_WEBGL, MASK_WEBGL_RENDERER
      if (parameter === 37445) return "Intel Inc.";
      if (parameter === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, parameter);
    };
    // plugins spoof
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }],
    });
  });

  console.log("Chromium persistent context ready.");
}

async function stopBrowser() {
  if (persistentContext) {
    try {
      await persistentContext.close();
      console.log("Chromium context closed.");
    } catch (e) {
      console.warn("Error closing context:", e.message || e);
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
    // Create a fresh page from persistent context (shared cookies/session)
    page = await persistentContext.newPage();

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

    // Wait for Cloudflare managed challenge to auto-resolve if present
    // Give it a few seconds and retry content read
    await page.waitForTimeout(3000);
    let content = await page.content();
    let lower = content.toLowerCase();
    if (lower.includes("just a moment") || lower.includes("cf-browser-verification") || lower.includes("__cf_chl_jschl_tk__")) {
      // try waiting longer
      await page.waitForTimeout(6000);
      content = await page.content();
      lower = content.toLowerCase();
    }

    // Basic Cloudflare challenge detection: if found, return 403 with hint
    if (lower.includes("just a moment") || lower.includes("cf-browser-verification") || lower.includes("__cf_chl_jschl_tk__")) {
      res.status(403).send("Cloudflare challenge detected in rendered HTML. Playwright rendered the page but challenge present.");
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(content);
    }

    await page.close();

  } catch (err) {
    console.error("Render error:", err);
    if (page) try { await page.close(); } catch(_) {}
    res.status(500).send("Render error: " + String(err.message || err));
  } finally {
    release();
  }
});

// Download submit endpoint: posts within page context to reuse cookies and referer
// POST /download-submit { url: string (optional, defaults to https://turkcealtyazi.org/ind), data: "idid=...&altid=...", refererPath?: string }
app.post("/download-submit", async (req, res) => {
  const url = normalizeUrl(req.body.url || "https://turkcealtyazi.org/ind");
  const data = req.body.data;
  const refererPath = typeof req.body.refererPath === "string" ? req.body.refererPath : "/";

  if (!data || !/idid=\d+&altid=\d+/.test(String(data))) {
    return res.status(400).json({ error: "Missing or invalid 'data' (expected idid=...&altid=...)" });
  }

  await acquire();
  let page;
  try {
    page = await persistentContext.newPage();
    await page.setExtraHTTPHeaders({ "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7" });

    // Warm-up to same-origin page so browser auto-sets Referer header for fetch
    await page.goto("https://turkcealtyazi.org" + refererPath, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

    // If challenge appears, give it time
    await page.waitForTimeout(3000);

    // Perform fetch within the page so cookies/headers are preserved
    const result = await page.evaluate(async ({ postUrl, body }) => {
      const resp = await fetch(postUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "*/*"
        },
        body,
      });
      const buf = await resp.arrayBuffer();
      const headers = {};
      resp.headers.forEach((v, k) => (headers[k] = v));
      return { status: resp.status, ok: resp.ok, headers, base64: Buffer.from(buf).toString("base64") };
    }, { postUrl: url, body: String(data) });

    if (!result.ok) {
      return res.status(result.status || 500).json({ success: false, error: "Target returned " + result.status });
    }
    return res.json({ success: true, data: result.base64, status_code: result.status, headers: result.headers, buffer_size: result.base64.length * 0.75 });
  } catch (err) {
    console.error("/download-submit error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  } finally {
    try { if (page) await page.close(); } catch(_) {}
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
