import { createHash } from 'node:crypto';
import { encode, decode, parseJSON } from './codec.mjs';
import { convert } from './semantic.mjs';
export const hash=(domain,bytes)=>'sha256:'+createHash('sha256').update(domain+'\0').update(bytes).digest('hex');
export const digest=(value,schema)=>hash('ambidex.input-digest.v2',encode(convert(value,schema,true,'cbor')));
export async function dispatch({bytes,codec,schema,session,access,authorize,handler,logInput=false,redact=[]}){
 const events=[];const raw=codec==='cbor'?decode(bytes):parseJSON(bytes);events.push('bounded-syntax');
 if(!session?.principal)throw new Error('Unauthenticated');events.push('authenticated-session');
 if(!await access(session)){events.push('access-denied');return {error:'PermissionDenied',events};}events.push('access-gate');
 const typed=convert(raw,schema,false,codec);events.push('hydrate');const inputDigest=digest(typed,schema);events.push('digest-v2');
 const binding={version:2,procedure:'fixture.edit',principal:session.principal,target:session.target,context:session.context,inputDigest};
 if(!await authorize(binding))return {error:'PermissionDenied',events};events.push('bound-authorization');
 const log=logInput?convert(typed,schema,true,'json'):null;if(log)for(const key of redact)if(Object.hasOwn(log,key))log[key]='<redacted>';events.push('redact-log');
 const result=await handler(typed);events.push('typed-dispatch');return {result,inputDigest,log,events};
}
export function negotiate(client,server){const offered=client.codecs??['json-v1'],available=server.codecs??['json-v1'];const codec=offered.find(x=>available.includes(x));if(!codec||client.losslessRequired&&codec==='json-v1')throw new Error('unsupported codec');return Object.freeze({codec,callZeroCodec:'json-v1',replay:false});}
export const mutationDecodeFailure=()=>({code:'Unavailable',local:true,retryable:false,message:'outcome unknown: mutation result could not be decoded'});
