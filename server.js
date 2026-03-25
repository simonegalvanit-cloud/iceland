const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ====== TERMINALS ======
const TERMINALS = {
  axiom: { name: 'Axiom', url: 'https://axiom.trade', color: '#a78bfa' },
  bullx: { name: 'BullX', url: 'https://bullx.io', color: '#facc15' },
  photon: { name: 'Photon', url: 'https://photon-sol.tinyastro.io', color: '#34d399' },
  padre: { name: 'Padre', url: 'https://trade.padre.gg', color: '#f472b6' },
  trojan: { name: 'Trojan', url: 'https://trojan.com', color: '#fb923c' },
};

// ====== CACHE ======
let cache = {};
let lastFetch = 0;
const CACHE_TTL = 30_000; // 30 seconds

async function fetchAxiomCount() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('https://api6.axiom.trade/online-users-count', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://axiom.trade/',
        'Origin': 'https://axiom.trade'
      }
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      // Handle various response shapes
      if (typeof data === 'number') return data;
      return data.count || data.online || data.users || data.onlineUsers ||
        data.online_users_count || data.online_users || data.data?.count || null;
    }
  } catch (e) {
    console.error('Axiom API error:', e.message);
  }
  return null;
}

async function fetchAll() {
  const axiomCount = await fetchAxiomCount();
  const now = Date.now();

  const results = {};
  for (const [key, terminal] of Object.entries(TERMINALS)) {
    results[key] = {
      name: terminal.name,
      count: key === 'axiom' ? axiomCount : 0,
      color: terminal.color,
      url: terminal.url,
      source: key === 'axiom' ? (axiomCount !== null ? 'api' : 'unavailable') : 'coming-soon',
      ts: now
    };
  }

  cache = results;
  lastFetch = now;
  return results;
}

// ====== API ROUTES ======
app.get('/api/counts', async (req, res) => {
  if (Date.now() - lastFetch < CACHE_TTL && Object.keys(cache).length > 0) {
    return res.json({ data: cache, cached: true, age: Date.now() - lastFetch });
  }
  const data = await fetchAll();
  res.json({ data, cached: false, age: 0 });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`Terminal Tracker running on port ${PORT}`);
  fetchAll().then(() => console.log('Initial fetch complete'));
});
