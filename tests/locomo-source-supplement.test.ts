import test from 'node:test';
import assert from 'node:assert/strict';
import { supplementSources } from '../scripts/locomo-source-supplement';
import { DEFAULT_RETRIEVAL_POLICY } from '../src/lib/retrieval';
import type { Evidence, RecordEntry } from '../src/lib/types';
const record = (n:number):RecordEntry => ({id:`r${n}`,scope:'s',question:`Q${n}`,answer:`A${n}`,context:'[]',createdAt:new Date(2024,0,n).toISOString()});
function evidence(sources:string[][]):Evidence {
  const first=sources.map((sourceIds,i)=>({id:`m${i}`,scope:'s',space:'e',summary:`S${i}`,status:'hot' as const,
    sourceIds,parentIds:[],reason:'',createdAt:'2024-01-01',score:1-i/100}));
  return {first,second:[],records:[],strategy:'expand',context:first.map((h,i)=>({id:h.id,date:h.createdAt,content:h.summary,
    citation:i+1,kind:'summary',sourceCount:h.sourceIds.length,truncated:false})),
    trace:{expanded:false,reason:'budget-exhausted',firstCandidates:100,minScore:0.45,policy:DEFAULT_RETRIEVAL_POLICY,
      usage:{records:first.length,chars:0,estimatedTokens:0,truncatedRecords:0}}};
}
test('ordered seeds take four recent candidates each; duplicate originals do not consume the global eight slots',()=>{
 const input=evidence([['r1','r2','r3','r4','r13'],['r2','r3','r5','r6'],['r7','r8','r9'],['r10'],['r11']]);
 const old=structuredClone(input);
 const result=supplementSources(input,Array.from({length:13},(_,i)=>record(i+1)));
 assert.deepEqual(result.selected.map(x=>x.recordId),['r13','r4','r3','r2','r6','r5','r9','r8']);
 assert.equal(result.duplicateCandidates,2);
 assert.equal(new Set(result.selected.map(x=>x.recordId)).size,8);
 assert.deepEqual(result.context.slice(0,input.context.length),old.context);
 assert.deepEqual(input,old);
});
test('never takes sources from seed five and obeys shared length/token budget',()=>{
 const input=evidence([['r1'],['r1'],['r1'],['r1'],['r2']]);
 assert.deepEqual(supplementSources(input,[record(1),record(2)]).selected.map(x=>x.recordId),['r1']);
 const limited=evidence([['r1']]);
 limited.trace.policy={...DEFAULT_RETRIEVAL_POLICY,maxContextChars:600,maxEstimatedTokens:250,maxRecordChars:500};
 const result=supplementSources(limited,[{...record(1),answer:'Long original '.repeat(1000)}]);
 assert.ok(result.usage.chars<=600); assert.ok(result.usage.estimatedTokens<=250);
 assert.equal(result.addedOriginals.length,1); assert.equal(result.addedOriginals[0].truncated,true);
});
