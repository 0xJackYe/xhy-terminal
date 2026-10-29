import {toBase64Url,fromBase64Url,sha256Hex,hmacSha256,constantTimeEqual} from './crypto.mjs';
export const AUTH_SCHEMA='CREATE TABLE IF NOT EXISTS auth_attempts (ip_hash TEXT PRIMARY KEY,window_ms INTEGER NOT NULL,attempts INTEGER NOT NULL)';
const COOKIE='__Host-xhy-session',TTL=7*86400000,WINDOW=900000,LIMIT=10;
const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
export function assertSameOrigin(request) {const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');return origin===new URL(request.url).origin&&(!site||['same-origin','none'].includes(site));}
function configured(env){return typeof env.AUTH_SECRET==='string'&&env.AUTH_SECRET.length>=32&&typeof env.OWNER_ACCESS_KEY==='string'&&env.OWNER_ACCESS_KEY.length>=24;}
function returnPath(value) {return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&!/[\\\u0000-\u0020\u007f]/.test(value)&&!value.startsWith('/auth/')?value:'/';}
export async function isAuthenticated(request,env,{now=Date.now()}={}) {
  if(!configured(env))return false;
  const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||token.length>2048)return false;
  try {
    const [v,payload,signature,...extra]=token.split('.');if(v!=='v1'||extra.length||!constantTimeEqual(signature,await hmacSha256(v+'.'+payload,env.AUTH_SECRET)))return false;
    const data=JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return data.owner==='terminal-owner'&&Number.isSafeInteger(data.exp)&&Number.isSafeInteger(data.iat)&&data.iat<=now+5000&&data.exp>now&&data.exp-data.iat===TTL&&constantTimeEqual(data.key,await sha256Hex(env.OWNER_ACCESS_KEY));
  } catch{return false;}
}
const page=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>XHY · 登录</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#f6f5f2,#121211);color:light-dark(#191816,#f6f5f2)}main{width:min(360px,calc(100% - 48px))}h1{font-size:32px;letter-spacing:-1px}p,small{color:light-dark(#65635f,#bcb9b1);line-height:1.6}label{display:block;margin:32px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px 16px;border-radius:9px;font:inherit}input{border:1px solid #888;background:transparent;color:inherit}button{margin-top:14px;border:0;background:light-dark(#191816,#f6f5f2);color:light-dark(#fff,#191816);cursor:pointer}#message{min-height:24px;color:light-dark(#a32929,#ffaaaa)}</style></head><body><main><small>~/xhy · 个人终端</small><h1>欢迎回来。</h1><p>登录后查看饮食日记与账户持仓。</p><form id="login" method="post" action="/auth/login"><label for="accessKey">个人访问码</label><input id="accessKey" name="accessKey" type="password" autocomplete="current-password" required maxlength="256"><input id="returnTo" type="hidden" name="returnTo" value="/"><button type="submit">进入终端</button></form><p id="message" role="status"></p><small>访问码只提交给当前网站，不在浏览器中长期保存。</small></main><script>const form=document.querySelector('form');document.querySelector('#returnTo').value=new URL(location.href).searchParams.get('returnTo')||'/';form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form))),credentials:'same-origin'});const data=await response.json();if(!response.ok)throw new Error(data.error||'登录暂不可用');location.replace(data.redirect||'/');}catch(error){document.querySelector('#message').textContent=error.message;}finally{button.disabled=false;}});</script></body></html>`;
export async function handleAuth(request,env,{now=Date.now()}={}) {
  const url=new URL(request.url);if(!url.pathname.startsWith('/auth/'))return null;
  if(url.pathname==='/auth/status')return request.method==='GET'?json({authenticated:await isAuthenticated(request,env,{now})}):json({error:'不支持此操作。'},405);
  if(url.pathname==='/auth/logout') {if(request.method!=='POST')return json({error:'仅支持POST。'},405);if(!assertSameOrigin(request))return json({error:'请求来源无效。'},403);return json({ok:true},200,{'Set-Cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});}
  if(url.pathname!=='/auth/login')return json({error:'页面不存在。'},404);
  if(!configured(env))return json({error:'云端访问配置尚未就绪。'},503);
  if(request.method==='GET')return new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'}});
  if(request.method!=='POST')return json({error:'不支持此操作。'},405);
  if(!assertSameOrigin(request))return json({error:'请从本站登录。'},403);
  if(Number(request.headers.get('Content-Length')||0)>4096)return json({error:'请求过大。'},413);
  try {
    const raw=await request.text();if(raw.length>4096)return json({error:'请求过大。'},413);
    const input=(request.headers.get('Content-Type')||'').includes('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
    if(typeof input.accessKey!=='string'||input.accessKey.length>256)return json({error:'访问码无效。'},400);
    const hash=await sha256Hex((request.headers.get('CF-Connecting-IP')||'unknown')+':'+env.AUTH_SECRET);
    const row=await env.DB.prepare('SELECT window_ms,attempts FROM auth_attempts WHERE ip_hash=?').bind(hash).first();
    if(row&&now-row.window_ms<WINDOW&&row.attempts>=LIMIT)return json({error:'尝试次数过多，请15分钟后再试。'},429,{'Retry-After':'900'});
    const used=await env.DB.prepare('INSERT INTO auth_attempts(ip_hash,window_ms,attempts) VALUES(?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET window_ms=CASE WHEN ?-window_ms>=? THEN ? ELSE window_ms END,attempts=CASE WHEN ?-window_ms>=? THEN 1 ELSE attempts+1 END RETURNING attempts').bind(hash,now,now,WINDOW,now,now,WINDOW).first();
    if(!used||used.attempts>LIMIT)return json({error:'尝试次数过多，请稍后再试。'},429);
    if(!constantTimeEqual(await sha256Hex(input.accessKey),await sha256Hex(env.OWNER_ACCESS_KEY)))return json({error:'访问码不正确。'},401);
    await env.DB.prepare('DELETE FROM auth_attempts WHERE ip_hash=?').bind(hash).run();
    const payload=toBase64Url(new TextEncoder().encode(JSON.stringify({owner:'terminal-owner',iat:now,exp:now+TTL,key:await sha256Hex(env.OWNER_ACCESS_KEY)})));
    const token='v1.'+payload+'.'+await hmacSha256('v1.'+payload,env.AUTH_SECRET);
    const headers={'Set-Cookie':`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL/1000}`};
    const redirect=returnPath(input.returnTo);
    if((request.headers.get('Content-Type')||'').includes('application/json'))return json({ok:true,redirect},200,headers);
    return new Response(null,{status:303,headers:{...headers,Location:redirect,'Cache-Control':'no-store'}});
  } catch{return json({error:'登录服务暂时不可用。'},503);}
}
