// node tests/personas.test.mjs - Personas (app v1.25.0 / ext 1.19.0 / hub v28)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { roleOf, industryOf, regionOf, sizeOf, buildPersonas } from '../functions/api/personas.js';
const require = createRequire(import.meta.url);
const R = require('../salesnav-radar-extension/recommended.js');

// --- classification
assert.equal(roleOf('Co-Founder & CEO'), 'CEO / President');
assert.equal(roleOf('CEO, CTO & Co-Founder'), 'CTO / Technical lead');
assert.equal(roleOf('Co-founder, CTO'), 'CTO / Technical lead');
assert.equal(roleOf('COO, Co-founder'), 'COO / Operations');
assert.equal(roleOf('Founder'), 'Founder');
assert.equal(roleOf('Managing Partner'), 'Investor / Board');
assert.equal(roleOf(''), 'Unknown role');
assert.equal(roleOf('VP Sales North America'), 'Sales / Revenue');
assert.equal(industryOf('Software Development'), 'Software & AI');
assert.equal(industryOf('Biotechnology Research'), 'Health & Life sciences');
assert.equal(industryOf('Wellness and Fitness Services'), 'Health & Life sciences');
assert.equal(industryOf('Venture Capital and Private Equity Principals'), 'Financial services');
assert.equal(industryOf(''), 'Industry unknown');
assert.equal(regionOf('Brooklyn, New York, United States'), 'US - New York area');
assert.equal(regionOf('San Francisco Bay Area'), 'US - West Coast');
assert.equal(regionOf('Paris, Île-de-France, France'), 'France');
assert.equal(regionOf('London, England, United Kingdom'), 'UK');
assert.equal(regionOf('Austin, Texas, United States'), 'US - other');
assert.equal(sizeOf('11-50'), '11-50'); assert.equal(sizeOf('2-10'), '1-10'); assert.equal(sizeOf('10001+'), '1000+'); assert.equal(sizeOf(''), 'Size unknown');

// --- personas
const mk = (n, title, industry, geo, size, degree) => Array.from({ length: n }, (_, i) => ({ name: title + ' ' + industry + ' ' + i, title, company: 'Co' + i, industry, geo, size, degree }));
const leads = [
  ...mk(10, 'Co-Founder & CEO', 'Software Development', 'New York, New York, United States', '11-50', '2nd'),
  ...mk(6, 'Co-founder, CTO', 'Software Development', 'San Francisco, California, United States', '51-200', '2nd'),
  ...mk(4, 'Founder and CEO', 'Biotechnology Research', 'Boston, Massachusetts, United States', '11-50', '1st'),
  ...mk(2, 'COO', 'Hospitals and Health Care', 'Paris, France', '51-200', '3rd'),
  ...mk(1, 'COO', 'Retail', 'London, United Kingdom', '201-500', '2nd'),
  ...mk(2, 'Board Member', 'Banking', 'London, United Kingdom', '1001-5000', '2nd')
];
const targets = [
  ...Array.from({ length: 30 }, (_, i) => ({ title: 'CEO', country: 'US', grade: i < 20 ? 'A' : 'C' })),
  ...Array.from({ length: 12 }, () => ({ title: 'COO', country: 'FR', grade: 'D' })),
  ...Array.from({ length: 5 }, () => ({ title: '', country: '', grade: '?' }))
];
const r = buildPersonas(leads, targets);
assert.equal(r.total, 25);
assert.equal(r.personas[0].name, 'CEO / President · Software & AI');
assert.equal(r.personas[0].size, 10);
assert.equal(r.personas[0].share, 40);
assert.equal(r.personas[0].warm_pct, 100);
assert.equal(r.personas[0].regions[0].label, 'US - New York area');
assert.equal(r.personas[0].company_sizes[0].label, '11-50');
assert.equal(r.personas[0].radar.prospects_same_role, 30);
assert.equal(r.personas[0].verdict, 'converts', 'CEO: 20/30 graded ICP');
const cto = r.personas.find(p => p.role === 'CTO / Technical lead');
assert.equal(cto.verdict, 'gap', 'no CTO prospects in Radar');
assert.equal(cto.salesnav_filters.function, 'Engineering / Information Technology');
const ceoBio = r.personas.find(p => p.name === 'CEO / President · Health & Life sciences');
assert.ok(ceoBio && ceoBio.size === 4);
const coo = r.personas.find(p => p.role === 'COO / Operations');
assert.equal(coo.industry_group, 'Mixed industries', '2+1 COOs merged across industries');
assert.equal(coo.verdict, 'off_icp', 'COO: 12 graded, 0 ICP');
assert.equal(r.others.size, 2, 'the 2 board members are too few');
assert.equal(r.grouped, 23);
assert.equal(r.dims.degree.first, 4);
assert.equal(buildPersonas([], []).personas.length, 0);
assert.equal(buildPersonas(leads, []).personas[0].verdict, 'no_data');

// --- extension helpers
assert.equal(R.recoEnabled({}), true); assert.equal(R.recoEnabled({ personas_collect: 'OFF' }), false);
const NOW = Date.parse('2026-11-26T12:00:00Z');
assert.equal(R.recoDue(null, NOW), true);
assert.equal(R.recoDue('2026-11-22T12:00:00Z', NOW), false);
assert.equal(R.recoDue('2026-11-19T11:00:00Z', NOW), true);
assert.deepEqual(R.pickRecommendationList([{ id: 1, name: 'E2', listSource: 'MANUAL', entityCount: 300 }, { id: 689, name: 'Recommended Leads', listSource: 'RECOMMENDATION', entityCount: 100 }]),
  { id: '689', name: 'Recommended Leads', count: 100 });
assert.equal(R.pickRecommendationList([{ id: 1, listSource: 'MANUAL' }]), null);
const el = { entityUrn: 'urn:li:fs_salesProfile:(ACwAAAABHckB5niY,NAME_SEARCH,YB4y)', fullName: 'Alexandre Winter', degree: 1, geoRegion: 'Brooklyn, New York, United States',
  dateAddedToListAt: Date.parse('2026-11-20T10:00:00Z'), currentPositions: [{ current: true, companyName: 'Norbert Health', title: 'CEO, co-founder', companyUrn: 'urn:li:fs_salesCompany:64623471' }] };
assert.deepEqual(R.compactRecoLead(el, { 64623471: { industry: 'Wellness and Fitness Services', employeeCountRange: '11-50' } }),
  { urn: 'ACwAAAABHckB5niY', name: 'Alexandre Winter', title: 'CEO, co-founder', company: 'Norbert Health', company_id: '64623471',
    industry: 'Wellness and Fitness Services', size: '11-50', geo: 'Brooklyn, New York, United States', degree: '1st', added: '2026-11-20' });
console.log('personas: all assertions passed');
