// functions/_lib/session.js
// HMAC-SHA-256 signed session tokens — no external dependencies
// Works in Cloudflare Workers / Pages Functions (Web Crypto API)

const enc = new TextEncoder();

async function hmac(data, secret) {
    const key = await crypto.subtle.importKey(
          'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
          false, ['sign', 'verify']
        );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function sign(payload, secret) {
    const body = btoa(JSON.stringify(payload))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return body + '.' + await hmac(body, secret);
}

export async function verify(token, secret) {
    if (!token || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (await hmac(body, secret) !== sig) return null;
    try {
          return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
          return null;
    }
}
