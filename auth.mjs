import { timingSafeEqual } from 'node:crypto';

export function isLoopbackAddress(address) {
  const plain = String(address || '').replace(/^::ffff:/, '');
  return plain === '::1' || plain === '127.0.0.1' || plain.startsWith('127.');
}

export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getUiPassword(env = process.env, uiConfig = {}) {
  const envPass = env?.FREE_ROUTER_PASSWORD || env?.WEBUI_PASSWORD;
  if (envPass !== undefined && envPass !== '') return String(envPass);
  const cfgPass = uiConfig?.password;
  if (cfgPass !== undefined && cfgPass !== '') return String(cfgPass);
  return '';
}

export function isUiAuthenticated(req, expectedPassword) {
  if (!expectedPassword || typeof expectedPassword !== 'string') return false;

  const authHeader = String(req?.headers?.authorization || '').trim();
  if (authHeader) {
    if (/^basic\s+/i.test(authHeader)) {
      const raw = authHeader.replace(/^basic\s+/i, '').trim();
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        if (colonIdx !== -1) {
          const user = decoded.slice(0, colonIdx);
          const pass = decoded.slice(colonIdx + 1);
          if (safeCompare(pass, expectedPassword) || safeCompare(user, expectedPassword)) {
            return true;
          }
        } else {
          if (safeCompare(decoded, expectedPassword)) return true;
        }
      } catch {
        // ignore malformed base64
      }
    } else if (/^bearer\s+/i.test(authHeader)) {
      const token = authHeader.replace(/^bearer\s+/i, '').trim();
      if (safeCompare(token, expectedPassword)) return true;
    }
  }

  const headers = req?.headers || {};
  const customHeader =
    headers['x-password'] ||
    headers['x-webui-password'] ||
    headers['x-free-router-password'] ||
    headers['x-api-key'];
  if (customHeader && safeCompare(String(customHeader), expectedPassword)) {
    return true;
  }

  const cookieHeader = String(headers.cookie || '');
  if (cookieHeader) {
    for (const c of cookieHeader.split(';')) {
      const [k, ...v] = c.trim().split('=');
      const key = k?.trim().toLowerCase();
      if (key === 'free_router_password' || key === 'webui_password' || key === 'password') {
        const val = decodeURIComponent(v.join('=').trim());
        if (safeCompare(val, expectedPassword)) return true;
      }
    }
  }

  return false;
}

export function uiGuardFailure(req, { allowExternal = false } = {}) {
  if (!allowExternal) {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      return 'requests must come from loopback';
    }

    const host = String(req?.headers?.host || '');
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (hostname && hostname !== 'localhost' && !isLoopbackAddress(hostname)) {
      return `unexpected Host header: ${host}`;
    }
  }

  const site = String(req?.headers?.['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request blocked (Sec-Fetch-Site: ${site})`;
  }

  const origin = String(req?.headers?.origin || '');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return `invalid Origin header: ${origin}`;
    }
    if (!allowExternal && originHost !== 'localhost' && !isLoopbackAddress(originHost)) {
      return `unexpected Origin header: ${origin}`;
    }
  }
  return '';
}
