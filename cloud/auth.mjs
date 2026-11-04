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
const page=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f6f5f2"><title>XHY · 登录</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23191816'/%3E%3Cpath d='M9 11l5 5-5 5' stroke='%23f2f0eb' stroke-width='2.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='16' y='19.5' width='8' height='2.4' rx='1.2' fill='%23ff7a3d'/%3E%3C/svg%3E"><script>(()=>{let t;try{t=localStorage.getItem('xhy-theme')}catch{}if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;document.querySelector('meta[name="theme-color"]').content=t==='dark'?'#0e0e0d':'#f6f5f2'})();</script><style>
:root{color-scheme:light;--bg:#f6f5f2;--panel:#fff;--line:#e6e3dc;--line-strong:#d6d2c9;--text:#191816;--muted:#5f5c55;--faint:#736f68;--accent:#e0561b;--accent-soft:#fbe7dc;--danger:#b8322a;--danger-soft:#f8e3e0;--shadow:0 1px 2px rgb(25 24 22 / .04),0 20px 48px -24px rgb(25 24 22 / .24);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-synthesis:none}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0e0e0d;--panel:#171715;--line:#262622;--line-strong:#34332f;--text:#f2f0eb;--muted:#b0ada5;--faint:#8c8981;--accent:#ff7a3d;--accent-soft:#3a2116;--danger:#ff8a7d;--danger-soft:#3a1b18;--shadow:0 1px 0 rgb(255 255 255 / .03) inset,0 24px 56px -24px rgb(0 0 0 / .85)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom));background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{width:min(380px,100%);animation:rise .6s cubic-bezier(.22,1,.36,1) both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 18px;color:var(--faint);font-size:12px}
.brand b{display:inline-flex;align-items:center;color:var(--text);font:600 17px/1 "SF Mono","JetBrains Mono","Cascadia Mono",ui-monospace,Menlo,Consolas,monospace;letter-spacing:-.2px}
.brand b span{color:var(--faint);margin-right:1px}
.brand i{width:8px;height:17px;margin-left:3px;border-radius:1.5px;background:var(--accent);animation:caret 1.15s steps(1) infinite}
@keyframes caret{50%{opacity:0}}
.card{padding:28px 24px 24px;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:var(--shadow)}
h1{margin:0;font-size:24px;font-weight:650;letter-spacing:-.5px;line-height:1.25}
.lead{margin:6px 0 0;color:var(--muted)}
label{display:block;margin:22px 0 8px;font-size:13px;font-weight:550}
input{display:block;width:100%;height:46px;margin:0;padding:0 14px;border:1px solid var(--line-strong);border-radius:12px;background:var(--panel);color:var(--text);font:inherit;font-size:16px;outline:none;transition:border-color .18s ease,box-shadow .18s ease}
input:hover{border-color:var(--faint)}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
button{display:flex;align-items:center;justify-content:center;width:100%;height:46px;margin-top:12px;border:0;border-radius:12px;background:var(--text);color:var(--bg);font:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .18s ease,transform .18s cubic-bezier(.22,1,.36,1)}
button:hover:not(:disabled){opacity:.9}
button:active:not(:disabled){transform:scale(.985)}
button:disabled{opacity:.65;cursor:progress}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#message{margin:12px 0 0;padding:9px 12px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-size:13px;line-height:1.5}
#message:empty{margin:0;padding:0;background:none}
.foot{margin:16px 8px 0;color:var(--faint);font-size:12px;line-height:1.6;text-align:center}
@media (prefers-reduced-motion:reduce){main,.brand i{animation:none}}
</style></head><body><main><p class="brand"><b><span aria-hidden="true">~/</span>xhy<i aria-hidden="true"></i></b>个人终端</p><div class="card"><h1>欢迎回来</h1><p class="lead">登录后查看加密资产、价格警报与快速出境。</p><form id="login" method="post" action="/auth/login"><label for="accessKey">个人访问码</label><input id="accessKey" name="accessKey" type="password" autocomplete="current-password" required maxlength="256" autofocus><input id="returnTo" type="hidden" name="returnTo" value="/"><button type="submit">进入终端</button></form><p id="message" role="status"></p></div><p class="foot">访问码只提交给当前网站，不在浏览器中长期保存。</p></main><script>const form=document.querySelector('form'),button=form.querySelector('button'),message=document.querySelector('#message');document.querySelector('#returnTo').value=new URL(location.href).searchParams.get('returnTo')||'/';form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;button.textContent='正在验证…';message.textContent='';try{let response;try{response=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form))),credentials:'same-origin'});}catch{throw new Error('网络连接失败，请稍后重试。');}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'登录暂不可用，请稍后重试。');button.textContent='正在进入…';location.replace(data.redirect||'/');}catch(error){message.textContent=error.message;button.disabled=false;button.textContent='进入终端';form.elements.accessKey.select();}});</script></body></html>`;
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
