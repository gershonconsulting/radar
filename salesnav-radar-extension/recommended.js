// =============================================================
// Radar - Recommended Leads reader (1.19.0, 2026-11-26)
//
// Every Sales Navigator seat has a system lead list "Recommended Leads" (listSource RECOMMENDATION,
// ~100 people LinkedIn suggests from what the user already saves). Once a week the extension reads it
// so the app can build PERSONAS (ICP optimization, Intelligence > Personas).
//
// Cost to LinkedIn, per weekly read: 3 Sales API calls in one tab -
//   1. salesApiLists        (find the user's own Recommended Leads list id - it differs per seat)
//   2. salesApiPeopleSearch (all leads of that list, count 100, one more page if > 100)
//   3. salesApiCompanies    (industry + headcount for the leads' companies, batches of 50)
// Read-only: nothing is saved, viewed or sent on LinkedIn. Counted as 1 page + 1 lookup per batch.
//
// Per account config (hub getConfig): personas_collect = 'off' turns it off (default on).
// =============================================================

const RECO_LAST_KEY = 'radar_reco_last';
const RECO_EVERY_DAYS = 7;
const RECO_MAX_LEADS = 200;
const RECO_DAY_MS = 86400000;

function recoEnabled(cfg) { return String((cfg && cfg.personas_collect) || '').trim().toLowerCase() !== 'off'; }

// Due when never read, or the last read is older than RECO_EVERY_DAYS.
function recoDue(lastIso, nowMs) {
  if (!lastIso) return true;
  const t = new Date(lastIso).getTime();
  if (!isFinite(t)) return true;
  return (nowMs || Date.now()) - t >= RECO_EVERY_DAYS * RECO_DAY_MS;
}

// The system list LinkedIn fills with recommendations. Name is localised, listSource is not.
function pickRecommendationList(elements) {
  const lists = (elements || []).filter(e => e && String(e.listSource || '').toUpperCase() === 'RECOMMENDATION');
  if (!lists.length) return null;
  lists.sort((a, b) => (b.entityCount || 0) - (a.entityCount || 0));
  return { id: String(lists[0].id), name: lists[0].name || 'Recommended Leads', count: lists[0].entityCount || 0 };
}

function _recoCompanyId(urn) { const m = String(urn || '').match(/fs_salesCompany:(\d+)/); return m ? m[1] : ''; }
function _recoDegree(d) { const n = Number(d); return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : ''; }

// One compact row per lead - only professional fields, no photo, no contact data.
function compactRecoLead(el, companies) {
  const pos = ((el && el.currentPositions) || []).find(p => p && p.current) || ((el && el.currentPositions) || [])[0] || {};
  const cid = _recoCompanyId(pos.companyUrn);
  const co = (companies && cid && companies[cid]) || {};
  const urn = (String((el && el.entityUrn) || '').match(/\((ACwA[\w-]+)/) || [])[1] || '';
  return {
    urn: urn,
    name: (el && (el.fullName || [el.firstName, el.lastName].filter(Boolean).join(' '))) || '',
    title: String(pos.title || '').trim(),
    company: String(pos.companyName || co.name || '').trim(),
    company_id: cid,
    industry: co.industry || '',
    size: co.employeeCountRange || '',
    geo: (el && el.geoRegion) || '',
    degree: _recoDegree(el && el.degree),
    added: (el && el.dateAddedToListAt) ? new Date(el.dateAddedToListAt).toISOString().slice(0, 10) : ''
  };
}

// Injected into an authenticated Sales Navigator tab. Must stay self-contained (no outer helpers).
async function readRecommendedLeadsInPage(maxLeads) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
  if (!csrf) return { error: 'no JSESSIONID cookie' };
  const H = { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', accept: 'application/json' };
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: H });
    if (r.status === 401 || r.status === 403 || r.status === 429) return { stop: true, status: r.status };
    if (!r.ok) return { status: r.status };
    return { status: r.status, json: await r.json() };
  };
  // Rest.li wants the decoration's ( ) , percent-encoded (encodeURIComponent leaves ( ) alone) and the list urn's
  // colons as %3A - either one left raw gives HTTP 400 (checked live 2026-11-26).
  const dEnc = (d) => d.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/,/g, '%2C');
  const pause = () => new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 900)));
  const SOURCES = 'List(MANUAL,SYSTEM,RECOMMENDATION)';
  const lists = await get('/sales-api/salesApiLists?q=listType&listType=LEAD&listSources=' + SOURCES +
    '&isMetadataNeeded=false&start=0&count=50&sortCriteria=LAST_MODIFIED&sortOrder=DESCENDING&ownership=OWNED_BY');
  if (lists.stop) return { stop: true, status: lists.status, step: 'lists' };
  const els = (lists.json && lists.json.elements) || [];
  const found = els.filter(e => String(e.listSource || '').toUpperCase() === 'RECOMMENDATION')
    .map(e => ({ id: String(e.id), name: e.name, listSource: e.listSource, entityCount: e.entityCount }));
  if (!found.length) return { lists: [], leads: [], calls: 1 };
  found.sort((a, b) => (b.entityCount || 0) - (a.entityCount || 0));
  const list = found[0];
  await pause();
  const dec = '(entityUrn,firstName,lastName,fullName,degree,geoRegion,dateAddedToListAt,currentPositions*(companyName,title,companyUrn,current))';
  const leads = [];
  let calls = 1;
  for (let start = 0; start < maxLeads; start += 100) {
    const q = '(spotlightParam:(selectedType:ALL),doFetchSpotlights:false,doFetchHits:true,doFetchFilters:false,' +
      'pivotParam:(com.linkedin.sales.search.LeadListPivotRequest:(list:urn%3Ali%3Afs_salesList%3A' + list.id +
      ',sortCriteria:CREATED_TIME,sortOrder:DESCENDING)),list:(scope:LEAD,includeAll:false,excludeAll:false,includedValues:List((id:' + list.id + '))))';
    const page = await get('/sales-api/salesApiPeopleSearch?q=peopleSearchQuery&query=' + q + '&start=' + start + '&count=100&decoration=' + dEnc(dec));
    calls++;
    if (page.stop) return { stop: true, status: page.status, step: 'leads', list: list, leads: leads, calls: calls };
    const rows = (page.json && page.json.elements) || [];
    leads.push(...rows);
    const total = (page.json && page.json.paging && page.json.paging.total) || 0;
    if (rows.length < 100 || leads.length >= total) break;
    await pause();
  }
  const ids = [...new Set(leads.map(l => {
    const p = (l.currentPositions || []).find(x => x && x.current) || (l.currentPositions || [])[0] || {};
    const m = String(p.companyUrn || '').match(/fs_salesCompany:(\d+)/); return m ? m[1] : '';
  }).filter(Boolean))];
  const companies = {};
  let companyCalls = 0;
  for (let i = 0; i < ids.length; i += 50) {
    await pause();
    const r = await get('/sales-api/salesApiCompanies?ids=List(' + ids.slice(i, i + 50).join(',') + ')&decoration=' +
      dEnc('(entityUrn,name,industry,employeeCountRange)'));
    companyCalls++;
    if (r.stop) break;
    Object.assign(companies, (r.json && r.json.results) || {});
  }
  return { list: list, leads: leads.slice(0, maxLeads), companies: companies, calls: calls, companyCalls: companyCalls };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { recoEnabled, recoDue, pickRecommendationList, compactRecoLead, readRecommendedLeadsInPage, RECO_EVERY_DAYS, RECO_MAX_LEADS };
}
