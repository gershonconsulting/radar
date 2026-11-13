// functions/_lib/version.js - THE single source of truth for the Radar app version.
// Bump it here, and only here: the sidebar / landing footer and the app's JS VERSION constant
// (stamped by functions/_middleware.js) and GET /api/health all read this value.
// (The Chrome extension has its own version, LATEST_EXT in _middleware.js - a different thing.)
export const APP_VERSION = '1.18.9';
