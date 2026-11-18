// functions/_lib/hosts.js (2026-11-18, app v1.22.0) - Radar moves to radar.gershon.ai.
// PRIMARY_HOST is the address every link, email and redirect now uses. The old address
// radar.gershoncrm.com keeps working (same Pages project) so nobody is cut off; set
// REDIRECT_LEGACY = true to send old-address page visits to the new one (301). It stays
// false until every client desktop runs extension 1.18.1+, because 1.18.0 and older only
// announce themselves to pages on the old address (the app would show "extension missing").
export const PRIMARY_HOST = 'radar.gershon.ai';
export const LEGACY_HOST = 'radar.gershoncrm.com';
export const PRIMARY_ORIGIN = 'https://' + PRIMARY_HOST;
export const REDIRECT_LEGACY = false;

const KNOWN = /^(radar\.gershon\.ai|radar\.gershoncrm\.com|([a-z0-9-]+\.)?gershon-radar\.pages\.dev)$/i;

// Origin to send the user back to: the address they are on, if it is one of ours.
export function originFor(request) {
  try { const u = new URL(request.url); if (KNOWN.test(u.hostname)) return u.origin; } catch (_) {}
  return PRIMARY_ORIGIN;
}

// LinkedIn redirect_uri for this request. The new address uses its own callback (must be listed
// under Authorized redirect URLs in the LinkedIn app); every other host keeps the configured value.
export function linkedinRedirectUri(request, env) {
  try {
    const u = new URL(request.url);
    if (u.hostname === PRIMARY_HOST) return PRIMARY_ORIGIN + '/api/auth/linkedin/callback';
  } catch (_) {}
  return env.LINKEDIN_REDIRECT_URI;
}
