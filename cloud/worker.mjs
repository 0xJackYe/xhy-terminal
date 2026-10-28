import {handleAuth,isAuthenticated,assertSameOrigin} from './auth.mjs';
import {handleDiet} from './diet.mjs';
import {handleFinance,syncFinance,getFinanceSnapshot} from './finance.mjs';
import {handleMarket,syncMarket} from './market.mjs';
import {handleMail,enqueueAlertMail,processMailQueue} from './mail.mjs';
import {buildOverview} from './overview.mjs';
import {diagnoseProviders,diagnoseReadOnlyAccounts} from './diagnostics.mjs';
import {handleAnnualized,syncCapitalAccounts} from './annualized.mjs';
import {handleTravel} from './flights.mjs';
import {walletTemplate,walletCore,catalog,buildCommit} from './generated.mjs';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function protect(response){const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('X-Frame-Options','SAMEORIGIN');return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}
function withoutPrefix(request,prefix){const url=new URL(request.url);url.pathname=url.pathname.slice(prefix.length)||'/';const headers=new Headers(request.headers);headers.delete('oai-authenticated-user-id');return new Request(url,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:request.body,duplex:'half'}:{})});}
async function newAlerts(env,events){if(events?.length)await enqueueAlertMail(env,events);}
async function fetchHandler(request,env,ctx){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/api/health'&&request.method==='GET')return json({app:'xhy-terminal',version:2,cloud:true,timezone:'Asia/Shanghai',build:buildCommit});
 const auth=await handleAuth(request,env);if(auth)return auth;
 if(!await isAuthenticated(request,env)){if(path.includes('/api/')||path.endsWith('.json'))return json({error:'请先登录个人终端。',code:'AUTH_REQUIRED'},401);return new Response(null,{status:302,headers:{Location:'/auth/login?returnTo='+encodeURIComponent(path+url.search),'Cache-Control':'no-store'}});}
 if(!['GET','HEAD'].includes(request.method)&&!assertSameOrigin(request))return json({error:'请求来源无效。'},403);
 if(Number(request.headers.get('Content-Length')||0)>1000000)return json({error:'请求内容过大。'},413);
 const context={waitUntil:p=>ctx.waitUntil(p),onMarketAlerts:events=>newAlerts(env,events)};
 if(path==='/api/cloud-diagnostics')return request.method==='GET'?json({public:await diagnoseProviders(),accounts:await diagnoseReadOnlyAccounts(env),sync:await getFinanceSnapshot(env,'sync_status')}):json({error:'只支持读取。'},405);
 if(path==='/api/overview'){if(request.method!=='GET')return json({error:'此接口只支持读取。'},405);return json(await buildOverview(env,context));}
 if(path==='/api/services/ensure')return request.method==='POST'?json({started:false,cloud:true}):json({error:'不支持此操作。'},405);
 if(path.startsWith('/api/travel/'))return await handleTravel(request,env);
 if(path==='/diet'||path.startsWith('/diet/'))return await handleDiet(request,env,{owner:'terminal-owner',catalog});
 if(path==='/btc'||path==='/btc/options.html')return new Response(null,{status:308,headers:{Location:'/btc/'+(path.endsWith('options.html')?'#alerts':'')}});
 if(path.startsWith('/btc/api/')){const sub=withoutPrefix(request,'/btc');return await handleAnnualized(sub,env,context)||await handleMail(sub,env,context)||await handleMarket(sub,env,context)||await handleFinance(sub,env,context)||json({error:'接口不存在。'},404);}
 if(path==='/btc/wallet.html'){
   if(!['GET','HEAD'].includes(request.method))return json({error:'只支持读取。'},405);
   const snapshot=await getFinanceSnapshot(env,'chain_snapshot');if(!snapshot)return json({error:'链上快照正在恢复。'},503);
   const html=walletTemplate.replace('/* __BALANCE_CORE__ */',()=>walletCore).replace('__SNAPSHOT_JSON__',()=>JSON.stringify(snapshot).replace(/</g,'\\u003c'));
   return new Response(request.method==='HEAD'?null:html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 }
 if(!['GET','HEAD'].includes(request.method))return json({error:'此路径不支持写入。'},405);
 if(path.startsWith('/configs/')||path.startsWith('/cloud/')||path.includes('/.'))return json({error:'页面不存在。'},404);
 return env.ASSETS.fetch(request);
}
export default {
 async fetch(request,env,ctx){try{return protect(await fetchHandler(request,env,ctx));}catch{return protect(json({error:'云端服务暂时不可用，请稍后重试。'},503));}},
 async scheduled(event,env,ctx){ctx.waitUntil((async()=>{
   const market=await syncMarket(env).catch(()=>null);await newAlerts(env,market?.newAlerts).catch(()=>{});
   await syncFinance(env).catch(()=>{});await syncCapitalAccounts(env).catch(()=>{});await processMailQueue(env).catch(()=>{});
   if(new Date(event.scheduledTime||Date.now()).getUTCMinutes()%30===0)await env.DB.prepare('DELETE FROM auth_attempts WHERE window_ms<?').bind(Date.now()-86400000).run();
 })());}
};
