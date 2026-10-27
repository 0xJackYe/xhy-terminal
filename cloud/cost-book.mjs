import Decimal from 'decimal.js';

export const D = Decimal.clone({ precision: 96, rounding: Decimal.ROUND_HALF_UP });
export const iso = ms => new Date(ms).toISOString();
export const beijingDate = ms => new Date(ms + 28800000).toISOString().slice(0, 10);
export function dec(value) {
  if (Decimal.isDecimal(value)) return new D(value);
  if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && value.length > 512) throw new Error('invalid_amount');
  const n = new D(value);
  if (!n.isFinite() || n.abs().gt('1e100')) throw new Error('invalid_amount');
  return n;
}
export const txt = value => value == null ? null : dec(value).toFixed();
const integer = value => {
  const text = String(value).replace(/^'/, '');
  if (!/^\d{1,30}$/.test(text)) throw new Error('invalid_identifier');
  return text;
};
const fields = ['price', 'btc_gross', 'btc_net', 'fee_btc', 'fee_quote', 'quote_gross', 'quote_amount', 'original_price'];

export function validateTrade(row) {
  if (!row || !['buy', 'sell'].includes(row.side) || typeof row.id !== 'string' || !row.id || row.id.length > 200 || !Number.isSafeInteger(row.at_ms) || row.at_ms < 1230768000000) throw new Error('invalid_trade');
  if (!/^[A-Z0-9]{1,20}$/.test(row.quote_ccy)) throw new Error('invalid_currency');
  integer(row.bill_id); integer(row.counter_bill_id);
  for (const field of fields) dec(row[field]);
  if (!dec(row.btc_gross).gt(0) || !dec(row.quote_gross).gt(0) || dec(row.quote_amount).lt(0)) throw new Error('invalid_trade');
  const sign = row.side === 'buy' ? 1 : -1;
  if (!dec(row.btc_net).eq(dec(row.btc_gross).mul(sign).add(row.fee_btc))) throw new Error('invalid_trade');
  if (row.side === 'buy' ? !dec(row.btc_net).gt(0) : !dec(row.btc_net).lt(0)) throw new Error('invalid_trade');
  return row;
}

export function normalizeBills(rows) {
  if (!Array.isArray(rows) || rows.length > 30000) throw new Error('invalid_bills');
  const bills = new Map(), groups = new Map();
  for (const raw of rows) {
    if (raw?.instType !== 'SPOT' || !['1', '2', '318', '319'].includes(raw.subType) || !String(raw.instId).split('-').includes('BTC')) continue;
    const row = { ...raw, billId: integer(raw.billId), tradeId: integer(raw.tradeId), ordId: raw.ordId ? integer(raw.ordId) : '' };
    const at = Number(row.fillTime || row.ts);
    if (!Number.isSafeInteger(at) || at < 1230768000000 || !/^[A-Z0-9]{1,20}$/.test(row.ccy)) throw new Error('invalid_bill');
    row.at_ms = at;
    for (const key of ['sz', 'px', 'fee', 'balChg']) row[key] = txt(row[key] || '0');
    const old = bills.get(row.billId);
    if (old) {
      if (['ccy','instId','subType','ordId','tradeId','sz','px','fee','balChg'].some(k => old[k] !== row[k]) || Math.floor(old.at_ms / 1000) !== Math.floor(at / 1000)) throw new Error('conflicting_bill');
      continue;
    }
    bills.set(row.billId, row);
    const key = [row.instId, row.tradeId, row.ordId].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = [];
  for (const [id, legs] of groups) {
    const parts = legs[0].instId.split('-');
    if (![2, 3].includes(parts.length) || parts.length === 3 && parts[2] !== 'CONVERT' || parts.slice(0,2).filter(x=>x==='BTC').length !== 1) throw new Error('invalid_instrument');
    const ccy = parts.slice(0, 2).find(x => x !== 'BTC');
    const btc = legs.filter(x => x.ccy === 'BTC'), pay = legs.filter(x => x.ccy === ccy);
    if (legs.length !== 2 || btc.length !== 1 || pay.length !== 1) throw new Error('incomplete_trade_legs');
    const b = btc[0], p = pay[0], buy = ['1','318'].includes(b.subType), convert = ['318','319'].includes(b.subType);
    const opposite = convert ? buy ? '319' : '318' : buy ? '2' : '1';
    if (p.subType !== opposite || Math.abs(b.at_ms-p.at_ms)>1000) throw new Error('inconsistent_trade_legs');
    const size = dec(b.sz), amount = dec(p.sz), price = dec(b.px);
    if (!size.gt(0) || !amount.gt(0) || !price.gt(0)) throw new Error('invalid_trade_size');
    const expected = parts[0] === 'BTC' ? size.mul(price) : amount.mul(price);
    const actual = parts[0] === 'BTC' ? amount : size;
    // Archive Convert amounts may be rounded in the counter leg. Permit no
    // more than half its original written unit; ordinary fills are exact.
    const rawLeg = rows.find(r => String(r.billId).replace(/^'/,'') === (parts[0] === 'BTC' ? p.billId : b.billId));
    const rawSize = String(rawLeg?.sz || '0');
    const fraction = /\.(\d+)/.exec(rawSize)?.[1]?.length || 0;
    const tolerance = convert ? new D(10).pow(-fraction).div(2) : new D(0);
    if (expected.sub(actual).abs().gt(tolerance)) throw new Error('notional_mismatch');
    const net = size.mul(buy?1:-1).add(b.fee), cash = amount.mul(buy?-1:1).add(p.fee);
    if (!net.eq(b.balChg) || !cash.eq(p.balChg) || (buy ? !net.gt(0)||!cash.lt(0) : !net.lt(0)||cash.lt(0))) throw new Error('balance_change_mismatch');
    result.push(validateTrade({id,at_ms:b.at_ms,side:buy?'buy':'sell',inst_id:b.instId,trade_id:b.tradeId,order_id:b.ordId,bill_id:b.billId,counter_bill_id:p.billId,price:txt(parts[0]==='BTC'?price:amount.div(size)),btc_gross:txt(size),btc_net:txt(net),fee_btc:b.fee,fee_quote:p.fee,quote_ccy:ccy,quote_gross:txt(amount),quote_amount:txt(buy?cash.neg():cash),original_price:txt(price)}));
  }
  return result.sort(compareTrades);
}
export const compareTrades = (a,b) => a.at_ms-b.at_ms || (BigInt(a.bill_id)<BigInt(b.bill_id)?-1:BigInt(a.bill_id)>BigInt(b.bill_id)?1:0);

export function emptyBook() {
  return {version:1,inventory:'0',cost:'0',bought:'0',sold:'0',buy_count:0,sell_count:0,trade_count:0,first_trade_at:null,last_trade_at:null,last_at_ms:0,last_bill_id:'0',first_buy_at:null,last_buy_at:null,first_net_buy_price:null,last_net_buy_price:null,by_currency:{}};
}
export function rateFor(row,rates) {
  if(row.quote_ccy==='USDT')return new D(1);
  const minute=Math.floor(row.at_ms/60000)*60000,key=row.quote_ccy+':'+minute;
  let raw=rates instanceof Map?rates.get(key):rates?.[key];
  if(raw&&typeof raw==='object')raw=raw.close;
  if(raw==null||!dec(raw).gt(0))throw new Error('historical_rate_missing');
  return dec(raw);
}
export function appendCostBook(original,updates,rates={}) {
  const book=structuredClone(original||emptyBook());
  for(const row of [...updates].sort(compareTrades)){
    validateTrade(row);
    if(book.trade_count && (row.at_ms<book.last_at_ms || row.at_ms===book.last_at_ms && BigInt(row.bill_id)<=BigInt(book.last_bill_id)))throw new Error('out_of_order_trade');
    const quantity=dec(row.btc_net),amount=dec(row.quote_amount),at=iso(row.at_ms);
    const group=book.by_currency[row.quote_ccy] ||= {buy_spent:'0',sell_received:'0',bought_btc:'0'};
    if(row.side==='buy'){
      const cash=amount.mul(rateFor(row,rates));
      book.inventory=txt(dec(book.inventory).add(quantity));book.cost=txt(dec(book.cost).add(cash));book.bought=txt(dec(book.bought).add(quantity));book.buy_count++;
      group.buy_spent=txt(dec(group.buy_spent).add(amount));group.bought_btc=txt(dec(group.bought_btc).add(quantity));
      if(!book.first_buy_at){book.first_buy_at=at;book.first_net_buy_price=txt(cash.div(quantity));}
      book.last_buy_at=at;book.last_net_buy_price=txt(cash.div(quantity));
    }else{
      const sold=quantity.neg(),inventory=dec(book.inventory),cost=dec(book.cost);
      if(sold.gt(inventory)||!sold.gt(0))throw new Error('history_invalid');
      book.cost=txt(sold.eq(inventory)?new D(0):cost.sub(cost.mul(sold).div(inventory)));
      book.inventory=txt(inventory.sub(sold));book.sold=txt(dec(book.sold).add(sold));book.sell_count++;
      group.sell_received=txt(dec(group.sell_received).add(amount));
    }
    book.trade_count++;book.first_trade_at ||= at;book.last_trade_at=at;book.last_at_ms=row.at_ms;book.last_bill_id=row.bill_id;
  }
  return book;
}
export function buildCostBook(records,rates={}) {
  const seen=new Set(),bills=new Set();
  for(const row of records){validateTrade(row);if(seen.has(row.id)||bills.has(row.bill_id)||bills.has(row.counter_bill_id))throw new Error('duplicate_trade');seen.add(row.id);bills.add(row.bill_id);bills.add(row.counter_bill_id);}
  return appendCostBook(emptyBook(),records,rates);
}
export function costView(book,recent,meta,now,connection,status='fresh',error=null) {
  const date=beijingDate(now);let count=0,spent=new D(0),quantity=new D(0);
  for(const row of recent){if(row.side==='buy'&&beijingDate(row.at_ms)===date){count++;quantity=quantity.add(row.btc_net);if(row.quote_ccy==='USDT')spent=spent.add(row.quote_amount);}}
  const currencies=Object.entries(book.by_currency).sort(([a],[b])=>a.localeCompare(b)).map(([currency,g])=>({currency,buy_spent:g.buy_spent,sell_received:g.sell_received,net_invested:txt(dec(g.buy_spent).sub(g.sell_received)),average_buy_cost:dec(g.bought_btc).gt(0)?txt(dec(g.buy_spent).div(g.bought_btc)):null}));
  return {status,refreshing:false,last_success_at:meta?.as_of_ms?iso(meta.as_of_ms):null,error,error_code:error?'refresh_failed':null,plan_daily_usdt:'20',coverage_complete:meta?.complete===true,connection_id:connection,refresh_interval_seconds:60,retry_in_seconds:0,summary:{buy_count:book.buy_count,sell_count:book.sell_count,bought_btc:book.bought,sold_btc:book.sold,net_bought_btc:book.inventory,by_currency:currencies},today:{date_beijing:date,buy_count:count,buy_spent_usdt:txt(spent),bought_btc:txt(quantity),remaining_plan_usdt:txt(D.max(0,new D(20).sub(spent)))},recent_trades:[...recent].sort(compareTrades).slice(-30).reverse().map(r=>({id:r.id,time_beijing:iso(r.at_ms),side:r.side,price:r.price,quote_ccy:r.quote_ccy,quote_amount:r.quote_amount,btc_net:r.btc_net,fee_btc:r.fee_btc}))};
}
export function positionView(book,holdings,price,meta,policy,now,connection,status='fresh',error=null){
  const q=dec(holdings),p=dec(price),cost=dec(book.cost);if(q.lt(0)||!p.gt(0))throw new Error('holdings_unavailable');
  const market=q.mul(p),unrealized=market.sub(cost),adjustment=q.sub(book.inventory);
  return {status,estimated:true,currency:'USDT',method:'moving_weighted_average',focus:'long_term_unrealized',connection_id:connection,error,refresh_interval_seconds:60,as_of:iso(now),quote_at:iso(now),ledger_as_of:meta?.as_of_ms?iso(meta.as_of_ms):null,holdings_as_of:iso(now),coverage_start:meta?.coverage_start_ms?iso(meta.coverage_start_ms):null,coverage_complete:meta?.complete===true,history_status:status,trade_count:book.trade_count,buy_count:book.buy_count,sell_count:book.sell_count,first_trade_at:book.first_trade_at,last_trade_at:book.last_trade_at,first_buy_at:book.first_buy_at,last_buy_at:book.last_buy_at,ignored_received_btc:policy?.received_btc||'0',metrics:{unrealized_net:txt(unrealized),unrealized_return_pct:cost.gt(0)?txt(unrealized.div(cost).mul(100)):null,remaining_cost:book.cost,average_cost:q.gt(0)?txt(cost.div(q)):null,spot_average_cost:dec(book.inventory).gt(0)?txt(cost.div(book.inventory)):null,holdings_btc:txt(q),spot_inventory_btc:book.inventory,known_net_bought_btc:book.inventory,bought_net_btc:book.bought,nonspot_btc_adjustment:txt(adjustment),market_value:txt(market),price_usdt:txt(p),first_net_buy_price:book.first_net_buy_price,last_net_buy_price:book.last_net_buy_price},assumptions:['每笔定投以净到账 BTC 和含手续费实付金额更新移动加权平均买入成本。','历史卖出仅按卖出前平均成本调整剩余数量和成本，不将卖出回款计入当前浮盈。','按你的要求，小额 Received 不追加原始取得成本，相关非现货净变动作为期末数量调整，因此属于估算。','ETH、USDC 换入按成交分钟 OKX/USDT 收盘价折算；缺失行情时不填零。','云端后台每分钟同步新成交，页面定期更新持仓价格和浮盈。']};
}
