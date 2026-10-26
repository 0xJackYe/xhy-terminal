"use strict";

// Local asynchronous screening. Only this dialog talks to the AI relay; quote
// streams and chart rendering never wait for a model response.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OptionAIUI = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const $ = id => document.getElementById(id);
  const redact = value => String(value ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[密钥已隐藏]");
  const esc = value => redact(value).replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  const fmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 6});
  const format = value => number(value) === null ? "—" : number(value) !== 0 && Math.abs(number(value)) < 1e-6 ? number(value).toExponential(3) : fmt.format(number(value));
  const dateTime = value => number(value) === null || Math.abs(number(value)) > 8640000000000000 ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false}).format(new Date(number(value)));
  const BASE = "/api/option-ai", MAX_WAIT = 180000;
  const RISK_BUTTONS = {low:"aiRiskLow", medium:"aiRiskMedium", high:"aiRiskHigh"};
  const RISK_LABELS = {low:"低风险", medium:"中风险", high:"高风险"};
  const expiryFormatter = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit"});
  let initialized = false, hooks = {}, generation = 0, busy = false, selecting = false, currentJob = null, pollTimer = null, trigger = null;
  let models = [], configured = false, turns = [], currentResult = null, previousCriteria = null, candidates = [], startedAt = 0;
  const controllers = new Set();
  let riskExpiries = new Set(["ALL"]);

  function setError(message = "") {
    $("aiError").textContent = redact(message).slice(0, 400);
    $("aiError").hidden = !message;
  }
  function controls() {
    const blocked = busy || selecting;
    $("aiSend").disabled = blocked || !configured || !models.length;
    $("aiQuestion").disabled = blocked;
    $("aiModel").disabled = blocked || !models.length;
    $("aiCancel").hidden = !blocked;
    $("aiRevalidate").disabled = blocked || !currentJob || !currentResult;
    $("aiSaveKey").disabled = blocked;
    for (const id of Object.values(RISK_BUTTONS)) $(id).disabled = blocked || !configured || !models.length;
    $("aiRiskExpiry").disabled = blocked;
    $("aiRiskQuantity").disabled = blocked;
    $("aiDialog").setAttribute("aria-busy", String(blocked));
  }
  function stopPolling() {if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;}
  function abortRequests() {for (const controller of controllers) controller.abort(); controllers.clear();}
  async function request(path, options = {}, timeout = 10000) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const write = !["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase());
      const response = await fetch(BASE + path, {cache:"no-store", ...options,
        headers:{"Content-Type":"application/json", ...(options.headers ?? {}), ...(write ? {"X-Terminal-Request":"1"} : {})}, signal:controller.signal});
      let data;
      try {data = await response.json();} catch {throw new Error("本机 AI 服务返回了无效数据。");}
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? `本机 AI 服务响应 ${response.status}`);
      return data;
    } finally {clearTimeout(timer); controllers.delete(controller);}
  }
  function cancelRemote(id) {
    if (!id) return;
    // This request owns its own bounded lifetime; cancellation must not wait
    // for a slow model or let its response change the current dialog.
    request("/jobs/" + encodeURIComponent(id), {method:"DELETE"}, 4000).catch(() => {});
  }
  function halt(message = "") {
    const id = busy ? currentJob : null;
    generation++; stopPolling(); abortRequests(); busy = false; selecting = false;
    if (id) {cancelRemote(id); currentJob = null;}
    $("aiProgress").textContent = message;
    controls();
  }
  function jobId(value) {return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;}
  function normalizeModels(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter(item => item && typeof item.id === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(item.id) && item.available !== false && !seen.has(item.id) && seen.add(item.id)).map(item => ({id:item.id, label:redact(item.label ?? item.id).slice(0, 100)}));
  }
  async function loadStatus() {
    const token = generation;
    $("aiConnection").textContent = "检查连接设置…";
    try {
      const data = await request("/status");
      if (token !== generation || !$("aiDialog").open) return;
      const selected = $("aiModel").value;
      models = normalizeModels(data.models); configured = data.configured === true;
      $("aiModel").innerHTML = models.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("");
      $("aiModel").value = models.some(item => item.id === selected) ? selected : models.some(item => item.id === data.default_model) ? data.default_model : models[0]?.id ?? "";
      $("aiConnection").textContent = configured ? "DeepSeek 已配置" : "请配置 DeepSeek 密钥";
      $("aiSettings").open = !configured;
      controls();
    } catch (error) {
      if (token !== generation || !$("aiDialog").open) return;
      configured = false; controls();
      $("aiConnection").textContent = "连接设置暂时不可用";
      setError(error.name === "AbortError" ? "读取连接设置超时，请重新打开窗口重试。" : error.message);
    }
  }
  function resultData(result) {return result?.screening && typeof result.screening === "object" ? result.screening : result ?? {};}
  function populateRiskScope() {
    let snapshot, selected;
    try {snapshot = hooks.getSnapshot?.(); selected = hooks.getExpiry?.();} catch {snapshot = null;}
    const now = Date.now() + (number(snapshot?.exchange_clock_offset_ms) ?? 0), dates = new Set(), defaultDates = new Set();
    for (const row of Array.isArray(snapshot?.options) ? snapshot.options : []) {
      if (!row || row.status !== "TRADING") continue;
      const expiry = number(row.expiry_ms) ?? (typeof row.expiry_beijing === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(row.expiry_beijing) ? Date.parse(row.expiry_beijing) : null);
      if (expiry === null || !Number.isFinite(expiry) || expiry <= now || Math.abs(expiry) > 8640000000000000) continue;
      const date = expiryFormatter.format(new Date(expiry)), remainingDays = (expiry - now) / 86400000;
      dates.add(date);
      if (remainingDays >= 2 && remainingDays <= 60) defaultDates.add(date);
      if (dates.size >= 128) break;
    }
    riskExpiries = new Set(["ALL", ...[...dates].sort()]);
    $("aiRiskExpiry").innerHTML = [...riskExpiries].map(date => `<option value="${esc(date)}">${date === "ALL" ? "全部到期日" : esc(date)}</option>`).join("");
    $("aiRiskExpiry").value = defaultDates.has(selected) ? selected : "ALL";
    if (!(number($("aiRiskQuantity").value) > 0)) $("aiRiskQuantity").value = "0.01";
  }
  function renderResult(result) {
    const screen = resultData(result), snapshot = screen.snapshot ?? result?.snapshot ?? {};
    const profile = result?.risk_profile ?? screen.risk_profile;
    $("aiRiskResult").textContent = profile && typeof profile === "object" ? `${redact(profile.label ?? RISK_LABELS[profile.id] ?? "风险分档")}${typeof profile.definition === "string" ? " · " + redact(profile.definition).slice(0, 700) : ""}` : "";
    $("aiRiskResult").hidden = !profile || typeof profile !== "object";
    const explanation = result?.ai_explanation ?? screen.ai_explanation;
    const explained = explanation?.status === "complete";
    const explanationText = explained && typeof explanation.overview === "string" ? explanation.overview : explanation?.status === "unavailable" ? "AI 解读暂不可用；已保留本地计算结果。" : explanation?.status === "outdated" ? "报价已重算，旧的 AI 解读已隐藏。" : "";
    $("aiExplanationText").textContent = redact(explanationText).slice(0, 6000);
    $("aiExplanation").hidden = !explanationText;
    const perContract = new Map();
    for (const item of explained && Array.isArray(explanation.candidates) ? explanation.candidates.slice(0, 20) : []) {
      if (item && typeof item.symbol === "string" && typeof item.text === "string" && !perContract.has(item.symbol)) perContract.set(item.symbol, item.text.slice(0, 2400));
    }
    const answer = redact(result?.answer ?? screen.answer ?? "已按识别的条件完成筛选。").slice(0, 6000);
    candidates = Array.isArray(screen.candidates) ? screen.candidates.filter(item => item && typeof item.symbol === "string" && /^BTC-[A-Za-z0-9.-]+$/.test(item.symbol) && ["BUY", "SELL"].includes(item.direction)).slice(0, 20) : [];
    $("aiAnswer").textContent = answer;
    $("aiAnswer").hidden = Boolean(profile && typeof profile === "object");
    const stamp = snapshot.evaluated_at_ms ?? snapshot.as_of_ms ?? snapshot.server_now_ms;
    const revision = number(snapshot.revision), count = number(screen.matched_count ?? screen.total_matches);
    $("aiSnapshot").textContent = `行情快照 ${dateTime(stamp)}（北京）${revision !== null ? ` · 版本 ${revision}` : ""}${count !== null ? ` · 匹配 ${count} 个` : ""}`;
    $("aiSnapshot").hidden = !candidates.length && number(stamp) === null;
    $("aiCriteria").textContent = JSON.stringify(result?.criteria ?? screen.criteria ?? {}, null, 2).slice(0, 4000);
    $("aiCriteriaDetails").hidden = !Object.keys(result?.criteria ?? screen.criteria ?? {}).length;
    const warnings = [...new Set([...(candidates.length ? ["平均权利金未扣费，不等于每日盈利。"] : []), ...(Array.isArray(result?.warnings) ? result.warnings : []), ...(screen !== result && Array.isArray(screen.warnings) ? screen.warnings : [])])].filter(value => typeof value === "string").slice(0, 5);
    $("aiWarnings").textContent = warnings.map(redact).join(" · "); $("aiWarnings").hidden = !warnings.length;
    $("aiCandidates").innerHTML = candidates.map((item, index) => {
      const type = item.type ?? item.side, direction = item.direction === "SELL" ? "卖" : "买";
      const quote = item.quote_price ?? item.quote ?? item.premium;
      const daily = item.daily_premium ?? item.average_daily_premium;
      const basis = item.direction === "SELL" ? "每日权利金" : "每日权利金支出";
      const percent = value => number(value) === null ? "—" : `${format(number(value))}%`;
      const stress = Array.isArray(item.stress_scenarios) ? item.stress_scenarios.find(point => number(point?.move_pct) === -20) : null;
      const gap = number(item.break_even_drop_pct), gapLabel = gap !== null && gap < 0 ? "回到平衡需上涨" : "跌至盈亏平衡";
      const riskValues = profile && typeof profile === "object" ? `<span>整笔权利金 <b>${format(item.premium_total)} USDT</b></span><span>足额现金 <b>${format(item.cash_required)} USDT</b></span><span>最大亏损（未扣费） <b>${format(item.max_loss_gross)} USDT</b></span><span>盈亏平衡价 <b>${format(item.break_even)} USDT</b></span><span>${gapLabel} <b>${percent(gap === null ? null : Math.abs(gap))}</b></span><span>到期指数跌 20% 损益 <b>${format(stress?.pnl_gross)} USDT</b></span>` : "";
      const localRisk = profile && typeof item.risk_summary === "string" ? `<details class="ai-local-risk"><summary>风险明细</summary><p>${esc(item.risk_summary.slice(0, 1200))}</p></details>` : "";
      const modelText = perContract.get(item.symbol);
      return `<article class="ai-candidate"><div class="ai-candidate-top"><strong>${esc(item.symbol)}</strong><span>${direction} ${type === "CALL" ? "Call" : "Put"}</span></div><div class="ai-candidate-values"><span>到期 <b>${esc(item.expiry ?? "—")}</b></span><span>行权价 <b>${format(item.strike)}</b></span><span>${direction === "卖" ? "买一" : "卖一"} <b>${format(quote)}</b></span><span>数量 <b>${format(item.quantity)}</b></span><span>${basis} <b>${format(daily)} USDT/日</b></span><span>剩余 <b>${format(item.remaining_days)} 天</b></span><span>虚值率 <b>${percent(item.otm_pct)}</b></span><span>|Delta| <b>${format(item.abs_delta)}</b></span><span>IV <b>${percent(number(item.iv) === null ? null : number(item.iv) * 100)}</b></span><span>买卖价差 <b>${percent(item.spread_pct)}</b></span>${riskValues}</div>${localRisk}${item.reason ? `<p>${esc(String(item.reason).slice(0, 500))}</p>` : ""}${modelText ? `<p class="ai-candidate-analysis"><strong>AI 解读</strong>${esc(modelText)}</p>` : ""}<button type="button" data-ai-candidate="${index}">查看当前报价</button></article>`;
    }).join("");
    $("aiEmpty").hidden = Boolean(candidates.length);
    $("aiEmpty").textContent = result?.needs_clarification || result?.clarification_required ? "请补充需求后继续。" : profile ? "当前快照没有符合此档标准（剩余 2–60 天）且报价可用的合约，未放宽风险条件。" : "当前快照没有符合条件且报价可用的合约。";
    $("aiResult").hidden = false;
    return answer;
  }
  function renderHistory() {
    $("aiHistory").innerHTML = turns.slice(0, -1).map(turn => `<details class="ai-turn"><summary>${esc(turn.question.slice(0, 120))}</summary><p>${esc(turn.answer)}</p></details>`).join("");
    $("aiHistory").hidden = turns.length < 2;
  }
  function complete(result, token, appendTurn, question = "") {
    if (token !== generation || !$("aiDialog").open) return;
    currentResult = result;
    if (!result?.needs_clarification && !result?.clarification_required && resultData(result).criteria && typeof resultData(result).criteria === "object") {
      previousCriteria = JSON.parse(JSON.stringify(resultData(result).criteria));
    }
    const answer = renderResult(result);
    if (appendTurn) {turns.push({question, answer:answer.slice(0, 3000)}); turns = turns.slice(-4);}
    else if (turns.length) turns[turns.length - 1].answer = answer.slice(0, 3000);
    renderHistory(); busy = false; controls();
    $("aiProgress").textContent = `已完成 · ${format((Date.now() - startedAt) / 1000)} 秒`;
  }
  function fail(error, token) {
    if (token !== generation || !$("aiDialog").open) return;
    if (!currentResult && currentJob) {cancelRemote(currentJob); currentJob = null;}
    stopPolling(); busy = false; controls();
    $("aiProgress").textContent = "";
    setError(error.name === "AbortError" ? "请求超时，可重试；行情看板仍会继续更新。" : error.message);
  }
  async function poll(id, token, question, appendTurn) {
    if (token !== generation || !$("aiDialog").open) return;
    if (Date.now() - startedAt > MAX_WAIT) {cancelRemote(id); currentJob = null; fail(new Error("AI 响应超时，请稍后重试或切换模型。"), token); return;}
    try {
      const data = await request("/jobs/" + encodeURIComponent(id));
      if (token !== generation || !$("aiDialog").open) return;
      if (["complete", "completed", "succeeded"].includes(data.status)) {complete(data.result ?? {}, token, appendTurn, question); return;}
      if (["failed", "cancelled", "canceled"].includes(data.status)) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? "筛选未完成，请重试。");
      if (!["queued", "running", "pending"].includes(data.status)) throw new Error("AI 任务状态无效，请重试。");
      $("aiProgress").textContent = data.status === "queued" ? "等待处理…" : "正在理解需求并核对行情…";
      pollTimer = setTimeout(() => {pollTimer = null; poll(id, token, question, appendTurn);}, Date.now() - startedAt < 10000 ? 700 : 1500);
    } catch (error) {fail(error, token);}
  }
  async function submit(event) {
    event?.preventDefault?.();
    if (busy || selecting) return;
    $("aiCustomCriteria").open = true;
    const question = $("aiQuestion").value.trim(), model = $("aiModel").value;
    if (!question || question.length > 3000) {setError("请填写 1–3000 字的筛选需求。"); $("aiQuestion").focus({preventScroll:true}); return;}
    if (/sk-[A-Za-z0-9_-]{8,}/.test(question)) {setError("密钥请填写在连接设置中，不要放入筛选需求。"); return;}
    if (!configured || !models.some(item => item.id === model)) {setError("请先配置连接并选择可用模型。"); return;}
    const history = turns.slice(-3).flatMap(turn => [{role:"user", content:turn.question.slice(0, 2000)}, {role:"assistant", content:turn.answer.slice(0, 2000)}]);
    await startJob({question, model, history, ...(previousCriteria ? {previous_criteria:previousCriteria} : {})}, question);
  }
  async function submitRisk(profile) {
    if (busy || selecting || !Object.hasOwn(RISK_BUTTONS, profile)) return;
    const model = $("aiModel").value, expiry = $("aiRiskExpiry").value, quantity = number($("aiRiskQuantity").value);
    if (!configured || !models.some(item => item.id === model)) {setError("请先配置连接并选择可用模型。"); return;}
    if (!riskExpiries.has(expiry)) {setError("请选择当前存在的到期日。"); return;}
    if (quantity === null || quantity <= 0) {setError("请填写有限的正数模拟数量。"); return;}
    $("aiCustomCriteria").open = false;
    await startJob({model, risk_profile:profile, expiry, quantity}, `${RISK_LABELS[profile]}：足额现金卖 Put · ${expiry === "ALL" ? "全部到期日" : expiry} · ${format(quantity)} BTC`);
  }
  async function startJob(payload, question) {
    halt(); const token = generation; currentJob = null; currentResult = null;
    busy = true; controls(); setError(); startedAt = Date.now();
    $("aiResult").hidden = true; $("aiProgress").textContent = "提交需求…";
    try {
      const data = await request("/jobs", {method:"POST", body:JSON.stringify(payload)});
      const id = jobId(data.job_id ?? data.id);
      if (token !== generation || !$("aiDialog").open) {if (id) cancelRemote(id); return;}
      if (!id) throw new Error("服务没有返回有效的任务编号。");
      currentJob = id;
      if (data.status === "complete" && data.result) complete(data.result, token, true, question);
      else await poll(id, token, question, true);
    } catch (error) {fail(error, token);}
  }
  async function revalidate() {
    if (busy || selecting || !currentJob || !currentResult) return;
    const id = currentJob;
    halt(); const token = generation; busy = true; controls(); setError(); startedAt = Date.now();
    $("aiProgress").textContent = "按原条件更新行情…";
    try {
      const data = await request("/jobs/" + encodeURIComponent(id) + "/revalidate", {method:"POST", body:"{}"});
      if (token !== generation || !$("aiDialog").open) return;
      currentJob = jobId(data.job_id ?? data.id) ?? id;
      if (["queued", "running", "pending"].includes(data.status)) await poll(currentJob, token, "", false);
      else complete(data.result ?? data, token, false);
    } catch (error) {fail(error, token);}
  }
  async function saveKey(event) {
    event?.preventDefault?.();
    if (busy || selecting) return;
    const input = $("aiKey"), apiKey = input.value.trim(); input.value = "";
    if (!apiKey || apiKey.length > 512) {setError("请填写有效的 DeepSeek API Key。"); return;}
    const token = generation; busy = true; controls(); setError();
    try {
      await request("/config", {method:"POST", body:JSON.stringify({api_key:apiKey})});
      if (token !== generation || !$("aiDialog").open) return;
      busy = false; controls(); await loadStatus();
    } catch (error) {fail(error, token);}
  }
  async function viewCandidate(event) {
    const button = event.target.closest("button[data-ai-candidate]");
    if (!button || busy || selecting) return;
    const index = Number(button.dataset.aiCandidate), candidate = Number.isInteger(index) ? candidates[index] : null;
    if (!candidate || typeof hooks.onOpenCandidate !== "function") return;
    const token = generation;
    const isCurrent = () => token === generation && $("aiDialog").open;
    selecting = true; controls(); setError(); button.disabled = true;
    $("aiProgress").textContent = "校验当前报价…";
    try {
      // The application must call isCurrent immediately before any payoff or
      // selection side effect after its asynchronous current-quote check.
      const response = await hooks.onOpenCandidate({...candidate}, {criteria:currentResult?.criteria ?? resultData(currentResult).criteria, snapshot:resultData(currentResult).snapshot, risk_profile:currentResult?.risk_profile ?? resultData(currentResult).risk_profile, isCurrent});
      if (!isCurrent()) return;
      if (response === false) throw new Error("当前报价已变化或暂不可用，请更新报价后重试。");
      $("aiDialog").close();
    } catch (error) {if (isCurrent()) setError(error.message ?? "当前报价暂不可用，请更新报价后重试。");}
    finally {button.disabled = false; if (isCurrent()) {selecting = false; $("aiProgress").textContent = ""; controls();}}
  }
  function open(button) {
    if (!initialized) return;
    trigger = button ?? document.activeElement;
    if (!$("aiDialog").open) $("aiDialog").showModal();
    halt(); setError(); populateRiskScope(); loadStatus(); ($("aiCustomCriteria").open ? $("aiQuestion") : $("aiClose")).focus({preventScroll:true});
  }
  function initialize(options = {}) {
    if (initialized || !$("aiDialog")) return;
    initialized = true; hooks = options;
    ["aiButton", "focusAIButton"].forEach(id => $(id)?.addEventListener("click", () => open($(id))));
    $("aiClose").addEventListener("click", () => $("aiDialog").close());
    $("aiCancel").addEventListener("click", () => halt("已停止等待"));
    $("aiForm").addEventListener("submit", submit);
    for (const [profile, id] of Object.entries(RISK_BUTTONS)) $(id).addEventListener("click", () => submitRisk(profile));
    $("aiKeyForm").addEventListener("submit", saveKey);
    $("aiRevalidate").addEventListener("click", revalidate);
    $("aiCandidates").addEventListener("click", viewCandidate);
    $("aiDialog").addEventListener("keydown", event => {if (event.key === "Escape") event.stopPropagation();});
    $("aiDialog").addEventListener("close", () => {halt(); $("aiKey").value = ""; if (!document.querySelector('dialog[open]')) trigger?.focus?.({preventScroll:true});});
    controls();
  }
  return Object.freeze({initialize, open, normalizeModels});
});
