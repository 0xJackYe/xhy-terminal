import {readFile,writeFile,mkdir,rm,readdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,relative,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'..'),output=resolve(here,'dist');
if(dirname(output)!==here)throw new Error('Invalid build output');
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
const rootPath=/(["'`])\/(?=(?:api\/(?:terminal|wallet|market|events|focused-market|mark-watch|option-ai|parse-meals|diary-chat|diary|chat|ai-status)(?:[\/?.$"'`])|(?:audio|data|assets)\/|[A-Za-z0-9_.-]+\.(?:html|mjs|js|css|json|svg|png|jpe?g|webp|wav|woff2)(?:[?#/"'`])))/g;
export function rewrite(text,prefix,type){text=text.replace(rootPath,(_,quote)=>quote+prefix+'/');if(type==='.html'){text=text.replace(/(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi,(_,before)=>before+prefix+'/').replaceAll(prefix+prefix+'/',prefix+'/').replace(/(<head(?:\s[^>]*)?>)/i,'$1<script src="/theme-bridge.js" data-xhy-embed></script>');}if(type==='.css')text=text.replace(/(url\(\s*)\/(?!\/)/gi,(_,before)=>before+prefix+'/');return text;}
async function copyDirectory(source,target,prefix=''){
 for(const e of await readdir(source,{withFileTypes:true})){
  const from=resolve(source,e.name),to=resolve(target,e.name);if(e.isDirectory()){await mkdir(to,{recursive:true});await copyDirectory(from,to,prefix);}
  else if(e.isFile()&&/\.(?:html|css|js|mjs|svg|wav|png|woff2|json)$/.test(e.name)){
   if(e.name==='wallet.html'||e.name==='diary.json'||e.name==='diary.example.json')continue;
   await mkdir(dirname(to),{recursive:true});const extension=extname(e.name);
   if(prefix&&['.html','.js','.mjs','.css'].includes(extension))await writeFile(to,rewrite(await readFile(from,'utf8'),prefix,extension));else await copyFile(from,to);
  }
 }
}
await copyDirectory(resolve(root,'frontend'),output);
const portal=resolve(output,'index.html');await writeFile(portal,(await readFile(portal,'utf8')).replace('本机个人终端','云端个人终端'));
await mkdir(resolve(output,'diet/data'),{recursive:true});await copyDirectory(resolve(root,'apps/diet/site'),resolve(output,'diet'),'/diet');
const foods=JSON.parse(await readFile(resolve(root,'apps/diet/data/foods.json'),'utf8'));await writeFile(resolve(output,'diet/data/foods.json'),JSON.stringify(foods));
await mkdir(resolve(output,'btc/audio'),{recursive:true});await copyDirectory(resolve(root,'apps/bitcoin/terminal/dist'),resolve(output,'btc'),'/btc');await copyDirectory(resolve(root,'apps/bitcoin/terminal/audio'),resolve(output,'btc/audio'),'/btc');
let template=await readFile(resolve(root,'apps/bitcoin/terminal/wallet/wallet.template.html'),'utf8');template=rewrite(template,'/btc','.html');
const core=(await readFile(resolve(root,'apps/bitcoin/terminal/wallet/core.mjs'),'utf8')).replace(/^export\s+/gm,'');
const buildCommit=process.env.WORKERS_CI_COMMIT_SHA||process.env.CF_BUILD_COMMIT||process.env.CF_PAGES_COMMIT_SHA||process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
await writeFile(resolve(here,'generated.mjs'),'// Generated only from public source assets; no runtime diary, credentials or wallet snapshot.\nexport const buildCommit='+JSON.stringify(buildCommit)+';\nexport const walletTemplate='+JSON.stringify(template)+';\nexport const walletCore='+JSON.stringify(core)+';\nexport const catalog='+JSON.stringify(foods)+';\n');
await writeFile(resolve(output,'404.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面不存在</title><p>页面不存在。<a href="/">返回终端</a></p></html>');
console.log('Cloud assets built without private runtime data');
