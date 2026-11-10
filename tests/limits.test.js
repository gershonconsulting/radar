const assert=require('assert');
const L=require(require('path').join(__dirname,'..','salesnav-radar-extension','limits.js'));
const T0=new Date('2026-11-10T10:00:00').getTime();
// defaults
let e=L.effectiveLimits({},T0,null); assert.equal(e.limits.prospects_per_day,10); assert.equal(e.limits.lookups_per_day,25); assert.equal(e.scale,1);
// config + ceilings
e=L.effectiveLimits({daily_lead_target:'40',limit_pages_per_day:'9999'},T0,null); assert.equal(e.limits.prospects_per_day,40); assert.equal(e.limits.pages_per_day,80);
// pause / half / new install
e=L.effectiveLimits({limits_pause_until:'2026-11-16T13:00:00Z'},T0,null); assert.equal(e.paused,true);
e=L.effectiveLimits({limits_pause_until:'2026-11-16T13:00:00Z',limits_half_until:'2026-11-30T13:00:00Z'},new Date('2026-11-17T10:00:00Z').getTime(),null);
assert.equal(e.paused,false); assert.deepEqual([e.limits.prospects_per_day,e.limits.lookups_per_day,e.limits.lookups_per_hour,e.limits.pages_per_day,e.limits.pages_per_hour,e.limits.pages_per_bridge_day],[5,12,4,10,2,2]);
e=L.effectiveLimits({},T0,new Date(T0-3*86400000).toISOString()); assert.equal(e.scale,0.5);
e=L.effectiveLimits({},T0,new Date(T0-20*86400000).toISOString()); assert.equal(e.scale,1);
// hourly lookups
const lim=L.effectiveLimits({},T0,null).limits; let st=null;
for(let i=0;i<8;i++){assert(L.limitRoom(st,lim,'lookups',T0+i*1000).left>0); st=L.limitSpend(st,'lookups',1,T0+i*1000);}
let r=L.limitRoom(st,lim,'lookups',T0+9000); assert.equal(r.left,0); assert.equal(r.reason,'lookups_hour_cap'); assert(r.retryMs>3500000);
// after an hour, frees up; day cap 25
let t=T0; st=null; let used=0;
for(let h=0;h<10;h++){ for(let i=0;i<20;i++){ const now=t+h*3600000+i*1000; if(L.limitRoom(st,lim,'lookups',now).left>0){st=L.limitSpend(st,'lookups',1,now);used++;} } }
assert.equal(used,25,'day cap 25 lookups, got '+used);
// week cap = 5 days
st=null; used=0; const mon=new Date('2026-11-09T09:00:00').getTime();
for(let d=0;d<7;d++) for(let i=0;i<40;i++){const now=mon+d*86400000+i*600000; if(L.limitRoom(st,lim,'pages',now).left>0){st=L.limitSpend(st,'pages',1,now);used++;}}
assert.equal(used,100,'week pages 100, got '+used);
// bridge cursor: 3 pages/day, resume, rest when done
let c=null, pagesRead=[], day0=new Date('2026-11-10T10:00:00').getTime();
for(let d=0;d<12;d++){ const now=day0+d*86400000; const a=L.bridgeAllowance(c,lim,now,25); c=a.cursor; for(let k=0;k<a.pages;k++){ const pg=a.start+k; pagesRead.push(pg); c=L.bridgeAdvance(c,now,pg<25,25);} }
assert.deepEqual(pagesRead.slice(0,9),[1,2,3,4,5,6,7,8,9]); assert.equal(pagesRead.length,25,'reads whole bridge once then rests: '+pagesRead.length);
assert.equal(new Set(pagesRead).size,25,'no page read twice');
// split
const known=new Set(['a','b']); const sp=L.splitNewProspects([{lead_id:'a'},{lead_id:'c'},{lead_id:'d'},{lead_id:'e'},{lead_id:'c'}],known,2);
assert.deepEqual([sp.known.length,sp.accepted.map(x=>x.lead_id).join(),sp.overflow.map(x=>x.lead_id).join()],[1,'c,d','e']);
console.log('limits.js: all assertions passed');
