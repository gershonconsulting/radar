// ext 1.18.3: ICP links that only restrict to the user's own saved leads / groups must not reach the bridge search.
const assert=require('assert');const fs=require('fs');const path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','salesnav-radar-extension','sync-core.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');assert(i>=0,n);let d=0;for(let k=src.indexOf('{',i);k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'&&!--d)return src.slice(i,k+1);}};
const f=new Function(grab('splitTopLevel')+';'+grab('icpFiltersFromTemplate')+';return icpFiltersFromTemplate;')();
const U=q=>'https://www.linkedin.com/sales/search/people?query='+encodeURIComponent(q);
// Valos/Altavia 09-22 link: saved leads only -> not an ICP (falls back to default)
assert.equal(f(U('(filters:List((type:SAVED_LEADS_AND_ACCOUNTS,values:List((id:SL,selectionType:INCLUDED)))))')),null);
// GROUP and an INCLUDED lead list are dropped, EXCLUDED lead list and real filters kept
const r=f(U('(filters:List((type:REGION,values:List((id:103644278,selectionType:INCLUDED))),(type:GROUP,values:List((id:59930,selectionType:INCLUDED))),(type:LEAD_LIST,values:List((id:1,selectionType:INCLUDED))),(type:LEAD_LIST,values:List((id:2,selectionType:EXCLUDED))),(type:RELATIONSHIP,values:List((id:S,selectionType:INCLUDED)))))'));
assert.deepEqual(r.kept,['REGION','LEAD_LIST']); assert.equal(r.dropped,3);
assert(!/GROUP|id:1,/.test(r.filters));
// normal ICP untouched
const n=f(U('(filters:List((type:SENIORITY_LEVEL,values:List((id:310,selectionType:INCLUDED))),(type:INDUSTRY,values:List((id:15,selectionType:INCLUDED)))))'));
assert.deepEqual(n.kept,['SENIORITY_LEVEL','INDUSTRY']); assert.equal(n.dropped,0);
console.log('icp-template ok');
