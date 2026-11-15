// functions/_lib/version.js - THE single source of truth for the Radar app version.
// Bump it here, and only here: the sidebar / landing footer and the app's JS VERSION constant
// (stamped by functions/_middleware.js) and GET /api/health all read this value.
// (The Chrome extension has its own version, LATEST_EXT below - a different thing.)
export const APP_VERSION = '1.18.12';

// The published Chrome extension build (the zip the site hands out). Bump it HERE on every release:
// _middleware.js raises the app's LATEST_EXT_VERSION / download links to it, and /api/health reports it
// as `latest_ext`, which the daily-report email (v9.2+) reads as "the published version".
// (2026-11-15, app v1.18.12: moved here from _middleware.js. Supabase config latest_ext_version had
//  stayed at 1.17.0 after 1.17.2 shipped, so the daily email said 1.17.2 was "ahead of the published 1.17.0".)
export const LATEST_EXT = '1.17.2';
