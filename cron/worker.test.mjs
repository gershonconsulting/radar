// Offline checks for cron/worker.js — run: node cron/worker.test.mjs
import assert from "node:assert/strict";
import { parseJsonp, summarize, rowNyDate, nyDate, subject, renderHtml, renderText } from "./worker.js";

const sample = 'cb({"success":true,"service":"radar-ingest","count":5,"rows":[' +
  '{"collected_date":"2026-10-26T14:00:00.000Z","first_name":"A","last_name":"A","radar_person":"Elie Cohen","linkedin_url":"https://www.linkedin.com/in/a","botdog_pushed":"2026-10-26T15:00:00Z"},' +
  '{"collected_date":"2026-10-26T20:00:00.000Z","first_name":"B","last_name":"B","radar_person":"Elie Cohen","linkedin_url":"","botdog_pushed":""},' +
  '{"collected_date":"2026-10-27T02:00:00.000Z","first_name":"C","last_name":"C","radar_person":"Jane Doe","linkedin_url":"https://www.linkedin.com/in/c","botdog_pushed":""},' +
  '{"collected_date":"2026-10-27T05:00:00.000Z","first_name":"D","last_name":"D","radar_person":"Jane Doe","linkedin_url":"","botdog_pushed":""},' +
  '{"collected_date":"2026-07-14T22:09:57.061Z","first_name":"E","last_name":"E","radar_person":"","linkedin_url":"","botdog_pushed":""}]})';

const j = parseJsonp(sample);
assert.equal(j.rows.length, 5);
assert.equal(parseJsonp("cb(" + JSON.stringify({ success: true, rows: [] }) + ");").success, true);
assert.throws(() => parseJsonp("<html>error</html>"));

// 02:00Z on the 27th is still the 26th in New York.
assert.equal(rowNyDate("2026-10-27T02:00:00.000Z"), "2026-10-26");
assert.equal(rowNyDate("2026-10-26"), "2026-10-26");
assert.equal(rowNyDate(""), "");
assert.equal(nyDate(new Date("2026-10-26T22:05:00Z")), "2026-10-26");

const s = summarize(j.rows, "2026-10-26");
assert.equal(s.total, 3);
assert.equal(s.withUrl, 2);
assert.equal(s.unresolved, 1);
assert.equal(s.pushed, 1);
assert.equal(s.grandTotal, 5);
assert.deepEqual(s.byBridge.map((b) => [b.bridge, b.total]), [["Elie Cohen", 2], ["Jane Doe", 1]]);
assert.equal(s.noUrlFlag, false);
assert.equal(subject(s), "[22] Radar EOD — 3 new targets — 2026-10-26");

const noUrl = summarize([{ collected_date: "2026-10-26T15:00:00Z", radar_person: "X", linkedin_url: "" }], "2026-10-26");
assert.equal(noUrl.noUrlFlag, true);
assert.match(renderText(noUrl, { ok: true }), /enricherPro/);

const empty = summarize(j.rows, "2026-10-25");
assert.equal(empty.total, 0);
assert.equal(empty.noUrlFlag, false);
assert.match(renderHtml(empty, { ok: false, detail: "HTTP 500" }), /FAILED/);
assert.match(renderHtml(s, { ok: true }), /https:\/\/radar\.gershoncrm\.com/);

console.log("cron/worker.js checks passed");
