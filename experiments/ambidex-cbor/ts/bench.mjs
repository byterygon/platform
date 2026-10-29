import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { encodeTyped,decodeTyped } from './semantic.mjs';
export const workloads = [
 ['ExecuteSummary',{type:'object',fields:{affected:'u64',duration:'u64',message:'string'}},{affected:42n,duration:123456n,message:'complete'}],
 ['metadata-500',{type:'array',items:{type:'object',fields:{name:'string',rows:'u64'}}},Array.from({length:500},(_,i)=>({name:'table_'+i,rows:BigInt(i*1000)}))],
 ['mutation-20',{type:'object',fields:Object.fromEntries(Array.from({length:20},(_,i)=>['f'+i,'i64']))},Object.fromEntries(Array.from({length:20},(_,i)=>['f'+i,BigInt(i)]))],
 ['edited-grid',{type:'array',items:{type:'object',fields:{id:'u64',amount:'decimal',at:'instant',local:'local'}}},Array.from({length:100},(_,i)=>({id:BigInt(i),amount:'123456.2300',at:'2026-10-29T12:34:56.123456789Z',local:'2026-10-29T12:34:56.123456789'}))]
];
export function measure(iterations=200){const raw=[];for(const[name,schema,value]of workloads)for(const codec of ['json','cbor']){for(let i=0;i<50;i++)decodeTyped(encodeTyped(value,schema,codec),schema,codec);for(let trial=0;trial<5;trial++){const samples=[];for(let i=0;i<iterations;i++){const start=performance.now();decodeTyped(encodeTyped(value,schema,codec),schema,codec);samples.push(performance.now()-start);}raw.push({name,codec,trial,bytes:encodeTyped(value,schema,codec).length,samplesMs:samples});}}return raw;}
if(process.argv[1]?.endsWith('/bench.mjs')){const results=measure();writeFileSync(new URL('../results/node-bench.json',import.meta.url),JSON.stringify({environment:{os:os.platform(),release:os.release(),architecture:os.arch(),cpu:os.cpus()[0].model,node:process.version,rss:process.memoryUsage().rss},measurement:'validated in-process encode/decode, no network; synthetic scenario fixtures',results},null,2));}
