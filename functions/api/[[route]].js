/**
 * SK Print API. Single router for every /api/* endpoint.
 *
 * Auth model: a PIN gates the whole site. The PIN lives in KV, seeded from the
 * LOGIN_PIN environment variable on first use, because Cloudflare env vars are
 * immutable at runtime and the PIN has to be resettable from the UI.
 *
 * Sessions are HMAC-signed cookies rather than stored server-side, so there is
 * no session table to expire or clean up.
 */

const PIN_KEY = 'auth:pin';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/tiff',
]);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const enc = new TextEncoder();

/** Timing-safe compare so a wrong PIN cannot be found byte by byte. */
function safeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function makeSession(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `v1.${exp}`;
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function validSession(env, cookie) {
  if (!cookie) return false;
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [v, exp, sig] = parts;
  if (v !== 'v1') return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, `${v}.${exp}`));
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** Live PIN, seeded from the immutable env var on first call. */
async function currentPin(env) {
  const stored = await env.SETTINGS.get(PIN_KEY);
  if (stored) return stored;
  const boot = env.LOGIN_PIN;
  if (boot) await env.SETTINGS.put(PIN_KEY, boot);
  return boot || null;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = (params.route || []).join('/');
  const method = request.method;

  if (!env.SESSION_SECRET) {
    return json({ error: 'SESSION_SECRET is not configured' }, 500);
  }

  const authed = await validSession(env, getCookie(request, 'skp_session'));

  // ---- public ----------------------------------------------------------
  if (route === 'login' && method === 'POST') {
    const pin = await currentPin(env);
    if (!pin) return json({ error: 'No PIN configured. Set LOGIN_PIN.' }, 500);

    const { pin: given } = await request.json().catch(() => ({}));
    if (!given || !safeEqual(String(given), pin)) {
      // Uniform delay so a wrong PIN is not distinguishable by response time.
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: 'Incorrect PIN' }, 401);
    }
    const token = await makeSession(env);
    return json(
      { ok: true },
      200,
      {
        'set-cookie': `skp_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`,
      }
    );
  }

  if (route === 'session' && method === 'GET') {
    return json({ authed });
  }

  if (route === 'logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'set-cookie': 'skp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    });
  }

  // ---- everything below requires a session ------------------------------
  if (!authed) return json({ error: 'Not authenticated' }, 401);

  if (route === 'pin' && method === 'POST') {
    const { current, next } = await request.json().catch(() => ({}));
    const pin = await currentPin(env);
    if (!current || !safeEqual(String(current), pin)) {
      return json({ error: 'Current PIN is incorrect' }, 403);
    }
    const candidate = String(next || '');
    if (!/^\d{4,12}$/.test(candidate)) {
      return json({ error: 'New PIN must be 4-12 digits' }, 400);
    }
    await env.SETTINGS.put(PIN_KEY, candidate);
    return json({ ok: true });
  }

  if (route === 'files' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, type, size, uploaded_at FROM files ORDER BY uploaded_at DESC LIMIT 500'
    ).all();
    // Totals come from the whole table, not the 500-row page, so the storage
    // figure stays honest once there are more files than the list shows.
    const totals = await env.DB.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files'
    ).first();
    return json({ files: results || [], total: totals || { count: 0, bytes: 0 } });
  }

  // Bulk cleanup. KV has no batch delete, so keys go one at a time, in chunks
  // so a large clear-out does not open hundreds of concurrent requests. D1 is
  // emptied only after the blobs are gone, so an interrupted delete leaves rows
  // pointing at real files rather than orphaning blobs with no index.
  if (route === 'files' && method === 'DELETE') {
    const { results } = await env.DB.prepare('SELECT id FROM files').all();
    const ids = (results || []).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 25) {
      await Promise.all(ids.slice(i, i + 25).map((k) => env.FILES.delete(k)));
    }
    await env.DB.prepare('DELETE FROM files').run();
    return json({ deleted: ids.length });
  }

  if (route === 'upload' && method === 'POST') {
    const form = await request.formData();
    const uploads = form.getAll('files').filter((f) => typeof f === 'object');
    if (!uploads.length) return json({ error: 'No files supplied' }, 400);

    const saved = [];
    const rejected = [];
    for (const file of uploads) {
      if (!ALLOWED.has(file.type)) {
        rejected.push({ name: file.name, reason: `Unsupported type ${file.type || 'unknown'}` });
        continue;
      }
      if (file.size > MAX_BYTES) {
        rejected.push({ name: file.name, reason: `Over ${MAX_BYTES / 1024 / 1024} MB` });
        continue;
      }
      const id = crypto.randomUUID();
      // KV takes the whole body in memory. That is why MAX_BYTES is 25 MB - it
      // is KV's hard per-value ceiling, not an arbitrary choice.
      await env.FILES.put(id, await file.arrayBuffer(), {
        metadata: { type: file.type, name: file.name },
      });
      await env.DB.prepare(
        'INSERT INTO files (id, name, type, size, uploaded_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(id, file.name, file.type, file.size, new Date().toISOString())
        .run();
      saved.push({ id, name: file.name });
    }
    return json({ saved, rejected });
  }

  if (route.startsWith('file/') && method === 'GET') {
    const id = route.slice(5);
    const row = await env.DB.prepare('SELECT name, type FROM files WHERE id = ?')
      .bind(id)
      .first();
    if (!row) return json({ error: 'Not found' }, 404);

    const body = await env.FILES.get(id, { type: 'stream' });
    if (!body) return json({ error: 'File missing from storage' }, 404);

    const disposition = new URL(request.url).searchParams.has('download')
      ? `attachment; filename="${row.name.replace(/"/g, '')}"`
      : 'inline';
    return new Response(body, {
      headers: {
        'content-type': row.type,
        'content-disposition': disposition,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  if (route.startsWith('file/') && method === 'DELETE') {
    const id = route.slice(5);
    await env.FILES.delete(id);
    await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Unknown route' }, 404);
}
