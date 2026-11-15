// Replays the Nov 4 situation against the REAL sync-core.js + limits.js with LinkedIn mocked.
const vm=require('vm'),fs=require('fs');
const EXT=require('path').join(__dirname,'..','salesnav-radar-extension')+'/';
let NOW=new Date(process.argv[2]||'2026-11-16T09:05:00').getTime();
const RealDate=Date;
class FakeDate extends RealDate{constructor(...a){if(a.length)super(...a);else super(NOW);} static now(){return NOW;}}
const store={};
const counts={pages:0,lookups:0,locations:0,listSaves:0,gate:0};const perDay={};
function dk(){const d=new RealDate(NOW);return d.toISOString().slice(0,10);}
function bump(k,n=1){counts[k]+=n;perDay[dk()]=perDay[dk()]||{pages:0,lookups:0,locations:0,listSaves:0,newProspects:0,maxLookupsInAnyHour:0};perDay[dk()][k]=(perDay[dk()][k]||0)+n;}
const lookupTimes=[];
const BRIDGE={bridge:'Todd Harris',name:'Todd Harris',urn:'ACwAAbridge1',source:'Meteor',active:true,connection:'1st'};
const BRIDGE2={bridge:'Small One',name:'Small One',urn:'ACwAAbridge2',source:'Meteor',active:true,connection:'1st'};
const targets=new Map(); // lead_id -> row
// pre-existing: first 200 of Todd's network already known (re-read pages)
for(let i=0;i<200;i++) targets.set('L1_'+i,{lead_id:'L1_'+i,linkedin_url:'https://www.linkedin.com/in/x'+i,salesnav_listed_at:'x'});
const opts={warnAt:process.env.WARN_AT?+process.env.WARN_AT:-1};
function hubGet(url){const u=new URL(url);const a=u.searchParams.get('action')||'';
  if(a==='getConfig')return Object.assign({daily_lead_target:'10'},JSON.parse(process.env.CFG||'{}'));
  if(a==='')return{success:true,rows:[...targets.values()]};
  if(a==='getSources')return{success:true,sources:[]};
  if(a==='getBridges')return{success:true,bridges:[BRIDGE,BRIDGE2]};
  if(a==='salesnavPending'){const ids=[...targets.values()].filter(t=>!t.salesnav_listed_at).map(t=>t.lead_id);return{success:true,list_id:'123',list_url:'x',lead_ids:ids.slice(0,+u.searchParams.get('cap')),pending_total:ids.length};}
  if(a==='salesnavBridgesPending')return{success:false,error:'no list'};
  if(a==='resolvePending'){const ids=[...targets.values()].filter(t=>!t.linkedin_url).map(t=>t.lead_id);return{success:true,lead_ids:ids.slice(0,+u.searchParams.get('cap')),pending_total:ids.length};}
  return{success:true};}
function hubPost(b){
  if(Array.isArray(b.leads)){for(const l of b.leads){const prev=targets.get(l.lead_id);if(!prev)bump('newProspects');targets.set(l.lead_id,Object.assign(prev||{},l.linkedin_url?{lead_id:l.lead_id,linkedin_url:l.linkedin_url}:{lead_id:l.lead_id}));}return{ok:true,upserted:b.leads.length};}
  if(b.action==='setTargetUrls'){for(const u of b.urls){const t=targets.get(u.lead_id);if(t)t.linkedin_url=u.linkedin_url;}return{ok:true};}
  if(b.action==='markSalesnavListed'){for(const id of b.lead_ids){const t=targets.get(id);if(t)t.salesnav_listed_at='now';}return{ok:true,marked:b.lead_ids.length};}
  return{ok:true};}
