const express = require('express');
const path = require('path');
const { chromium } = require('playwright-core');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ====== SCRAPER CONFIG ======
const TERMINALS = {
  axiom: {
    name: 'Axiom',
    url: 'https://axiom.trade',
    color: '#a78bfa',
    // Axiom has a known API — try it first, fall back to DOM scrape
    apiUrl: 'https://api6.axiom.trade/online-users-count',
    scrape: async (page) => {
      // Look for text like "X online" or "X users online"
      return extractCount(page, /[\d,]+\s*(users?\s*)?online/i);
    }
  },
  bullx: {
    name: 'BullX',
    url: 'https://bullx.io',
    color: '#facc15',
    scrape: async (page) => {
      return extractCount(page, /[\d,]+\s*(users?\s*)?online/i);
    }
  },
  photon: {
    name: 'Photon',
    url: 'https://photon-sol.tinyastro.io',
    color: '#34d399',
    scrape: async (page) => {
      return extractCount(page, /[\d,]+\s*(users?\s*)?online/i);
    }
  },
  padre: {
    name: 'Padre',
    url: 'https://trade.padre.gg',
    color: '#f472b6',
    scrape: async (page) => {
      return extractCount(page, /[\d,]+\s*(users?\s*)?online/i);
    }
  },
  trojan: {
    name: 'Trojan',
    url: 'https://trojan.com',
    color: '#fb923c',
    scrape: async (page) => {
      return extractCount(page, /[\d,]+\s*(users?\s*)?online|active/i);
    }
  }
};

// ====== CACHE ======
let cache = {};
let lastScrape = 0;
const CACHE_TTL = 30_000; // 30 seconds
let scraping = false;

// Helper: extract a number near a pattern from page text
async function extractCount(page, pattern) {
  // Strategy 1: intercept network responses that contain user counts
  // Strategy 2: find it in the DOM
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const match = bodyText.match(pattern);
  if (match) {
    const numMatch = match[0].match(/[\d,]+/);
    if (numMatch) return parseInt(numMatch[0].replace(/,/g, ''), 10);
  }

  // Strategy 3: look for elements with specific data attributes or classes
  const count = await page.evaluate(() => {
    // Common patterns for online user counters
    const selectors = [
      '[class*="online"]', '[class*="user-count"]', '[class*="active-user"]',
      '[data-online]', '[data-users]', '[data-count]',
      '[class*="traders"]', '[class*="count"]'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.innerText || el.textContent || '';
        const num = text.match(/[\d,]+/);
        if (num && parseInt(num[0].replace(/,/g, '')) > 50) {
          return parseInt(num[0].replace(/,/g, ''), 10);
        }
      }
    }
    return null;
  });

  return count;
}

async function scrapeAll() {
  if (scraping) return cache;
  scraping = true;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const results = {};

    for (const [key, terminal] of Object.entries(TERMINALS)) {
      try {
        // Try API endpoint first (Axiom)
        if (terminal.apiUrl) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(terminal.apiUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'Accept': 'application/json'
              }
            });
            clearTimeout(timeout);
            if (resp.ok) {
              const data = await resp.json();
              // Could be { count: N } or { online: N } or just N
              const count = typeof data === 'number' ? data :
                data.count || data.online || data.users || data.onlineUsers ||
                data.online_users_count || data.online_users || null;
              if (count) {
                results[key] = { name: terminal.name, count, color: terminal.color, url: terminal.url, source: 'api', ts: Date.now() };
                continue;
              }
            }
          } catch (e) { /* fall through to scrape */ }
        }

        // Scrape with browser
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1920, height: 1080 }
        });
        const page = await context.newPage();

        // Also capture any API responses with user counts
        let apiCount = null;
        page.on('response', async (response) => {
          try {
            const url = response.url();
            if (url.match(/online|user.*count|active.*count|trader/i) && response.status() === 200) {
              const text = await response.text();
              try {
                const json = JSON.parse(text);
                const val = typeof json === 'number' ? json :
                  json.count || json.online || json.users || json.onlineUsers ||
                  json.online_users_count || json.online_users || json.data?.count || null;
                if (val && typeof val === 'number') apiCount = val;
              } catch (e) {
                const num = text.match(/\d+/);
                if (num && parseInt(num[0]) > 50) apiCount = parseInt(num[0]);
              }
            }
          } catch (e) { /* response already disposed */ }
        });

        await page.goto(terminal.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(6000); // let JS load and counters populate

        let count = apiCount || await terminal.scrape(page);
        await context.close();

        results[key] = {
          name: terminal.name,
          count: count || null,
          color: terminal.color,
          url: terminal.url,
          source: apiCount ? 'api-intercept' : (count ? 'dom-scrape' : 'unavailable'),
          ts: Date.now()
        };
      } catch (e) {
        results[key] = {
          name: terminal.name,
          count: null,
          color: terminal.color,
          url: terminal.url,
          source: 'error',
          error: e.message,
          ts: Date.now()
        };
      }
    }

    cache = results;
    lastScrape = Date.now();
    return results;
  } catch (e) {
    console.error('Browser launch error:', e.message);
    // Return error state for all terminals so frontend still renders cards
    if (Object.keys(cache).length === 0) {
      for (const [key, terminal] of Object.entries(TERMINALS)) {
        cache[key] = {
          name: terminal.name,
          count: null,
          color: terminal.color,
          url: terminal.url,
          source: 'browser-error',
          error: e.message,
          ts: Date.now()
        };
      }
    }
    return cache;
  } finally {
    if (browser) await browser.close().catch(() => {});
    scraping = false;
  }
}

// ====== API ROUTES ======
app.get('/api/counts', async (req, res) => {
  // Return cached data if fresh enough
  if (Date.now() - lastScrape < CACHE_TTL && Object.keys(cache).length > 0) {
    return res.json({ data: cache, cached: true, age: Date.now() - lastScrape });
  }

  const data = await scrapeAll();
  res.json({ data, cached: false, age: 0 });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`Terminal Tracker running on port ${PORT}`);
  // Pre-warm the cache
  scrapeAll().then(() => console.log('Initial scrape complete'));
});
