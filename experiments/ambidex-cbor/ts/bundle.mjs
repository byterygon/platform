import { buildSync } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const profiles={json:'export {parseJSON,jsonBytes} from "./codec.mjs";export {encodeTyped,decodeTyped} from "./semantic.mjs";',dual:'export * from "./codec.mjs";export * from "./semantic.mjs";'};
const rows=[];for(const[name,contents]of Object.entries(profiles)){const r=buildSync({stdin:{contents,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,minify:true,format:'esm',platform:'browser',write:false});const bytes=r.outputFiles[0].contents;rows.push({name,minifiedBytes:bytes.length,gzipBytes:gzipSync(bytes).length});}writeFileSync(new URL('../results/bundle.json',import.meta.url),JSON.stringify({caveat:'Both typed profiles currently retain codec switching; delta is not production package delta.',rows},null,2));
