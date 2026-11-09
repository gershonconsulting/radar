// Radar hub — Supabase Edge Function backend (v26).
// v26 (2026-11-06 nightly, NOT DEPLOYED - needs Ariel): FIRST-SEEN DATE PRESERVED. The ingest no longer
// sends collected_date in its upsert payload. With on_conflict=owner_key,lead_id + merge-duplicates,
// every column in the payload is rewritten on conflict, so re-collecting a prospect moved its
// collected_date to "now" and past days' "new prospects" counts shrank (Nov 2: email +154, now 47;
// Nov 3: email +37, now 0). A new row still gets collected_date = now() from the column default; an
// existing row keeps its original date. first_seen_at (migration supabase/handoff/2026-11-06-targets-
// first-seen.sql) is never sent either and is protected by a trigger. Only the ingest block changed.
// This file is the deployed v25 source copied from Supabase on 2026-11-06 plus that one change (the hub
// source was not tracked in git before). Safe to deploy before OR after the migration.
// v25 (2026-10-29, Olivier: "deploy hub v25 to production"): ICP INTENSITY. getBridges now carries each bridge's ICP stats
// (icp_verdict focus|normal|slow|cant_judge, icp_hit_pct, icp_count, icp_scorable) from view bridge_icp_stats.
// For the Chrome extension only, a SLOW bridge is offered active one day in three, so the daily page budget
// goes to FOCUS/normal bridges. Stored state untouched; the app sees the real flag. Per-owner off switch:
// config auto_intensity = off.
// v24 (2026-10-28, approved by Olivier): SUGGESTED sources. A source with category 'suggested' is a Gershon
// pre-analysis item that is OFF: getSources returns it to the Radar web app (Origin or Referer
// radar.gershoncrm.com / *.gershon-radar.pages.dev) so the client sees it in the list, but NEVER to the
// Chrome extension - so the extension does not resolve its org id, discover bridges or collect from it.
// Switching it ON = addSource with another category (upsert flips it).
// v23 (2026-10-14): Source PRIORITY + plain WEBSITE in addSource.
// v22 (2026-09-24): no silent fallback to Olivier's account (no owner = refused).
// v21: setBridgeUrn. v20: digit slugs. v18: URL backlog + pushTargetsAll. v17: setSourceOrg/queueDiscover.
// v16: two Sales Nav lists. v15: bridge health/meta. v12: Sales Nav list sync. v10: dedupe leads.
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const INGEST_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const SOLO_OWNER = 'xTVW0K1qKi';
const BOTDOG_ADD = 'https://api.botdog.co/v1/leads/add_to_campaign';
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type' };
const NO_OWNER_GET = new Set(['getUsers','getBotdogCampaigns']);
const NO_OWNER_POST = new Set(['pushTargetsAll','inviteUser']);
const NO_OWNER_MSG = 'no_owner: this browser is not linked to a Radar account yet - open the Radar app in this Chrome so the extension learns who it collects for';
const APP_ORIGIN_RE = /^https:\/\/(radar\.gershoncrm\.com|[a-z0-9-]+\.gershon-radar\.pages\.dev|gershon-radar\.pages\.dev)$/i;
const enc = encodeURIComponent;
function cleanOwner(v:unknown){const s=String(v??'').trim();return /^[A-Za-z0-9_-]{4,64}$/.test(s)?s:'';}
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...CORS,'Content-Type':'application/json','Cache-Control':'no-store'}});}
function jsonp(cb:string,o:unknown){return new Response((cb||'_cb')+'('+JSON.stringify(o)+')',{status:200,headers:{...CORS,'Content-Type':'application/javascript','Cache-Control':'no-store'}});}
async function sb(path:string,opts:any={}){const r=await fetch(`${SB_URL}/rest/v1/${path}`,{...opts,headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json',Prefer:opts.prefer||'return=representation',...(opts.headers||{})}});const text=await r.text();let body:any=null;try{body=text?JSON.parse(text):null;}catch{body=text;}if(!r.ok)throw new Error(`supabase ${r.status}: ${String(text).slice(0,180)}`);return body;}
async function readTargets(o:string){const rows=await sb(`targets?owner_key=eq.${enc(o)}&order=collected_date.desc&limit=5000`);return(rows||[]).map((t:any)=>({collected_date:t.collected_date,first_name:t.first_name,last_name:t.last_name,title:t.title,company:t.company,linkedin_url:t.linkedin_url,radar_person:t.radar_person,lead_id:t.lead_id,botdog_pushed:t.botdog_pushed,salesnav_listed_at:t.salesnav_listed_at,connection:t.connection||'',country:t.country||'',city:t.city||'',language:t.language||'',grade:t.grade||'',selected:t.selected}));}
async function readExcluded(o:string){const rows=await sb(`targets?owner_key=eq.${enc(o)}&selected=eq.false&select=lead_id`);return(rows||[]).map((r:any)=>r.lead_id).filter(Boolean);}
async function readSources(o:string,includeSuggested=true){const f=includeSuggested?'':'&or=(category.is.null,category.neq.suggested)';const rows=await sb(`sources?owner_key=eq.${enc(o)}${f}&order=added_date.desc`);return(rows||[]).map((s:any)=>({name:s.name,linkedin_url:s.linkedin_url,website:s.website||'',category:s.category,org_id:s.org_id,discover_keyword:s.discover_keyword,discover_pending:!!s.discover_pending,discovered:!!s.discovered,discover_held:!!s.discover_held,priority:s.priority||'medium',added_date:s.added_date,suggested:s.category==='suggested'}));}
const PRIORITIES=new Set(['high','medium','low']);
function cleanPriority(v:unknown){const s=String(v??'').toLowerCase().trim();return PRIORITIES.has(s)?s:'';}
function isLinkedInUrl(u:string){return /(^|\/\/|\.)linkedin\.com\//i.test(u);}
function normWebsite(u:string){let s=String(u||'').trim();if(!s)return '';if(!/^https?:\/\//i.test(s))s='https://'+s;try{const x=new URL(s);return x.origin+'/';}catch(_){return '';}}
function nameFromWebsite(u:string){try{const h=new URL(u).hostname.replace(/^www\./i,'');const root=h.split('.')[0]||h;return root.replace(/[-_]+/g,' ').replace(/\b\w/g,(c:string)=>c.toUpperCase());}catch(_){return '';}}
async function linkedinFromWebsite(site:string){
  const tryOne=async(u:string)=>{try{const ac=new AbortController();const t=setTimeout(()=>ac.abort(),9000);const r=await fetch(u,{signal:ac.signal,redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36','Accept':'text/html'}});clearTimeout(t);if(!r.ok)return '';return (await r.text()).slice(0,800000);}catch(_){return '';}};
  let html=await tryOne(site);
  const re=/linkedin\.com\/(company|school|showcase)\/([A-Za-z0-9%._-]+)/gi;
  const tally=(h:string)=>{const m=new Map<string,number>();let x;while((x=re.exec(h))){const slug=x[2].replace(/[._-]+$/,'');if(!slug)continue;const k=x[1].toLowerCase()+'/'+slug;m.set(k,(m.get(k)||0)+1);}return m;};
  let counts=tally(html);
  if(!counts.size){for(const path of ['contact','about','en/']){html=await tryOne(site+path);counts=tally(html);if(counts.size)break;}}
  if(!counts.size)return '';
  const best=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  return 'https://www.linkedin.com/'+best+'/';
}
async function readBridges(o:string,forExt=false){
  const rows=await sb(`bridges?owner_key=eq.${enc(o)}&order=added_date.asc&limit=5000`);
  // v25: ICP intensity. Per-bridge ICP stats (view bridge_icp_stats, fed by the targets ICP-score trigger).
  let stats:any[]=[];try{stats=await sb(`bridge_icp_stats?owner_key=eq.${enc(o)}&select=bridge,prospects,scorable,icp,hit_pct,verdict`)||[];}catch(_){stats=[];}
  const norm=(s:unknown)=>String(s||'').replace(/\s+was last active.*$/i,'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
  const byName=new Map<string,any>();for(const s of stats)byName.set(norm(s.bridge),s);
  let auto=true;if(forExt){try{const c=await sb(`config?owner_key=eq.${enc(o)}&key=eq.auto_intensity&select=value`);if(c&&c[0]&&String(c[0].value).toLowerCase()==='off')auto=false;}catch(_){}}
  const day=Math.floor(Date.now()/86400000);
  const hash=(s:string)=>{let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return Math.abs(h);};
  return(rows||[]).map((b:any)=>{
    const st=byName.get(norm(b.name))||null;
    const verdict=st?st.verdict:'cant_judge';
    let active=b.active;
    // SLOW bridges (hit rate under 30% on 10+ scorable prospects) are offered to the extension one day in three,
    // so the daily page budget goes to FOCUS/normal bridges first. Stored state is untouched; the app sees the real flag.
    let throttled=false;
    if(forExt&&auto&&active===true&&verdict==='slow'&&((day+hash(String(b.urn||'')))%3)!==0){active=false;throttled=true;}
    return({source:b.source,name:b.name,title:b.title,urn:b.urn,linkedin_url:b.linkedin_url||'',connection:b.connection||'',active,health:b.health||'',health_reason:b.health_reason||'',botdog_pushed:b.botdog_pushed,salesnav_listed_at:b.salesnav_listed_at,added_date:b.added_date,
      icp_verdict:verdict,icp_hit_pct:st?st.hit_pct:null,icp_count:st?Number(st.icp):0,icp_scorable:st?Number(st.scorable):0,icp_prospects:st?Number(st.prospects):0,intensity_throttled:throttled});
  });
}
async function readConfig(o:string){const rows=await sb(`config?owner_key=eq.${enc(o)}`);const c:any={};(rows||[]).forEach((r:any)=>c[r.key]=r.value);return c;}
function redactConfig(c:any){const safe:any={};for(const k in c){safe[k]=/_api_key$/.test(k)?(c[k]?'set':''):c[k];}return safe;}
async function writeConfig(o:string,obj:Record<string,unknown>){const now=new Date().toISOString();const rows=Object.entries(obj).filter(([,v])=>v!==undefined&&v!==null).map(([key,value])=>({owner_key:o,key,value:String(value),updated_at:now}));if(rows.length)await sb('config?on_conflict=owner_key,key',{method:'POST',body:JSON.stringify(rows),prefer:'resolution=merge-duplicates,return=minimal'});}
async function testOne(fn:()=>Promise<boolean>){try{return await fn();}catch(_){return false;}}
async function botdogAdd(key:string,campaign:string,lead:any){const u=(()=>{let x=String(lead.linkedin_url||'').split('?')[0];try{x=decodeURIComponent(x);}catch(_){}return x;})();if(!/linkedin\.com\/in\//i.test(u))return{skip:true};const r=await fetch(BOTDOG_ADD,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify({campaignId:campaign,leads:[{linkedinUrl:u,name:lead.name||undefined,title:lead.title||undefined,company:lead.company||undefined}]})});if(r.status>=200&&r.status<300)return{ok:true};const t=await r.text();return{ok:false,status:r.status,body:t.slice(0,60)};}
function randKey(){const a='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';let s='';const v=crypto.getRandomValues(new Uint8Array(10));for(const x of v)s+=a[x%a.length];return s;}
function salesnavListId(u:string){return(String(u||'').match(/\/sales\/lists\/people\/(\d+)/)||[])[1]||'';}
function dedupeLeads(rows:any[]){const byId=new Map<string,any>();for(const r of rows){const prev=byId.get(r.lead_id);if(!prev){byId.set(r.lead_id,r);continue;}const merged:any={...prev};for(const k in r){if(r[k]!==undefined&&r[k]!==null&&r[k]!=='')merged[k]=r[k];}if(prev.collected_date)merged.collected_date=prev.collected_date;byId.set(r.lead_id,merged);}return Array.from(byId.values());}
function isFirstDegree(c:string){return /^1st\b|^1\b/.test(String(c||'').toLowerCase().trim());}
function isPublicProfileUrl(u:unknown){return /linkedin\.com\/in\//i.test(String(u||''));}
const ORG_NUM_RE=/(?:organization|company)\/(\d+)(?:[\/?#]|$)/;
function orgIdFrom(p:any){const fromUrl=(String(p.linkedin_url||'').trim().match(ORG_NUM_RE)||[])[1];const raw=String(p.org_id||'').trim();const fromRaw=(raw.match(ORG_NUM_RE)||raw.match(/^(\d{3,})$/)||[])[1];return fromUrl||fromRaw||'';}
function isRealUrn(u:string){const s=String(u||'').trim();return !!s && !/^manual:/i.test(s) && !/\s/.test(s);}
const NO_URL_FILTER = 'or=(linkedin_url.is.null,linkedin_url.eq.)';

async function pushTargetsFor(own:string,cap:number,campaignOverride?:string){
  const c=await readConfig(own);
  const key=c.botdog_api_key;
  const campaign=campaignOverride||c.botdog_campaign_id;
  if(!key)return{owner:own,ok:false,error:'no botdog key in config',pushed:0,attempted:0,remaining:0,campaign:'',errors:[] as string[]};
  if(!campaign)return{owner:own,ok:false,error:'no targets campaign',pushed:0,attempted:0,remaining:0,campaign:'',errors:[] as string[]};
  const rows=await sb(`targets?owner_key=eq.${enc(own)}&selected=eq.true&linkedin_url=ilike.*linkedin.com/in/*&botdog_pushed=is.null&select=lead_id,first_name,last_name,title,company,linkedin_url&order=collected_date.desc&limit=1000`);
  const todo=(rows||[]).slice(0,cap);
  let pushed=0;const errs:string[]=[];
  for(const t of todo){
    const nm=((t.first_name||'')+' '+(t.last_name||'')).trim();
    const res=await botdogAdd(key,campaign,{linkedin_url:t.linkedin_url,name:nm,title:t.title,company:t.company});
    if(res.skip)continue;
    if(res.ok){await sb(`targets?owner_key=eq.${enc(own)}&lead_id=eq.${enc(t.lead_id)}`,{method:'PATCH',body:JSON.stringify({botdog_pushed:new Date().toISOString()}),prefer:'return=minimal'});pushed++;}
    else{errs.push(t.lead_id+':'+res.status+':'+res.body);}
  }
  const remaining=Math.max(0,(rows||[]).length-todo.length);
  return{owner:own,ok:true,error:'',pushed,attempted:todo.length,remaining,campaign,errors:errs.slice(0,12)};
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});
  const url=new URL(req.url);
  const refOrigin=(()=>{try{return new URL(req.headers.get('referer')||'').origin;}catch(_){return '';}})();
  const fromApp=APP_ORIGIN_RE.test(req.headers.get('origin')||'')||APP_ORIGIN_RE.test(refOrigin);
  try{
    if(req.method==='GET'){
      const cb=url.searchParams.get('callback')||'_cb';const action=url.searchParams.get('action')||'';const own=cleanOwner(url.searchParams.get('owner'));
      if(!own&&!NO_OWNER_GET.has(action)){
        return jsonp(cb,{success:false,ok:false,error:NO_OWNER_MSG,no_owner:true,rows:[],excluded_leads:'[]',sources:[],bridges:[],lead_ids:[],urns:[],pending_total:0,list_url:'',list_id:''});
      }
      if(!action){const [rows,excluded]=await Promise.all([readTargets(own),readExcluded(own)]);return jsonp(cb,{success:true,rows,excluded_leads:JSON.stringify(excluded)});}
      if(action==='getSources')return jsonp(cb,{success:true,sources:await readSources(own,fromApp)});
      if(action==='getBridges')return jsonp(cb,{success:true,bridges:await readBridges(own,!fromApp)});
      if(action==='getConfig')return jsonp(cb,redactConfig(await readConfig(own)));
      if(action==='resolvePending'){
        const cap=Math.min(Math.max(parseInt(url.searchParams.get('cap')||'400',10)||400,1),1000);
        const rows=await sb(`targets?owner_key=eq.${enc(own)}&${NO_URL_FILTER}&lead_id=not.is.null&select=lead_id&order=collected_date.desc&limit=${cap}`);
        const ids=(rows||[]).map((r:any)=>r.lead_id).filter(Boolean);
        const all=await sb(`targets?owner_key=eq.${enc(own)}&${NO_URL_FILTER}&lead_id=not.is.null&select=lead_id&limit=5000`);
        return jsonp(cb,{success:true,lead_ids:ids,pending_total:(all||[]).length});
      }
      if(action==='salesnavPending'){
        const c=await readConfig(own);
        const listUrl=c.salesnav_list_url||'';
        const listId=salesnavListId(listUrl);
        const cap=Math.min(Math.max(parseInt(url.searchParams.get('cap')||'200',10)||200,1),1000);
        if(!listId)return jsonp(cb,{success:false,error:'no salesnav list configured',list_url:listUrl,list_id:'',lead_ids:[]});
        const rows=await sb(`targets?owner_key=eq.${enc(own)}&selected=eq.true&salesnav_listed_at=is.null&lead_id=not.is.null&select=lead_id,collected_date&order=collected_date.desc&limit=${cap}`);
        const ids=(rows||[]).map((r:any)=>r.lead_id).filter(Boolean);
        const remaining=await sb(`targets?owner_key=eq.${enc(own)}&selected=eq.true&salesnav_listed_at=is.null&lead_id=not.is.null&select=lead_id&limit=5000`);
        return jsonp(cb,{success:true,list_url:listUrl,list_id:listId,lead_ids:ids,pending_total:(remaining||[]).length});
      }
      if(action==='salesnavBridgesPending'){
        const c=await readConfig(own);
        const listUrl=c.salesnav_bridges_list_url||'';
        const listId=salesnavListId(listUrl);
        const cap=Math.min(Math.max(parseInt(url.searchParams.get('cap')||'100',10)||100,1),1000);
        if(!listId)return jsonp(cb,{success:false,error:'no salesnav bridges list configured',list_url:listUrl,list_id:'',urns:[]});
        const rows=await sb(`bridges?owner_key=eq.${enc(own)}&salesnav_listed_at=is.null&urn=not.is.null&select=urn,connection,added_date&order=added_date.desc&limit=5000`);
        const eligible=(rows||[]).filter((b:any)=>isRealUrn(b.urn)&&!isFirstDegree(b.connection||''));
        const urns=eligible.slice(0,cap).map((b:any)=>b.urn);
        return jsonp(cb,{success:true,list_url:listUrl,list_id:listId,urns,pending_total:eligible.length});
      }
      if(action==='botdogStatus'){
        const c=await readConfig(own);
        const q=`targets?owner_key=eq.${enc(own)}&selected=eq.true&select=lead_id&limit=5000`;
        const waiting=await sb(`${q}&linkedin_url=ilike.*linkedin.com/in/*&botdog_pushed=is.null`);
        const noUrl=await sb(`${q}&${NO_URL_FILTER}`);
        const done=await sb(`${q}&botdog_pushed=not.is.null`);
        return jsonp(cb,{success:true,configured:!!(c.botdog_api_key&&c.botdog_campaign_id),ready_to_push:(waiting||[]).length,blocked_no_url:(noUrl||[]).length,pushed:(done||[]).length});
      }
      if(action==='keyStatus'){const c=await readConfig(own);return jsonp(cb,{botdog_set:!!c.botdog_api_key,resend_set:!!c.resend_api_key,pappers_set:!!c.pappers_api_key,botdog_valid:c.botdog_valid==='true',resend_valid:c.resend_valid==='true',pappers_valid:c.pappers_valid==='true',tested_at:c.keys_tested_at||null});}
      if(action==='getUsers'){const users=await sb(`users?order=created_at.asc`);return jsonp(cb,{success:true,users});}
      if(action==='getBotdogCampaigns')return jsonp(cb,{campaigns:[]});
      return jsonp(cb,{success:false,error:'unknown action '+action});
    }
    if(req.method==='POST'){
      let p:any={};try{p=JSON.parse(await req.text());}catch{return json({ok:false,error:'bad JSON'},400);}
      if(p.secret!==INGEST_SECRET)return json({ok:false,error:'unauthenticated'},401);
      const own=cleanOwner(p.owner);
      const a=Array.isArray(p.leads)?'__ingest':(p.action||'');
      if(!own&&!NO_OWNER_POST.has(a)){
        return json({ok:false,saved:false,no_owner:true,error:NO_OWNER_MSG},400);
      }
      if(Array.isArray(p.leads)){
        // v26: collected_date (and first_seen_at) are deliberately NOT in the payload. merge-duplicates
        // rewrites every column it is sent, so sending collected_date=now() moved a re-collected prospect
        // to today. Left out, a NEW row takes the column default now() and an EXISTING row keeps its date.
        // Every row in a batch must carry the same keys for PostgREST bulk upsert - they still do.
        const rows=p.leads.filter((l:any)=>l&&l.lead_id).map((l:any)=>{
          const r:any={owner_key:own,first_name:l.first_name||'',last_name:l.last_name||'',title:l.title||'',company:l.company||'',radar_person:l.radar_person||'',lead_id:l.lead_id,country:l.country||'',city:l.city||'',language:l.language||''};
          if(isPublicProfileUrl(l.linkedin_url))r.linkedin_url=String(l.linkedin_url);
          if(l.connection)r.connection=String(l.connection);
          return r;
        });
        const dedup=dedupeLeads(rows);
        const groups=new Map<string,any[]>();
        for(const r of dedup){const k=(r.linkedin_url?'u':'-')+(r.connection?'c':'-');if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(r);}
        for(const batch of groups.values()){
          if(batch.length)await sb('targets?on_conflict=owner_key,lead_id',{method:'POST',body:JSON.stringify(batch),prefer:'resolution=merge-duplicates,return=minimal'});
        }
        return json({success:true,ok:true,upserted:dedup.length,received:rows.length,with_url:dedup.filter((r:any)=>r.linkedin_url).length});
      }
      if(a==='setTargetUrls'){
        const list=Array.isArray(p.urls)?p.urls:[];
        const rows=list.filter((u:any)=>u&&u.lead_id&&isPublicProfileUrl(u.linkedin_url)).map((u:any)=>{
          const r:any={owner_key:own,lead_id:String(u.lead_id),linkedin_url:String(u.linkedin_url)};
          if(u.connection)r.connection=String(u.connection);
          return r;
        });
        if(!rows.length)return json({ok:true,saved:true,updated:0,skipped:list.length});
        const groups=new Map<string,any[]>();
        for(const r of rows){const k=r.connection?'c':'-';if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(r);}
        let updated=0;
        for(const batch of groups.values()){
          for(let i=0;i<batch.length;i+=200){
            const slice=batch.slice(i,i+200);
            await sb('targets?on_conflict=owner_key,lead_id',{method:'POST',body:JSON.stringify(slice),prefer:'resolution=merge-duplicates,return=minimal'});
            updated+=slice.length;
          }
        }
        return json({ok:true,saved:true,updated,skipped:list.length-rows.length});
      }
      if(a==='addSource'){
        let li=String(p.linkedin_url||'').trim();let website='';let foundLi='';
        if(li&&!isLinkedInUrl(li)){website=normWebsite(li);li='';if(website){foundLi=await linkedinFromWebsite(website);li=foundLi;}}
        if(p.website&&!website)website=normWebsite(String(p.website));
        let nm=String(p.name||'').trim();
        if(!nm&&li){const sl=(li.match(/\/(?:company|school|showcase)\/([^/?#]+)/)||[])[1]||'';try{nm=decodeURIComponent(sl).replace(/-/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,(c:string)=>c.toUpperCase());}catch(_){nm=sl;}}
        if(!nm&&website)nm=nameFromWebsite(website);
        if(!nm)return json({ok:false,error:'name required'},400);
        p.linkedin_url=li;
        const row:any={owner_key:own,name:nm,added_date:new Date().toISOString()};
        if(li)row.linkedin_url=li;
        if(website)row.website=website;
        const pr=cleanPriority(p.priority);if(pr)row.priority=pr;
        if(p.category)row.category=String(p.category);
        const orgId=orgIdFrom(p);
        if(orgId)row.org_id=orgId;
        if(p.discover_keyword)row.discover_keyword=String(p.discover_keyword);
        if(p.discover_now)row.discover_pending=true;
        await sb('sources?on_conflict=owner_key,name',{method:'POST',body:JSON.stringify([row]),prefer:'resolution=merge-duplicates,return=minimal'});
        return json({saved:true,ok:true,name:nm,org_id:orgId||null,linkedin_url:li||null,website:website||null,linkedin_found:!!foundLi,needs_linkedin:!li});
      }
      if(a==='setSourcePriority'){
        const pr=cleanPriority(p.priority);
        if(!p.name||!pr)return json({ok:false,error:'name and priority (high|medium|low) required'},400);
        await sb(`sources?owner_key=eq.${enc(own)}&name=eq.${enc(String(p.name))}`,{method:'PATCH',body:JSON.stringify({priority:pr}),prefer:'return=minimal'});
        return json({ok:true,saved:true,priority:pr});
      }
      if(a==='setSourceLinkedin'){
        const lu=String(p.linkedin_url||'').trim();
        if(!p.name||!/linkedin\.com\/(company|school|showcase)\//i.test(lu))return json({ok:false,error:'name and a linkedin.com/company/ url required'},400);
        const patch:any={linkedin_url:lu,discover_pending:true};const oid=orgIdFrom({linkedin_url:lu});if(oid)patch.org_id=oid;
        await sb(`sources?owner_key=eq.${enc(own)}&name=eq.${enc(String(p.name))}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'});
        return json({ok:true,saved:true});
      }
      if(a==='setSourceOrg'){
        const orgId=orgIdFrom(p);
        if(!p.name||!orgId)return json({ok:false,error:'name and a numeric org_id required'},400);
        await sb(`sources?owner_key=eq.${enc(own)}&name=eq.${enc(String(p.name))}`,{method:'PATCH',body:JSON.stringify({org_id:orgId}),prefer:'return=minimal'});
        return json({ok:true,saved:true,org_id:orgId});
      }
      if(a==='queueDiscover'){
        if(!p.name)return json({ok:false,error:'name required'},400);
        const patch:any={discover_pending:true};
        if(typeof p.discover_keyword==='string'&&p.discover_keyword)patch.discover_keyword=p.discover_keyword;
        await sb(`sources?owner_key=eq.${enc(own)}&name=eq.${enc(String(p.name))}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'});
        return json({ok:true,saved:true});
      }
      if(a==='addBridges'){const rows=(p.bridges||[]).filter((b:any)=>b&&b.urn).map((b:any)=>({owner_key:own,source:p.source||'Manual',name:b.name||'',title:b.title||'',urn:b.urn,linkedin_url:b.linkedin_url||null,connection:b.connection||'',active:b.active===true,added_date:new Date().toISOString()}));const seen=new Map<string,any>();for(const r of rows)seen.set(r.urn,r);const dedup=Array.from(seen.values());if(dedup.length)await sb('bridges?on_conflict=owner_key,urn',{method:'POST',body:JSON.stringify(dedup),prefer:'resolution=merge-duplicates,return=minimal'});return json({saved:true,ok:true,added:dedup.length});}
      if(a==='setBridgeMeta'){
        if(!p.urn)return json({ok:false,error:'urn required'},400);
        const patch:any={};
        if(typeof p.linkedin_url==='string'&&p.linkedin_url)patch.linkedin_url=p.linkedin_url;
        if(typeof p.connection==='string'&&p.connection){
          patch.connection=p.connection;
          if(isFirstDegree(p.connection)){
            patch.active=true;patch.health='unknown';patch.health_reason=null;
          }else{
            patch.health='not_connected';
            patch.health_reason='Not a 1st-degree connection - CONNECTION_OF would be dropped. Queued for an invite.';
          }
        }
        if(!Object.keys(patch).length)return json({ok:true,saved:false,reason:'nothing to patch'});
        await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(p.urn)}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'});
        return json({ok:true,saved:true,patched:Object.keys(patch)});
      }
      if(a==='setBridgeUrn'){
        const oldUrn=String(p.old_urn||'');const newUrn=String(p.urn||'').trim();
        if(!/^manual:/i.test(oldUrn)||!/^ACwA[\w-]+$/.test(newUrn))return json({ok:false,error:'old_urn must be manual:… and urn a Sales Nav member urn'},400);
        const man=await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(oldUrn)}&select=*`);
        if(!man||!man.length)return json({ok:false,error:'manual bridge not found'},404);
        const m=man[0];
        const conn=typeof p.connection==='string'?p.connection:'';
        const known=!!conn;const first=known&&isFirstDegree(conn);
        const health=known&&!first?'not_connected':'unknown';
        const reason=known&&!first?'Not a 1st-degree connection - CONNECTION_OF would be dropped. Queued for an invite.':null;
        const ex=await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(newUrn)}&select=*`);
        if(ex&&ex.length){
          const e=ex[0];const patch:any={active:true};
          if(!e.health||e.health==='invalid_urn'){patch.health=health;patch.health_reason=reason;}
          if((!e.source||e.source==='Manual')&&m.source&&m.source!=='Manual')patch.source=m.source;
          if(conn&&!e.connection)patch.connection=conn;
          if(!e.linkedin_url&&m.linkedin_url)patch.linkedin_url=m.linkedin_url;
          await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(newUrn)}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'});
          await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(oldUrn)}`,{method:'DELETE',prefer:'return=minimal'});
          return json({ok:true,saved:true,merged:true,urn:newUrn});
        }
        const patch:any={urn:newUrn,active:true,health,health_reason:reason};
        if(p.name)patch.name=String(p.name);
        if(p.title&&!m.title)patch.title=String(p.title);
        if(conn)patch.connection=conn;
        await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(oldUrn)}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'});
        return json({ok:true,saved:true,merged:false,urn:newUrn});
      }
      if(a==='setBridgeActive'){await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(p.urn)}`,{method:'PATCH',body:JSON.stringify({active:!!p.active}),prefer:'return=minimal'});return json({saved:true,ok:true});}
      if(a==='deleteBridge'){await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(p.urn)}`,{method:'DELETE',prefer:'return=minimal'});return json({saved:true,ok:true});}
      if(a==='setExcluded'){await sb(`targets?owner_key=eq.${enc(own)}&lead_id=eq.${enc(p.lead_id)}`,{method:'PATCH',body:JSON.stringify({selected:!p.excluded}),prefer:'return=minimal'});return json({saved:true,ok:true});}
      if(a==='markSalesnavListed'){
        const ids=(p.lead_ids||[]).filter(Boolean).map((x:any)=>String(x));
        if(!ids.length)return json({ok:true,saved:true,marked:0});
        const when=p.at?String(p.at):new Date().toISOString();
        let marked=0;
        for(let i=0;i<ids.length;i+=100){
          const slice=ids.slice(i,i+100);
          const list=slice.map((x:string)=>`"${x.replace(/"/g,'')}"`).join(',');
          await sb(`targets?owner_key=eq.${enc(own)}&lead_id=in.(${enc(list)})`,{method:'PATCH',body:JSON.stringify({salesnav_listed_at:when}),prefer:'return=minimal'});
          marked+=slice.length;
        }
        return json({ok:true,saved:true,marked});
      }
      if(a==='markSalesnavBridgesListed'){
        const urns=(p.urns||p.lead_ids||[]).filter(Boolean).map((x:any)=>String(x));
        if(!urns.length)return json({ok:true,saved:true,marked:0});
        const when=p.at?String(p.at):new Date().toISOString();
        let marked=0;
        for(let i=0;i<urns.length;i+=100){
          const slice=urns.slice(i,i+100);
          const list=slice.map((x:string)=>`"${x.replace(/"/g,'')}"`).join(',');
          await sb(`bridges?owner_key=eq.${enc(own)}&urn=in.(${enc(list)})`,{method:'PATCH',body:JSON.stringify({salesnav_listed_at:when}),prefer:'return=minimal'});
          marked+=slice.length;
        }
        return json({ok:true,saved:true,marked});
      }
      if(a==='setConfig'){const obj:any={botdog_api_key:p.botdog_api_key,resend_api_key:p.resend_api_key,pappers_api_key:p.pappers_api_key,botdog_campaign_id:p.botdog_campaign_id,botdog_bridges_campaign_id:p.botdog_bridges_campaign_id,salesnav_list_url:p.salesnav_list_url,salesnav_bridges_list_url:p.salesnav_bridges_list_url,daily_lead_target:p.daily_lead_target,salesnav_search_template:p.salesnav_search_template};const rows=Object.entries(obj).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([key,value])=>({owner_key:own,key,value:String(value),updated_at:new Date().toISOString()}));if(rows.length)await sb('config?on_conflict=owner_key,key',{method:'POST',body:JSON.stringify(rows),prefer:'resolution=merge-duplicates,return=minimal'});return json({saved:true,ok:true});}
      if(a==='testKeys'){const c=await readConfig(own);let bv=false,rv=false,pv=false;
        if(c.botdog_api_key)bv=await testOne(async()=>{const r=await fetch('https://api.botdog.co/v1/campaigns',{headers:{'x-api-key':c.botdog_api_key}});return r.status>=200&&r.status<300;});
        if(c.resend_api_key)rv=await testOne(async()=>{const r=await fetch('https://api.resend.com/domains',{headers:{Authorization:'Bearer '+c.resend_api_key}});return r.status>=200&&r.status<300;});
        if(c.pappers_api_key)pv=await testOne(async()=>{const r=await fetch('https://api.pappers.fr/v2/recherche?api_token='+enc(c.pappers_api_key)+'&q=a&par_page=1');return r.status!==401&&r.status!==403&&r.status<500;});
        const now=new Date().toISOString();await writeConfig(own,{botdog_valid:bv,resend_valid:rv,pappers_valid:pv,keys_tested_at:now});
        return json({ok:true,tested:true,botdog_set:!!c.botdog_api_key,resend_set:!!c.resend_api_key,pappers_set:!!c.pappers_api_key,botdog_valid:bv,resend_valid:rv,pappers_valid:pv,tested_at:now});}
      if(a==='pushBridges'){const c=await readConfig(own);const key=c.botdog_api_key;const campaign=p.campaign_id||c.botdog_bridges_campaign_id;if(!key)return json({ok:false,error:'no botdog key in config'},200);if(!campaign)return json({ok:false,error:'no bridges campaign'},200);const rows=await sb(`bridges?owner_key=eq.${enc(own)}&linkedin_url=ilike.*linkedin.com/in/*&botdog_pushed=is.null&select=urn,name,title,linkedin_url,connection&limit=200`);const todo=(rows||[]).filter((b:any)=>!/1st/i.test(b.connection||'')).slice(0,p.cap||50);let pushed=0;const errs:string[]=[];for(const b of todo){const res=await botdogAdd(key,campaign,{linkedin_url:b.linkedin_url,name:b.name,title:b.title});if(res.skip)continue;if(res.ok){await sb(`bridges?owner_key=eq.${enc(own)}&urn=eq.${enc(b.urn)}`,{method:'PATCH',body:JSON.stringify({botdog_pushed:new Date().toISOString()}),prefer:'return=minimal'});pushed++;}else{errs.push(b.urn+':'+res.status+':'+res.body);}}return json({ok:true,pushed,attempted:todo.length,campaign,errors:errs.slice(0,12)});}
      if(a==='pushTargets'){
        const r=await pushTargetsFor(own,Math.min(Math.max(parseInt(String(p.cap||100),10)||100,1),400),p.campaign_id);
        return json(r.ok?{ok:true,pushed:r.pushed,attempted:r.attempted,remaining:r.remaining,campaign:r.campaign,errors:r.errors}:{ok:false,error:r.error},200);
      }
      if(a==='pushTargetsAll'){
        const cap=Math.min(Math.max(parseInt(String(p.cap||100),10)||100,1),400);
        const cfg=await sb(`config?key=eq.botdog_api_key&select=owner_key,value`);
        const owners=(cfg||[]).filter((r:any)=>r.value).map((r:any)=>r.owner_key);
        const out=[];
        for(const o of owners){try{out.push(await pushTargetsFor(o,cap));}catch(e){out.push({owner:o,ok:false,error:String((e as Error).message||e),pushed:0,attempted:0});}}
        const total=out.reduce((n:number,r:any)=>n+(r.pushed||0),0);
        try{await sb('activity_log',{method:'POST',body:JSON.stringify([{owner_key:SOLO_OWNER,action:'botdog_push',detail:{total,owners:out}}]),prefer:'return=minimal'});}catch(_){}
        return json({ok:true,owners:owners.length,pushed:total,results:out});
      }
      if(a==='inviteUser'){const lu=String(p.linkedin_url||'').split('?')[0];if(!/linkedin\.com\/in\//i.test(lu))return json({ok:false,error:'need a linkedin.com/in/ URL'},400);const existing=await sb(`users?linkedin_url=eq.${enc(lu)}&select=id,display_name`);if(existing&&existing.length)return json({ok:true,saved:true,already:true,user:existing[0]});const row={owner_key:randKey(),email:(p.email||'').toLowerCase()||null,linkedin_url:lu,display_name:p.display_name||p.name||null,is_admin:false,created_at:new Date().toISOString()};const res=await sb('users',{method:'POST',body:JSON.stringify([row]),prefer:'return=representation'});return json({saved:true,ok:true,user:Array.isArray(res)?res[0]:res});}
      if(a==='logLogin'){try{await sb('activity_log',{method:'POST',body:JSON.stringify([{owner_key:own,action:'login',detail:{email:p.email,name:p.name}}]),prefer:'return=minimal'});}catch(_){}return json({saved:true,ok:true});}
      if(a==='feedback'){try{await sb('activity_log',{method:'POST',body:JSON.stringify([{owner_key:own,action:'feedback',detail:{type:p.type,body:p.body,page:p.page}}]),prefer:'return=minimal'});}catch(_){}return json({saved:true,ok:true});}
      if(a==='pushLog'){try{await sb('activity_log',{method:'POST',body:JSON.stringify([{owner_key:own,action:'sync_log',detail:{log:(p.log||[]).slice(0,150)}}]),prefer:'return=minimal'});}catch(_){}return json({saved:true,ok:true});}
      if(a==='clearDiscoverPending'){const names=p.names||[];if(names.length){const list=names.map((n:string)=>`"${String(n).replace(/"/g,'')}"`).join(',');await sb(`sources?owner_key=eq.${enc(own)}&name=in.(${enc(list)})`,{method:'PATCH',body:JSON.stringify({discover_pending:false,discovered:true}),prefer:'return=minimal'});}return json({saved:true,ok:true});}
      return json({ok:false,error:'unknown action '+a},400);
    }
    return json({ok:false,error:'method not allowed'},405);
  }catch(e){return json({ok:false,error:String((e as Error).message||e)},500);}
});
