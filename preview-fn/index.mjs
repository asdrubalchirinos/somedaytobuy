// Someday to buy: devuelve { title, image } de la página de un producto.
// Uso: GET <function-url>/?url=https://...
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 2_000_000;

function json(status, body, cache = 0) {
  return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': cache ? `public, max-age=${cache}` : 'no-store' }, body: JSON.stringify(body) };
}

function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:') && isPrivate(ip.slice(7));
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const decode = s => s && s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();

function meta(html, key) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  return decode((html.match(re1) || html.match(re2) || [])[1]);
}

function extract(html, base) {
  let title = meta(html, 'og:title') || meta(html, 'twitter:title');
  let image = meta(html, 'og:image') || meta(html, 'og:image:secure_url') || meta(html, 'twitter:image');
  // Amazon
  const pt = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (pt) title = decode(pt[1].replace(/\s+/g, ' '));
  const hires = html.match(/data-old-hires=["']([^"']+)["']/i);
  if (hires && hires[1]) image = decode(hires[1]);
  else {
    const dyn = html.match(/data-a-dynamic-image=["']\{&quot;(https:[^&]+)&quot;/i);
    if (dyn) image = decode(dyn[1]);
  }
  if (!title) title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' '));
  if (image) { try { image = new URL(image, base).href; } catch { image = null; } }
  return { title: title ? title.slice(0, 200) : null, image: image || null };
}

const ALLOWED = /^https?:\/\/(www\.)?somedaytobuy\.com$/i;

export const handler = async (event) => {
  const h = event?.headers || {};
  const origin = h.origin || '';
  let refOrigin = '';
  try { refOrigin = h.referer ? new URL(h.referer).origin : ''; } catch {}
  if (!ALLOWED.test(origin) && !ALLOWED.test(refOrigin)) return json(403, { error: 'no permitido' });
  const target = event?.queryStringParameters?.url;
  let u;
  try { u = new URL(target); } catch { return json(400, { error: 'url inválida' }); }
  if (!/^https?:$/.test(u.protocol)) return json(400, { error: 'solo http o https' });
  try {
    const { address } = await lookup(u.hostname);
    if (isPrivate(address)) return json(400, { error: 'destino no permitido' });
  } catch { return json(400, { error: 'no se encontró el sitio' }); }

  const first = await attempt(u, 0);
  if (first.statusCode !== 502) return first;
  await new Promise(r => setTimeout(r, 700));
  return attempt(u, 1);
};

const UAS = [UA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'];

async function attempt(u, n) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), n ? 5000 : 7000);
  try {
    const r = await fetch(u.href, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': UAS[n], 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' } });
    const reader = r.body.getReader(); let size = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; chunks.push(value); if (size > MAX_BYTES) { ac.abort(); break; } }
    const html = Buffer.concat(chunks).toString('utf8');
    const data = extract(html, r.url || u.href);
    if (/captcha|robot check/i.test(html) && !data.image) return json(502, { error: 'el sitio bloqueó la consulta', status: r.status });
    return json(200, data, data.image ? 86400 : 0);
  } catch (e) {
    return json(504, { error: 'el sitio no respondió a tiempo' });
  } finally { clearTimeout(timer); }
}
