(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.OKXWallet = api;
    const start = () => { if (!root.__okxWalletController) root.__okxWalletController = api.mount({root, document:root.document}); };
    if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, {once:true});
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const REFRESH_MS = 30000, REQUEST_TIMEOUT_MS = 12000;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function timestamp(value) {
    if (typeof value !== 'string' && !finite(value)) return null;
    const number = typeof value === 'string' ? Date.parse(value) : value;
    return finite(number) && number > 0 && number <= 8640000000000000 ? number : null;
  }
  function statusPresentation(state, now = Date.now()) {
    if (!state) return {kind:'waiting',text:'正在读取状态',message:''};
    if (!state.configured) return {kind:'waiting',text:state.pending_credentials ? '待补充 Passphrase' : '尚未连接',message:''};
    const last = timestamp(state.last_success_at), stale = ['error','stale','offline','partial'].includes(state.status) || !!state.error || last !== null && now-last > 90000;
    if (stale) {
      const reasons = {passphrase_invalid:'Passphrase 不匹配，请在连接设置中重新填写创建 API 时设置的密码。',credentials_invalid:'API 凭证校验失败，请检查连接设置。',
        clock_error:'请求时间校验失败，请检查本机时间。',ip_restricted:'当前网络地址不在 API 的 IP 白名单内。',rate_limited:'欧易接口限流，稍后自动重试。',
        read_only_required:'请更换为仅有读取权限的 API，本看板不接受交易或提现权限。',permission_denied:'API 没有读取该账户的权限。',
        access_denied:'欧易拒绝访问，请检查 API、IP 白名单和账户地区。',network_error:'暂时无法连接欧易，请检查网络。',timeout:'欧易查询超时，稍后自动重试。'};
      const reason = Object.prototype.hasOwnProperty.call(reasons,state.error_code) ? reasons[state.error_code] : '';
      return {kind:'stale',text:last === null ? '连接待恢复' : '缓存数据',message:reason + (last === null ? reason ? '' : '欧易账户暂未读取成功。请检查 API 凭证、读取权限与 IP 白名单。' : reason ? ' 目前保留上次快照。' : '本次刷新失败或数据已过期，保留上次快照。')};
    }
    if (state.refreshing || last === null) return {kind:'waiting',text:'正在同步',message:''};
    return {kind:'live',text:'已连接 · 只读',message:''};
  }
  const MARKUP = '<div class="okx-heading"><div class="okx-heading-title"><h2 id="okxTitle">欧易连接</h2><span id="okxState" class="okx-state" role="status">正在读取状态</span></div><div class="okx-actions"><button type="button" id="okxRefresh" class="secondary-button">刷新</button><button type="button" id="okxSettingsButton" class="text-button" aria-expanded="false" aria-controls="okxSettings">连接设置</button></div></div>' +
    '<p id="okxMessage" class="okx-message" role="status" aria-live="polite" hidden></p>' +
    '<div id="okxSettings" class="okx-settings" hidden><form id="okxConfigForm" autocomplete="off"><p id="okxCredentialHelp" class="okx-help"></p><div class="okx-fields"><div id="okxKeyField"><label for="okxApiKey">API Key</label><input id="okxApiKey" name="api_key" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256"></div><div id="okxSecretField"><label for="okxSecretKey">Secret Key</label><input id="okxSecretKey" name="secret_key" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256"></div><div><label for="okxPassphrase">Passphrase</label><input id="okxPassphrase" name="passphrase" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="256" aria-describedby="okxPassphraseHelp"><small id="okxPassphraseHelp">创建该 API 时设置的密码，不是欧易登录密码。</small></div></div><div class="okx-config-actions"><button type="submit" id="okxSave" class="secondary-button">保存并连接</button><span>凭证仅提交本机后端，保存后清空。</span></div></form></div>';

  function mount(options = {}) {
    const root = options.root || (typeof window !== 'undefined' ? window : null);
    const document = options.document || root && root.document;
    const panel = document && document.getElementById('okxWalletPanel');
    if (!root || !panel) return null;
    if (panel.__okxController) return panel.__okxController;
    const fetcher = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root), clearTimer = options.clearTimeout || root.clearTimeout.bind(root);
    const now = options.now || Date.now;
    panel.classList.add('okx-wallet','card'); panel.setAttribute('aria-labelledby','okxTitle'); panel.innerHTML = MARKUP;
    const node = id => document.getElementById(id);
    let state = null, timer = null, read = null, writeBusy = false, disposed = false, pageActive = true, generation = 0, feedback = null;
    const controllers = new Set();
    function active() { const wallet = node('walletPage'); return !disposed && pageActive && !document.hidden && (!wallet || !wallet.hidden); }
    function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule() { cancelTimer(); if (active()) timer = setTimer(()=>{ timer = null; load(); }, state && state.refreshing ? 2000 : REFRESH_MS); }
    function clearInputs() { for (const id of ['okxApiKey','okxSecretKey','okxPassphrase']) node(id).value = ''; }
    function setMessage(text, error = false) { node('okxMessage').textContent = text; node('okxMessage').hidden = !text; node('okxMessage').classList.toggle('error',error); }
    function setBusy() { node('okxSave').disabled = writeBusy; node('okxRefresh').disabled = writeBusy || !!read || !state || !state.configured; node('okxSave').textContent = writeBusy ? '正在保存…' : '保存并连接'; }
    function openSettings(open) { node('okxSettings').hidden = !open; node('okxSettingsButton').setAttribute('aria-expanded',String(open)); if (open) node(state && state.pending_credentials && !state.configured ? 'okxPassphrase' : 'okxApiKey').focus(); else clearInputs(); }
    function render() {
      const health = statusPresentation(state,now());
      node('okxState').textContent = health.text; node('okxState').className = 'okx-state ' + health.kind;
      setMessage(health.message || feedback && feedback.text || '',health.kind === 'stale' || !!(feedback && feedback.error));
      const pending = !!(state && state.pending_credentials && !state.configured);
      node('okxKeyField').hidden = pending; node('okxSecretField').hidden = pending;
      node('okxCredentialHelp').textContent = pending ? 'API Key 与 Secret Key 已保存在本机，还需要该 API 的 Passphrase 才能读取资产。' : state && state.configured ? 'API Key 与 Secret Key 留空沿用；更换账户时同时填写两项。重新验证需填写 Passphrase。' : '使用仅有读取权限的欧易 API。';
      setBusy();
    }
    async function request(path, method, body, signal) {
      const controller = new root.AbortController(); controllers.add(controller);
      if (signal) signal.controller = controller;
      const timeout = setTimer(()=>controller.abort(),REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher('/api/wallet/okx' + path, {method:method || 'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,
          headers:method === 'POST' ? {'Content-Type':'application/json','X-Terminal-Request':'1'} : {'Accept':'application/json'}, ...(method === 'POST' ? {body:JSON.stringify(body)} : {})});
        const data = await response.json();
        if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('request-failed');
        return data;
      } finally { clearTimer(timeout); controllers.delete(controller); }
    }
    function apply(data) {
      if (!data || typeof data.configured !== 'boolean') throw new Error('invalid-status');
      state = data;
      if (statusPresentation(state,now()).kind === 'live') feedback = null;
      render();
    }
    async function load() {
      if (!active() || writeBusy || read) return;
      cancelTimer(); const epoch = generation, token = {};
      read = token; setBusy();
      try { const data = await request('', 'GET', null, token); if (!disposed && epoch === generation) apply(data); }
      catch (_) {
        if (!disposed && epoch === generation) {
          state = state ? {...state,status:'error',error:true,refreshing:false} : null;
          render();
          if (!state) { node('okxState').textContent = '后台连接中断'; node('okxState').className = 'okx-state stale'; setMessage('暂时无法连接本机后端，稍后自动重试。',true); }
        }
      } finally { if (read === token) read = null; setBusy(); schedule(); }
    }
    async function save(event) {
      event.preventDefault();
      if (writeBusy || disposed) return;
      const pending = !!(state && state.pending_credentials && !state.configured);
      const values = {passphrase:node('okxPassphrase').value};
      if (!pending) { values.api_key = node('okxApiKey').value.trim(); values.secret_key = node('okxSecretKey').value.trim(); }
      clearInputs();
      if (state && state.configured && !values.api_key && !values.secret_key) { delete values.api_key; delete values.secret_key; }
      if (!values.passphrase || (!pending && !(state && state.configured) && (!values.api_key || !values.secret_key))) { setMessage(pending ? '请填写创建 API 时设置的 Passphrase。' : '请填写 API Key、Secret Key 和 Passphrase。',true); return; }
      if (!!values.api_key !== !!values.secret_key) { setMessage('更换账户时，需要同时填写 API Key 和 Secret Key。',true); return; }
      if (Object.values(values).some(value=>value.length > 256 || /[\r\n\u0000]/.test(value))) { setMessage('凭证格式无效，请重新填写。',true); return; }
      cancelTimer(); generation++; if (read && read.controller) read.controller.abort(); feedback = null;
      writeBusy = true; setBusy(); setMessage('正在保存并验证连接…');
      try {
        const data = await request('/config','POST',values);
        if (!disposed) {
          if (typeof data.configured === 'boolean') apply(data);
          if (data.configured) openSettings(false);
          feedback = {text:data.configured ? '已保存，正在同步账户资产。' : '凭证已提交，等待连接验证。',error:false};
          setMessage(feedback.text);
        }
      } catch (_) { if (!disposed) { feedback = {text:'连接未验证成功。请检查 Passphrase、读取权限和 IP 白名单后重试。',error:true}; setMessage(feedback.text,true); } }
      finally { for (const key of Object.keys(values)) values[key] = ''; clearInputs(); writeBusy = false; setBusy(); if (!disposed && active()) await load(); else schedule(); }
    }
    async function refresh() {
      if (writeBusy || read || !state || !state.configured || disposed) return;
      cancelTimer(); generation++; writeBusy = true; feedback = null; setBusy();
      try { const data = await request('/refresh','POST',{}); if (!disposed && typeof data.configured === 'boolean') apply(data); }
      catch (_) { if (!disposed) { state = {...state,status:'error',error:true,refreshing:false}; render(); } }
      finally { writeBusy = false; setBusy(); if (!disposed && active()) await load(); else schedule(); }
    }
    function visibility() { if (active()) load(); else cancelTimer(); }
    function pageHide() { pageActive = false; cancelTimer(); }
    function pageShow() { pageActive = true; visibility(); }
    const events = [[node('okxConfigForm'),'submit',save],[node('okxRefresh'),'click',refresh],[node('okxSettingsButton'),'click',()=>openSettings(node('okxSettings').hidden)],
      [document,'visibilitychange',visibility],[root,'hashchange',visibility],[root,'pagehide',pageHide],[root,'pageshow',pageShow]];
    for (const [target,event,handler] of events) target.addEventListener(event,handler);
    function destroy() { disposed = true; generation++; cancelTimer(); for (const controller of controllers) controller.abort(); clearInputs(); for (const [target,event,handler] of events) target.removeEventListener(event,handler); panel.__okxController = null; }
    const controller = {refresh:load,destroy}; panel.__okxController = controller;
    render(); if (active()) load();
    return controller;
  }
  return {REFRESH_MS,timestamp,statusPresentation,mount};
});