const resp=(o)=>({ok:true,status:200,json:async()=>o,text:async()=>'cb('+JSON.stringify(o)+')'});
const chrome={
  runtime:{getManifest:()=>JSON.parse(fs.readFileSync(EXT+'manifest.json')),onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}},lastError:null},
  alarms:{create(){},clear:async()=>{},onAlarm:{addListener(){}}},
  storage:{local:{get:async(k)=>{if(k==null)return{...store};const ks=Array.isArray(k)?k:[k];const o={};ks.forEach(x=>{if(x in store)o[x]=JSON.parse(JSON.stringify(store[x]));});return o;},set:async(o)=>{Object.assign(store,JSON.parse(JSON.stringify(o)));},remove:async(k)=>{(Array.isArray(k)?k:[k]).forEach(x=>delete store[x]);}}},
  tabs:{get:(id,cb)=>{const t={id,status:'complete',url:'https://www.linkedin.com/sales'};if(cb)cb(t);return Promise.resolve(t);},create:async()=>({id:9}),remove(){},onUpdated:{addListener(){},removeListener(){}}},
  scripting:{executeScript:async(o)=>{const n=o.func&&o.func.name;
    if(n==='resolveUrnsInPage'){const urn=o.args[0][0];bump('lookups');lookupTimes.push(NOW);
      if(opts.warnAt>=0&&counts.lookups>opts.warnAt)return[{result:{out:[{urn,status:401,stop:true}]}}];
      return[{result:{out:[{urn,status:200,url:'https://www.linkedin.com/in/'+urn,degree:2}]}}];}
    if(n==='salesNavSessionProbeInPage')return[{result:{ok:true}}];
    if(n==='salesNavAddChunkInPage'){bump('listSaves',o.args[1].length);return[{result:{ok:true,status:200}}];}
    if(n==='resolveManualBridgesInPage')return[{result:{out:[]}}];
    return[{result:null}];}},
  windows:{create:async()=>({id:1,tabs:[{id:2}]}),remove(){},update:async()=>{},get:async()=>({id:1})},
  notifications:{create(){}},
};
const ctx={chrome,console:{log(){},warn(){},error(){}},Date:FakeDate,Math,JSON,URL,Promise,Set,Map,Array,Object,String,Number,RegExp,Error,encodeURIComponent,decodeURIComponent,isFinite,parseInt,
  setTimeout:(fn,ms)=>{NOW+=Math.max(0,ms||0);setImmediate(fn);return 1;},clearTimeout(){},setImmediate,
  fetch:async(input,init)=>{const url=typeof input==='string'?input:input.url;
    if(/radar-gate/.test(url)){counts.gate++;return resp({allow:true});}
    if(/functions\/v1\/hub/.test(url)){if(init&&init.method==='POST')return resp(hubPost(JSON.parse(init.body)));return resp(hubGet(url));}
    return resp({});},
  performance:{getEntriesByType:()=>[]},
};
ctx.self=ctx;ctx.importScripts=(f)=>vm.runInContext(fs.readFileSync(EXT+f,'utf8'),ctx,{filename:f});
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(EXT+'sync-core.js','utf8'),ctx,{filename:'sync-core.js'});
// LinkedIn mocks
const NET={'ACwAAbridge1':625,'ACwAAbridge2':40};
ctx.openScrapeTab=async()=>({id:2});ctx.closeScrapeWindow=async()=>{};ctx.closeTabLater=()=>{};ctx.waitForTabComplete=async()=>true;ctx.ensureCaptureScript=async()=>{};ctx.checkLogin=async()=>true;
ctx.scrapePageInTab=async(url,bridge)=>{bump('pages');const page=+((url.match(/&page=(\d+)/)||[])[1]||1);const n=NET[bridge.urn];const from=(page-1)*25;const out=[];
  for(let i=from;i<Math.min(n,from+25);i++)out.push({first_name:'P',last_name:''+i,lead_id:(bridge.urn==='ACwAAbridge1'?'L1_':'L2_')+i,radar_person:bridge.bridge,country:'US',linkedin_url:''});return out;};
ctx.fetchLeadLocation=async()=>{bump('locations');return 'Boston, US';};
(async()=>{
  const END=NOW+ +(process.env.DAYS||10)*86400000; let trigger='startup';let guard=0;
  while(NOW<END&&guard++<2000){
    await ctx.maybeAutoRun(trigger);
    const pr=store['radar_gate_resume'];
    if(pr&&pr.at){NOW=Math.max(NOW+60000,new RealDate(pr.at).getTime());trigger='gateResume';}
    else{const d=new RealDate(NOW);d.setDate(d.getDate()+1);d.setHours(9,5,0,0);NOW=d.getTime();trigger='startup';}
  }
  // max lookups in any rolling hour
  let maxH=0;for(let i=0;i<lookupTimes.length;i++){let j=i;while(j<lookupTimes.length&&lookupTimes[j]-lookupTimes[i]<3600000)j++;maxH=Math.max(maxH,j-i);}
  console.log(JSON.stringify({perDay,totals:counts,maxLookupsInAnyHour:maxH,hold:store['radar_li_hold_until']||null,cursor:store['radar_bridge_cursor'],overflowQueued:(store['radar_new_overflow']||[]).length},null,1));
})().catch(e=>{console.error('SIM ERROR',e);process.exit(1);});
