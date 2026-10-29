import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { complete, modelConfig } from '../src/lib/providers';
import { readSSE } from '../src/lib/sse';
import { supplementSources } from './locomo-source-supplement';
import { chargeUsage, remainingAllows, reserveTokens } from './locomo-small-support';
import type { RecordEntry } from '../src/lib/types';

const parentDir=resolve('artifacts/locomo-human-dialogue-conv30-50-v2-20261030');
const out=resolve('artifacts/locomo-top4-sources8-conv30-50-20261030');
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const parentPath=resolve(parentDir,'report.json'),dbPath=resolve(parentDir,'dynamic.sqlite');
const parent=JSON.parse(readFileSync(parentPath,'utf8'));
assert.equal(parent.status,'completed'); assert.equal(parent.results.length,50);
const cfg=modelConfig(); assert.equal(cfg.llmModel,parent.manifest.chatModel);
assert.equal(cfg.llmApiStyle,parent.manifest.apiStyle); assert.equal(cfg.reasoningEffort,parent.manifest.reasoningEffort);
assert.ok(Object.entries(parent.manifest.sourceCode).every(([p,h])=>sha(p)===h),'Core source must match frozen bank');
const sourceHashes={report:sha(parentPath),database:sha(dbPath)};
const db=new DatabaseSync(dbPath,{readOnly:true});
const records:RecordEntry[]=db.prepare('SELECT r.*,s.source_type FROM records r LEFT JOIN record_sources s ON s.record_id=r.id WHERE r.scope=?').all(parent.manifest.sample).map((r:any)=>({
 id:r.id,scope:r.scope,question:r.question,answer:r.answer,context:r.context,createdAt:r.created_at,...(r.source_type==='human-dialogue'?{sourceType:'human-dialogue' as const}:{})}));
db.close(); assert.equal(records.length,47);
const manifest={...parent.manifest,budgetTokens:500000,ingestLimit:0,answerReserve:0,
 sourceCode:{...parent.manifest.sourceCode,...Object.fromEntries(['scripts/locomo-source-supplement.ts','scripts/evaluate-locomo-source-supplement.ts'].map(p=>[p,sha(p)]))},
 frozenSource:{parentDir,...sourceHashes},experiment:{
  method:'Reuse all 50 original fixed questions, exact selected summaries and frozen bank. Add originals from first four selected summaries, each latest four candidates, global ID dedup max eight. Same model/system/max output and shared char/token budgets. No stages or previous-message context added. All prior answers reused as frozen controls; no rebuilding or writeback.',
  firstSummaries:4,candidatesPerSummary:4,maxUniqueOriginals:8,tieBreak:'createdAt DESC, id ASC',
  partialWritesRetained:parent.ingestion.filter((r:any)=>r.action==='partial').length,
  baselineUsageNotChargedAgain:true,
}};
mkdirSync(resolve(out,'responses'),{recursive:true});
const file=resolve(out,'report.json');
const report:any=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{manifest,status:'prepared',requests:[],
 ingestion:parent.ingestion,memories:parent.memories,stats:parent.stats,
 results:parent.results.map((row:any)=>{const supplement=supplementSources(row.dynamic.evidence,records);
  assert.deepEqual(supplement.context.slice(0,row.dynamic.evidence.context.length),row.dynamic.evidence.context);
  assert.ok(supplement.selected.length<=8);
  return {index:row.index,qa:row.qa,baselineDynamic:row.dynamic,raw:row.raw,raw3:row.raw3,
   supplement:{...supplement,addedOriginals:supplement.addedOriginals.map(e=>({id:e.id,truncated:e.truncated,chars:e.content.length}))}};
 })};
assert.deepEqual(report.manifest,manifest,'Resume requires identical frozen source and settings');
assert.ok(!report.requests.some((r:any)=>r.status!=='ok'),'Unresolved call; do not replay unknown charges');
const save=()=>{report.updatedAt=new Date().toISOString();writeFileSync(file+'.tmp',JSON.stringify(report,null,2));renameSync(file+'.tmp',file);};
save();
if(process.env.LOCOMO_PREPARE_ONLY==='true') {
 console.log(JSON.stringify({status:report.status,questions:report.results.length,
  originals:report.results.map((r:any)=>r.supplement.selected.length),
  clippedOriginals:report.results.reduce((n:number,r:any)=>n+r.supplement.addedOriginals.filter((x:any)=>x.truncated).length,0),
  marleyIncluded:report.results.find((r:any)=>r.index===5).supplement.context.some((e:any)=>/Marley/.test(e.content)),
  sourceHashes},null,2));
} else {
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 assert.equal(url.href,`${cfg.llmBase}/responses`,'Only answering endpoint permitted');
 const payload=JSON.parse(String(init?.body)),reserve=reserveTokens(payload);
 assert.ok(remainingAllows(report.requests,reserve,manifest.budgetTokens),'Budget guard: request not sent');
 const metric:any={kind:'chat',phase:'evaluate-dynamic',status:'pending',reserveTokens:reserve,chargedTokens:reserve};
 const index=report.requests.push(metric)-1,started=Date.now();save();
 try {
  const response=await originalFetch(input,init);metric.httpStatus=response.status;
  if(!response.ok||!response.body)throw Error(`Provider HTTP ${response.status}; unknown reservation retained`);
  let data:any;
  for await(const event of readSSE(response.clone().body!)) {
   if(event.data.trim()==='[DONE]')continue;
   const value=JSON.parse(event.data);
   if(['response.completed','response.failed','response.incomplete'].includes(value.type))data=value.response;
  }
  if(!data)throw Error('Terminal response missing; no automatic retry');
  metric.responseFile=`responses/${index}.json`;writeFileSync(resolve(out,metric.responseFile),JSON.stringify(data,null,2));
  assert.ok(chargeUsage(metric,{prompt_tokens:data.usage?.input_tokens,completion_tokens:data.usage?.output_tokens,total_tokens:data.usage?.total_tokens}),'Usage missing; reservation retained');
  assert.equal(data.model,cfg.llmModel);assert.equal(data.status,'completed');metric.status='ok';return response;
 } catch(error) {metric.status='failed';metric.error=error instanceof Error?error.message:'Call failed';throw error;}
 finally {metric.ms=Date.now()-started;save();}
};
async function main(){
 try {
  report.status='running';save();
  for(const row of report.results){
   if(row.dynamic?.answer)continue;
   const started=Date.now();
   const answer=await complete(parent.manifest.answerSystem,[{role:'user',content:JSON.stringify({question:row.qa.question,historicalEvidence:row.supplement.context})}],parent.manifest.answerMaxTokens);
   row.dynamic={answer,evidence:{...row.baselineDynamic.evidence,context:row.supplement.context,
    trace:{...row.baselineDynamic.evidence.trace,usage:row.supplement.usage}},retrievalMs:0,answerMs:Date.now()-started};
   save();console.log(`ANSWER ${report.results.filter((r:any)=>r.dynamic?.answer).length}/50 q${row.index}; tokens=${report.requests.reduce((n:number,r:any)=>n+r.chargedTokens,0)}`);
  }
  assert.equal(sha(parentPath),sourceHashes.report);assert.equal(sha(dbPath),sourceHashes.database);
  report.status='completed';report.sourceFilesUnchanged=true;save();
 } catch(error){report.status='failed';report.error=error instanceof Error?error.message:'Failed';save();throw error;}
 finally {globalThis.fetch=originalFetch;}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Failed');process.exitCode=1;});
}
