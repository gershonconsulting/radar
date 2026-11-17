// Radar — health-check edge function.
// Server-side collection monitor: emails when Radar has stopped collecting (the Chrome
// extension is disconnected / broken / browser closed). Runs on a daily cron, independent of
// the extension — because a broken extension can't alert about itself. Sends ONLY when something
// is wrong (no noise on healthy days). Triggered by POST { secret } or GET ?secret=.
//
// 2026-09-04: the alert recipient is now configurable. If config.health_alert_email is set
// (owner-scoped first, then the global owner key), the alert goes there instead of the user's
// own login address. Olivier moved this alert onto report@gershonconsulting.com.
//
// 2026-10-22 (repo copy of deployed v3): sender display name "Radar" -> "GC Radar Report"
// (Olivier's GC-prefix rule). Address, reply-to, recipients and subject unchanged.
// 2026-10-27: house style - white header with red #FE1B04 title/rule instead of white-on-red; 680px; links #1f6f5c.
// 2026-10-28: sender display name "GC Radar Report" -> "GC Radar" (GC-prefix rule, same as daily-report v8).
// 2026-11-17 (v4): weekends are not outages. The extension only collects Mon-Fri (sync-core.js WORK_DAYS),
//  so the 36 h threshold now counts WORKING hours only: time on Sat/Sun (America/New_York) is excluded.
//  Friday-evening capture -> Monday 06:00 UTC check = ~7 working hours = healthy (it fired on 11-16).
//  A weekday gap of more than 36 working hours still alerts. ?dry=1 (or {dry:true}) reports what it
//  would send without sending email or writing health_alert_at; dry runs accept ?now=ISO to simulate a clock.
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = 'radar_7Kq3mZ9pX2vL8nT';
const GLOBAL_OWNER_KEY = 'xTVW0K1qKi';
const FROM = 'GC Radar <radar@gershon.ai>';
const STALE_HOURS = 36;      // no capture in this many WORKING hours (Mon-Fri ET; with bridges present) => alert
const REALERT_HOURS = 20;    // don't re-alert the same owner more often than this
const TZ = 'America/New_York';
const H = 3600000;
// Offset (local - UTC, ms) of America/New_York at instant ms.
function tzOffsetMs(ms:number){const p:Record<string,string>={};for(const x of new Intl.DateTimeFormat('en-US',{timeZone:TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(ms)))p[x.type]=x.value;return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(ms/1000)*1000;}
// ET calendar day of ms as [y,m,d] plus weekday (0 = Sun).
function etDay(ms:number){const l=new Date(ms+tzOffsetMs(ms));return{y:l.getUTCFullYear(),m:l.getUTCMonth(),d:l.getUTCDate(),wd:l.getUTCDay()};}
// UTC instant of ET midnight starting day (y,m,d) - DST-safe.
function etMidnight(y:number,m:number,d:number){const g=Date.UTC(y,m,d);let t=g-tzOffsetMs(g);t=g-tzOffsetMs(t);return t;}
// Hours between fromMs and toMs that fall on Mon-Fri in America/New_York (Sat/Sun excluded).
export function workingHoursBetween(fromMs:number,toMs:number):number{
  if(!(toMs>fromMs))return 0;
  if(toMs-fromMs>400*24*H)return Infinity; // far beyond any threshold
  let t=fromMs,ms=0;
  while(t<toMs){const e=etDay(t);const next=etMidnight(e.y,e.m,e.d+1);const end=Math.min(next>t?next:t+H,toMs);if(e.wd!==0&&e.wd!==6)ms+=end-t;t=end;}
  return ms/H;
}
// The alert decision for one owner: stale only when the last capture is more than STALE_HOURS working hours ago.
export function isStale(lastIso:string|null,nowMs:number,threshold=STALE_HOURS){if(!lastIso)return true;const l=new Date(lastIso).getTime();if(isNaN(l))return true;return workingHoursBetween(l,nowMs)>=threshold;}
const CORS = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type' };
const enc = encodeURIComponent;
function json(o:unknown,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...CORS,'Content-Type':'application/json'}});}
async function sb(path:string,opts:any={}){const r=await fetch(`${SB_URL}/rest/v1/${path}`,{...opts,headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json',Prefer:opts.prefer||'return=representation',...(opts.headers||{})}});const t=await r.text();let b:any=null;try{b=t?JSON.parse(t):null;}catch{b=t;}if(!r.ok)throw new Error(`sb ${r.status}: ${String(t).slice(0,150)}`);return b;}
async function count(table:string,filters:string[]){const r=await fetch(`${SB_URL}/rest/v1/${table}?${filters.join('&')}`,{method:'GET',headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,Prefer:'count=exact',Range:'0-0','Range-Unit':'items'}});const cr=r.headers.get('content-range')||'';const n=parseInt((cr.split('/')[1]||'0'),10);return isNaN(n)?0:n;}
async function loadResendKey(){const env=Deno.env.get('RESEND_API_KEY');if(env)return env;try{const a=await sb(`config?key=eq.resend_api_key&owner_key=eq.${enc(GLOBAL_OWNER_KEY)}&select=value&limit=1`);if(a&&a.length&&a[0].value)return a[0].value;}catch(_){}try{const a=await sb(`config?key=eq.resend_api_key&select=value&limit=1`);if(a&&a.length&&a[0].value)return a[0].value;}catch(_){}return null;}
async function lastAlertAt(o:string){try{const r=await sb(`config?key=eq.health_alert_at&owner_key=eq.${enc(o)}&select=value&limit=1`);return r&&r.length?r[0].value:null;}catch(_){return null;}}
async function setAlertAt(o:string,iso:string){try{await sb('config?on_conflict=owner_key,key',{method:'POST',body:JSON.stringify([{owner_key:o,key:'health_alert_at',value:iso,updated_at:iso}]),prefer:'resolution=merge-duplicates,return=minimal'});}catch(_){}}
// Configured alert recipient: owner-scoped health_alert_email, else the global one, else null.
async function alertEmailFor(o:string){try{const r=await sb(`config?key=eq.health_alert_email&owner_key=eq.${enc(o)}&select=value&limit=1`);if(r&&r.length&&r[0].value)return String(r[0].value).trim();}catch(_){}try{const g=await sb(`config?key=eq.health_alert_email&owner_key=eq.${enc(GLOBAL_OWNER_KEY)}&select=value&limit=1`);if(g&&g.length&&g[0].value)return String(g[0].value).trim();}catch(_){}return null;}
function alertHtml(name:string,daysTxt:string,lastTxt:string){return `<!doctype html><html><body style="margin:0;background:#ffffff;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center" style="padding:24px 12px;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#fff;"><tr><td style="background:#ffffff;border-top:4px solid #FE1B04;border-bottom:1px solid #e2e8f0;padding:20px 24px 16px;color:#FE1B04;font-size:20px;font-weight:700;">⚠️ Radar has stopped collecting</td></tr><tr><td style="padding:22px 24px;color:#12211d;font-size:15px;line-height:1.6;"><p style="margin:0 0 12px;">Hi ${name||'there'},</p><p style="margin:0 0 12px;">Radar hasn't collected any new prospects ${daysTxt}. Your last capture was <strong>${lastTxt}</strong>.</p><p style="margin:0 0 12px;">Radar collects through its Chrome extension, so this almost always means one of:</p><ul style="margin:0 0 12px;padding-left:20px;"><li>Your Chrome browser hasn't been open, or</li><li>The Radar extension is disabled / needs reloading, or</li><li>You're signed out of LinkedIn Sales Navigator in that browser.</li></ul><p style="margin:0 0 16px;"><strong>Fix in 1 minute:</strong> open <code>chrome://extensions</code>, make sure “Radar — Sales Nav Collector” is enabled, click <strong>Reload</strong>, then open the Radar popup and hit <strong>Sync Now</strong>.</p><div style="text-align:center;margin:8px 0;"><a href="https://radar.gershoncrm.com/app.html" style="display:inline-block;background:#ffffff;color:#1f6f5c;border:2px solid #1f6f5c;text-decoration:none;font-weight:700;padding:10px 24px;border-radius:9px;">Open Radar</a></div></td></tr><tr><td style="padding:16px 24px 22px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">You're getting this because Radar detected a collection gap. Reply to <a href="mailto:support@gershonconsulting.com" style="color:#1f6f5c;text-decoration:underline;">support@gershonconsulting.com</a> if you need help.</td></tr></table></td></tr></table></body></html>`;}
async function send(key:string,to:string,subject:string,html:string){const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from:FROM,to:[to],reply_to:'support@gershonconsulting.com',subject,html})});if(!r.ok)throw new Error('resend '+r.status+': '+(await r.text()).slice(0,120));}
Deno.serve(async (req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:CORS});
  let provided:string|null=null;
  let dry=['1','true'].includes(new URL(req.url).searchParams.get('dry')||'');
  if(req.method==='GET')provided=new URL(req.url).searchParams.get('secret');
  else if(req.method==='POST'){try{const b=await req.json();provided=b?.secret??null;if(b?.dry===true||b?.dry===1||b?.dry==='1')dry=true;}catch(_){provided=null;}if(!provided)provided=new URL(req.url).searchParams.get('secret');}
  if(provided!==CRON_SECRET)return json({ok:false,error:'unauthorized'},401);
  const resendKey=dry?null:await loadResendKey();if(!dry&&!resendKey)return json({ok:false,error:'no resend key'},200);
  let users:any[];try{users=await sb(`users?select=owner_key,email,display_name,is_admin,status&email=not.is.null&or=(status.eq.active,is_admin.eq.true)`);}catch(e){return json({ok:false,error:'load users: '+String(e)},200);}
  // Dry runs may simulate another clock (?now=ISO) to check e.g. the Monday 06:00 UTC run; never used when sending.
  const nowParam=dry?new URL(req.url).searchParams.get('now'):null;
  const now=nowParam&&!isNaN(Date.parse(nowParam))?Date.parse(nowParam):Date.now();const sent:string[]=[];const skipped:string[]=[];const errors:any[]=[];const would:any[]=[];
  for(const u of users){const own=u.owner_key;if(!own||!u.email)continue;
    // Only alert users who have set up collection (≥1 bridge or source).
    const bridges=await count('bridges',[`owner_key=eq.${enc(own)}`]);
    const sources=await count('sources',[`owner_key=eq.${enc(own)}`]);
    if(bridges===0&&sources===0){skipped.push(u.email+':not-setup');continue;}
    // Last capture.
    let last:string|null=null;try{const rows=await sb(`targets?owner_key=eq.${enc(own)}&select=collected_date&order=collected_date.desc.nullslast&limit=1`);last=rows&&rows.length?rows[0].collected_date:null;}catch(_){}
    const lastMs=last?new Date(last).getTime():0;
    const hrs=lastMs?workingHoursBetween(lastMs,now):Infinity;   // working hours (Mon-Fri ET) since last capture
    if(!isStale(last,now)){skipped.push(u.email+':healthy');continue;}
    // Re-alert throttle.
    const la=await lastAlertAt(own);if(la&&(now-new Date(la).getTime())/3600000<REALERT_HOURS){skipped.push(u.email+':recently-alerted');continue;}
    const days=hrs===Infinity?null:Math.floor(hrs/24);
    const daysTxt=days===null?'yet':(days>=1?`in ${days} working day${days>1?'s':''}`:`in over ${Math.round(hrs)} working hours`);
    const lastTxt=last?new Date(last).toISOString().slice(0,10):'never';
    const to=(await alertEmailFor(own))||u.email;
    if(dry){would.push({to,last:lastTxt,working_hours:hrs===Infinity?null:Math.round(hrs*10)/10});continue;}
    try{await send(resendKey!,to,'⚠️ Radar has stopped collecting — check your Chrome extension',alertHtml(u.display_name||'',daysTxt,lastTxt));await setAlertAt(own,new Date().toISOString());sent.push(to);}catch(e){errors.push({email:to,error:String(e)});}
  }
  return json({ok:true,version:'v4-working-hours',dry,now:new Date(now).toISOString(),checked:users.length,sent:sent.length,recipients:sent,would_send:dry?would:undefined,skipped,errors});
});
