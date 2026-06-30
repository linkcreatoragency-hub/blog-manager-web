// Serverless proxy to the WordPress REST API (Vercel Node function).
// The browser never talks to WordPress directly — this function does, which
// avoids CORS issues and keeps requests server-to-server over HTTPS.
//
// Request body (JSON):
//   {
//     access:  "<access password>",          // must match ACCESS_PASSWORD env var (if set)
//     site:    { url, username, app_password },
//     method:  "GET" | "POST",
//     path:    "wp/v2/posts" | "wp/v2/posts/123" | ...,
//     query:   { per_page: 10, ... },          // optional
//     json:    { title, content, status, ... } // optional (request body)
//   }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  // Vercel parses JSON bodies automatically; fall back just in case.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Access gate: only enforced if ACCESS_PASSWORD is configured.
  const REQUIRED = process.env.ACCESS_PASSWORD || '';
  if (REQUIRED && body.access !== REQUIRED) {
    return res.status(200).json({ ok: false, status: 401, error: 'WRONG_ACCESS_PASSWORD' });
  }

  const site = body.site || {};
  if (!site.url || !site.username || !site.app_password) {
    return res.status(200).json({ ok: false, status: 0, error: 'Missing site credentials' });
  }

  // Build the target URL.
  let base = String(site.url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  const path = String(body.path || 'wp/v2/posts').replace(/^\/+/, '');
  let url = `${base}/wp-json/${path}`;
  if (body.query && typeof body.query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(body.query)) qs.append(k, String(v));
    url += '?' + qs.toString();
  }

  // Basic auth with the Application Password (spaces stripped).
  const cred = `${site.username}:${String(site.app_password).replace(/\s+/g, '')}`;
  const token = Buffer.from(cred, 'utf-8').toString('base64');
  const headers = {
    Authorization: 'Basic ' + token,
    Accept: 'application/json',
    'User-Agent': 'BlogManager/1.0',
  };

  const method = (body.method || 'GET').toUpperCase();
  let fetchBody;
  if (body.json !== undefined && body.json !== null) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body.json);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const r = await fetch(url, { method, headers, body: fetchBody, signal: controller.signal });
    clearTimeout(timer);

    const text = await r.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 500) }; }
    }

    if (r.ok) {
      return res.status(200).json({
        ok: true,
        status: r.status,
        data,
        total: r.headers.get('x-wp-total'),
      });
    }
    return res.status(200).json({ ok: false, status: r.status, error: data });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Request timed out' : ('Could not reach site: ' + e.message);
    return res.status(200).json({ ok: false, status: 0, error: msg });
  }
}
