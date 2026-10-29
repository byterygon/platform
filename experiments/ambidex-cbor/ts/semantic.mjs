import { Tag, encode, decode, parseJSON, jsonBytes } from './codec.mjs';
import { exact, checked } from './integers.mjs';
export function decimal(text) {
 if(typeof text!=='string'||text.length>1100)throw new RangeError('decimal length');
 const m=/^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:e(-?(?:0|[1-9][0-9]*)))?$/.exec(text);
 if(!m)throw new RangeError('decimal syntax');
 const digits=m[2]+(m[3]??''), precision=digits.replace(/^0+/,'').length||1;
 if(precision>38||m[4]?.length>5)throw new RangeError('decimal precision');
 const scale=(m[3]?.length??0)-Number(m[4]??0);
 if(Math.abs(scale)>1000)throw new RangeError('decimal scale');
 return {coefficient:BigInt(m[1]+digits),scale};
}
export function decimalText({coefficient,scale}) {
 // Exponent text preserves negative scale and avoids unbounded zero expansion.
 if(scale<0)return `${coefficient}e${-scale}`;
 const sign=coefficient<0n?'-':'', digits=(coefficient<0n?-coefficient:coefficient).toString().padStart(scale+1,'0');
 return sign+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);
}
function mantissa(n) {
 if(n>=-18446744073709551616n && n<=18446744073709551615n)return n;
 const neg=n<0n;let x=neg?-1n-n:n, a=[];while(x){a.unshift(Number(x&255n));x>>=8n;}return new Tag(neg?3:2,Uint8Array.from(a));
}
function coefficient(v){if(typeof v==='bigint')return v;if(v instanceof Tag&&[2,3].includes(v.tag)){let n=0n;for(const b of v.value)n=n*256n+BigInt(b);return v.tag===3?-1n-n:n;}throw new RangeError('mantissa');}
export function temporal(text,kind) {
 if(typeof text!=='string'||text.length>64)throw new RangeError('temporal');
 const date=/^(\d{4})-(\d{2})-(\d{2})$/;
 const time=/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
 const validDate=s=>{const m=date.exec(s);if(!m)return false;const y=+m[1],mo=+m[2],d=+m[3];return mo>=1&&mo<=12&&d>=1&&d<=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][mo-1];};
 const validTime=s=>{const m=time.exec(s);return m&&+m[1]<24&&+m[2]<60&&+m[3]<60;};
 if(kind==='date'){if(!validDate(text))throw new RangeError('date');return text;}
 if(kind==='time'){if(!validTime(text))throw new RangeError('time');return text;}
 if(kind==='duration'){if(!/^-?PT(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?S$/.test(text))throw new RangeError('duration');return text;}
 if(kind==='local'){if(!validDate(text.slice(0,10))||text[10]!=='T'||!validTime(text.slice(11)))throw new RangeError('local datetime');return text;}
 const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.[0-9]{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
 if(!m||!validDate(m[1])||!validTime(m[2]+(m[3]??'')))throw new RangeError('instant');
 if(m[4]!=='Z' && (+m[4].slice(1,3)>23||+m[4].slice(4)>59||m[4]==='-00:00'))throw new RangeError('offset');
 const seconds=new Date(m[1]+'T'+m[2]+m[4]);
 if(!Number.isFinite(seconds.valueOf()))throw new RangeError('instant range');
 const iso=seconds.toISOString();if(!/^\d{4}-/.test(iso))throw new RangeError('instant year');
 return iso.slice(0,19)+(m[3]??'')+'Z';
}
export function convert(value,schema,toWire,codec,profile='bigint') {
 const type=typeof schema==='string'?schema:schema.type;
 if(type==='i64'||type==='u64') {
   if(!toWire && (codec==='cbor'?typeof value!=='bigint':typeof value!=='string'))throw new RangeError('integer wire type');
   let n;if(toWire){if(typeof value==='number'&&!Number.isSafeInteger(value))throw new RangeError('unsafe number');n=exact(String(value),type==='i64');}else{n=exact(String(value),type==='i64');}
   if(toWire)return codec==='cbor'?n:n.toString();
   return profile==='checked'?checked(n.toString(),type==='i64'):n;
 }
 if(type==='decimal'){let d;if(toWire||codec==='json')d=decimal(value);else{if(!(value instanceof Tag)||value.tag!==4)throw new RangeError('decimal tag');d={scale:-Number(value.value[0]),coefficient:coefficient(value.value[1])};d=decimal(decimalText(d));}return toWire&&codec==='cbor'?new Tag(4,[BigInt(-d.scale),mantissa(d.coefficient)]):decimalText(d);}
 if(['instant','date','local','time','duration'].includes(type)){let v=value;if(!toWire&&codec==='cbor'&&['instant','date'].includes(type)){if(!(value instanceof Tag)||value.tag!==(type==='instant'?0:1004))throw new RangeError('temporal tag');v=value.value;}const text=temporal(v,type);return toWire&&codec==='cbor'&&['instant','date'].includes(type)?new Tag(type==='instant'?0:1004,text):text;}
 if(type==='array'){if(!Array.isArray(value))throw new RangeError('array');return value.map(v=>convert(v,schema.items,toWire,codec,profile));}
 if(type==='object'){if(!value||Array.isArray(value)||typeof value!=='object'||value instanceof Tag)throw new RangeError('object');const out=Object.create(null);if(Object.keys(value).some(k=>!Object.hasOwn(schema.fields,k)))throw new RangeError('unknown field');for(const [k,s] of Object.entries(schema.fields)){if(!Object.hasOwn(value,k))throw new RangeError('missing field');out[k]=convert(value[k],s,toWire,codec,profile);}return out;}
 if(type==='string'){if(typeof value!=='string')throw new RangeError('string');return value;}
 if(type==='bool'){if(typeof value!=='boolean')throw new RangeError('bool');return value;}
 if(type==='dynamic'){const walk=v=>{if(v instanceof Tag||v instanceof Uint8Array||typeof v==='bigint'&&(v< -9007199254740991n||v>9007199254740991n)||typeof v==='number'&&(!Number.isSafeInteger(v)))throw new RangeError('dynamic domain');if(typeof v==='bigint')return Number(v);if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object'){const o=Object.create(null);for(const[k,x]of Object.entries(v))o[k]=walk(x);return o;}if(v===undefined)throw new RangeError('undefined');return v;};return walk(value);}
 throw new RangeError('unsupported schema');
}
export function encodeTyped(v,s,c){const wire=convert(v,s,true,c);return c==='cbor'?encode(wire):jsonBytes(wire);}
export function decodeTyped(b,s,c,p='bigint'){return convert(c==='cbor'?decode(b):parseJSON(b),s,false,c,p);}
