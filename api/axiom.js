export default async function handler(req, res) {
  // Set CORS headers so our frontend can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  const cookie = process.env.AXIOM_COOKIE;
  if (!cookie) {
    return res.status(500).json({ count: 0, error: 'AXIOM_COOKIE not configured' });
  }

  try {
    const resp = await fetch('https://api6.axiom.trade/online-users-count', {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://axiom.trade/',
        'Origin': 'https://axiom.trade'
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(200).json({ count: 0, error: `Axiom API ${resp.status}`, detail: text });
    }

    const data = await resp.json();
    const count = typeof data === 'number' ? data : (data.count || 0);
    return res.status(200).json({ count });
  } catch (e) {
    return res.status(200).json({ count: 0, error: e.message });
  }
}
