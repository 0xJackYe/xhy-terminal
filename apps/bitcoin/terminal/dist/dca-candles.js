(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DCACandles=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const START='2024-07-01',DAY=86400000,REFRESH_MS=5000,TIMEOUT_MS=25000;
  function dateTime(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
    const ms=Date.parse(value+'T00:00:00Z');return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value?ms:null;
  }
  function dateKey(value){
    if(typeof value==='string')return dateTime(value)===null?null:value;
    if(value&&Number.isInteger(value.year)&&Number.isInteger(value.month)&&Number.isInteger(value.day))return dateKey(String(value.year).padStart(4,'0')+'-'+String(value.month).padStart(2,'0')+'-'+String(value.day).padStart(2,'0'));
    return null;
  }
  function amount(value,digits=2){
    if(typeof value!=='string'||value.length>512||!/^\d+(?:\.\d+)?$/.test(value))return '—';
    const [whole,tail='']=value.split('.');let units=BigInt(whole+tail.slice(0,digits).padEnd(digits,'0'));
    if(tail.length>digits&&tail[digits]>='5')units++;
    const written=units.toString().padStart(digits+1,'0'),integer=(digits?written.slice(0,-digits):written).replace(/\B(?=(\d{3})+(?!\d))/g,',');
    return integer+(digits?'.'+written.slice(-digits):'');
  }
  function normalized(data){
    if(!data||!['fresh','stale','loading','unavailable'].includes(data.status)||data.timezone!=='Asia/Shanghai'||data.interval!=='1d'||data.symbol!=='BTCUSDT'||!Array.isArray(data.candles)||data.candles.length>20000)return null;
    const list=[],seen=new Set();
    for(const row of data.candles){
      if(!row||dateTime(row.time)===null||row.time<START||seen.has(row.time))return null;
      const prices=['open','high','low','close'].map(key=>typeof row[key]==='string'&&/^\d+(?:\.\d+)?$/.test(row[key])?Number(row[key]):NaN);
      if(prices.some(value=>!Number.isFinite(value)||value<=0||value>1e12))return null;
      const [open,high,low,close]=prices;if(high<Math.max(open,low,close)||low>Math.min(open,high,close))return null;
      list.push({time:row.time,open,high,low,close});seen.add(row.time);
    }
    list.sort((a,b)=>a.time.localeCompare(b.time));
    return {status:data.status,mode:data.mode==='tail'?'tail':'history',candles:list,source:typeof data.source==='string'?data.source.slice(0,100):'',asOf:typeof data.as_of==='string'?data.as_of:null,complete:data.coverage_complete===true,error:typeof data.error==='string'?data.error.slice(0,200):null};
  }
  function purchases(model){
    const result=new Map();
    if(!model||!(model.days instanceof Map))return result;
    for(const [time,day]of model.days){
      if(!Number.isFinite(time)||!day||!Number.isSafeInteger(day.btc)||day.btc<=0)continue;
      const date=new Date(time).toISOString().slice(0,10);
      const usdt=typeof day.exactUSDT==='string'?day.exactUSDT:day.usdt===null?null:Number.isSafeInteger(day.usdt)?(day.usdt/100).toFixed(2):null;
      const btc=typeof day.exactBTC==='string'?day.exactBTC:(day.btc/1e8).toFixed(8);
      result.set(date,{date,usdt,btc,buys:Number.isSafeInteger(day.buys)?day.buys:null});
    }
    return result;
  }
  function markerRows(buys,candles,color){
    const dates=new Set(candles.map(row=>row.time));return [...buys.keys()].sort().filter(date=>dates.has(date)).map(time=>({time,position:'belowBar',color,shape:'circle',text:'B',size:0,id:'buy-'+time}));
  }
  const MARKUP='<div id="dcaCandleSheet" class="dca-candle-sheet" hidden><section id="dcaCandleDialog" class="dca-candle-dialog" role="dialog" aria-modal="true" aria-labelledby="dcaCandleTitle" tabindex="-1">'+
    '<header class="dca-candle-head"><div><h3 id="dcaCandleTitle">BTC 定投日 K 线</h3><p>BTC / USDT · 北京时间 UTC+8</p></div><div class="dca-candle-state"><i id="dcaCandleDot"></i><span id="dcaCandleState" role="status">读取行情中</span></div><button id="dcaCandleClose" type="button" aria-label="关闭定投 K 线">×</button></header>'+
    '<div class="dca-candle-toolbar"><div id="dcaCandleRanges" class="dca-candle-controls" role="group" aria-label="K 线显示范围"><button type="button" data-view="year">近一年</button><button type="button" data-view="all">全部</button><button type="button" data-view="first">首笔买入</button><button type="button" data-view="latest">最新</button></div><div class="dca-candle-jump"><label for="dcaCandleDate">跳转</label><input id="dcaCandleDate" type="date" min="2024-07-01" aria-label="跳转到北京时间日期"><button id="dcaCandleJump" type="button">前往</button></div><div class="dca-candle-controls" role="group" aria-label="K 线缩放"><button id="dcaCandleZoomOut" type="button" aria-label="缩小 K 线">−</button><button id="dcaCandleZoomIn" type="button" aria-label="放大 K 线">＋</button></div></div>'+
    '<div class="dca-candle-readout"><strong id="dcaCandleDay">日 K · 2024-07-01 起</strong><span id="dcaCandleOHLC">开 —　高 —　低 —　收 —</span><span id="dcaCandleBuy">B 表示当天有买入</span></div>'+
    '<div id="dcaCandleStage" class="dca-candle-stage"><div id="dcaCandleChart" class="dca-candle-chart" role="img" aria-label="北京时间 BTC 每日 K 线及买入标记" tabindex="0"></div><div id="dcaCandleEmpty" class="dca-candle-empty">正在同步 2024 年 7 月起的每日行情…</div><div id="dcaCandleTip" class="dca-candle-tip" role="tooltip" hidden><strong id="dcaCandleTipDate"></strong><span id="dcaCandleTipUSDT"></span><small id="dcaCandleTipDetail"></small></div></div>'+
    '<footer class="dca-candle-footer"><span id="dcaCandleCoverage">滚轮缩放 · 拖动平移 · 悬停 B 查看买入金额</span><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Charts by TradingView</a></footer></section></div>';
  function mount(options={}){
    const root=options.root||globalThis,document=options.document||root.document;
    if(!document||!document.body||typeof document.createElement!=='function')return null;
    const old=document.getElementById('dcaCandleSheet');if(old&&old.__controller)return old.__controller;
    const host=document.createElement('div');host.innerHTML=MARKUP;const sheet=host.firstElementChild;document.body.append(sheet);
    const node=id=>document.getElementById(id),dialog=node('dcaCandleDialog'),chartNode=node('dcaCandleChart'),tip=node('dcaCandleTip');
    const fetcher=options.fetch||root.fetch.bind(root),setTimer=options.setTimeout||root.setTimeout.bind(root),clearTimer=options.clearTimeout||root.clearTimeout.bind(root);
    const clock=options.now||Date.now;
    let opened=false,disposed=false,chart=null,series=null,markers=null,data=null,model=null,buys=new Map(),timer=null,read=null,sequence=0,initial=true,selection=null,opener=null,resizeObserver=null,themeObserver=null,needsHistory=false,inspectedDate=null;
    const active=()=>opened&&!disposed&&!document.hidden;
    const stop=()=>{if(timer!==null)clearTimer(timer);timer=null;};
    function schedule(){stop();if(active())timer=setTimer(()=>{timer=null;load();},REFRESH_MS);}
    function hideTip(){tip.hidden=true;}
    function css(name,fallback){const value=typeof root.getComputedStyle==='function'?root.getComputedStyle(dialog).getPropertyValue(name).trim():'';return value||fallback;}
    function colors(){return {bg:css('--card','#faf8f2'),text:css('--text','#292923'),muted:css('--muted','#7b7b6c'),line:css('--line','#dedbd1'),accent:css('--dca-marker','#bd694d'),up:css('--green','#38775a'),down:css('--red','#ad5847')};}
    function theme(){
      if(!chart)return;const c=colors();chart.applyOptions({layout:{background:{type:'solid',color:c.bg},textColor:c.muted,fontFamily:'Consolas, SFMono-Regular, monospace',fontSize:11,attributionLogo:true},grid:{vertLines:{color:c.line,visible:false},horzLines:{color:c.line}},rightPriceScale:{borderColor:c.line},timeScale:{borderColor:c.line},crosshair:{vertLine:{color:c.muted,labelBackgroundColor:c.text},horzLine:{color:c.muted,labelBackgroundColor:c.text}}});
      series.applyOptions({upColor:c.up,downColor:c.down,borderUpColor:c.up,borderDownColor:c.down,wickUpColor:c.up,wickDownColor:c.down});drawMarkers();
    }
    function makeChart(){
      if(chart)return true;const lib=options.charts||root.LightweightCharts;
      if(!lib||typeof lib.createChart!=='function'||!lib.CandlestickSeries||typeof lib.createSeriesMarkers!=='function'){node('dcaCandleEmpty').textContent='图表组件暂不可用，请重新打开页面。';return false;}
      chart=lib.createChart(chartNode,{autoSize:true,handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true,axisDoubleClickReset:true},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true},kineticScroll:{mouse:true,touch:true},rightPriceScale:{scaleMargins:{top:.12,bottom:.2}},timeScale:{timeVisible:false,secondsVisible:false,rightOffset:6,minBarSpacing:.5,tickMarkFormatter:(time,type)=>{const date=dateKey(time);return date?(type===0?date.slice(0,4):date.slice(5)):'';}},localization:{locale:'zh-CN',dateFormat:'yyyy-MM-dd',timeFormatter:time=>dateKey(time)||'',priceFormatter:price=>Number(price).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}});
      series=chart.addSeries(lib.CandlestickSeries,{priceFormat:{type:'price',precision:2,minMove:.01}});markers=lib.createSeriesMarkers(series,[]);
      chart.subscribeCrosshairMove(crosshair);chart.subscribeClick(crosshair);theme();
      if(typeof root.ResizeObserver==='function'){resizeObserver=new root.ResizeObserver(()=>{if(opened&&chart){chart.applyOptions({autoSize:true});hideTip();}});resizeObserver.observe(chartNode);}
      if(typeof root.MutationObserver==='function'){themeObserver=new root.MutationObserver(theme);themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-xhy-theme','data-theme']});themeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});}
      return true;
    }
    function drawMarkers(){if(markers&&data)markers.setMarkers(markerRows(buys,data.candles,colors().accent));}
    function readout(row){
      if(!row)return;inspectedDate=row.time;node('dcaCandleDay').textContent=row.time+' · 北京时间';
      node('dcaCandleOHLC').textContent=['开 '+row.open,'高 '+row.high,'低 '+row.low,'收 '+row.close].join('　');
      const buy=buys.get(row.time);node('dcaCandleBuy').textContent=buy?'B 当日买入 '+(buy.usdt===null?'USDT 金额待核对':amount(buy.usdt)+' USDT'):'当日无买入';
    }
    function crosshair(param){
      if(!opened||!data||!param||!param.point){hideTip();return;}
      const id=typeof param.hoveredObjectId==='string'&&param.hoveredObjectId.startsWith('buy-')?param.hoveredObjectId.slice(4):null;
      const date=id||dateKey(param.time),row=data.candles.find(item=>item.time===date);if(row)readout(row);
      const buy=buys.get(date);if(!buy){hideTip();return;}
      node('dcaCandleTipDate').textContent=date+' · B 买入';node('dcaCandleTipUSDT').textContent=buy.usdt===null?'USDT 金额待核对':amount(buy.usdt)+' USDT';
      node('dcaCandleTipDetail').textContent=amount(buy.btc,8)+' BTC'+(buy.buys===null?'':' · '+buy.buys+' 笔成交');tip.hidden=false;
      const w=node('dcaCandleStage').clientWidth||800,h=node('dcaCandleStage').clientHeight||400;
      tip.style.left=Math.max(8,Math.min(param.point.x+16,w-(tip.offsetWidth||190)-8))+'px';tip.style.top=Math.max(8,Math.min(param.point.y+16,h-(tip.offsetHeight||90)-8))+'px';
    }
    function rangeView(kind,date){
      if(!chart||!data||!data.candles.length)return;hideTip();const list=data.candles,scale=chart.timeScale(),last=list.length-1;
      if(kind==='all')scale.fitContent();
      else if(kind==='year')scale.setVisibleLogicalRange({from:Math.max(-2,last-365),to:last+5});
      else if(kind==='latest')scale.setVisibleLogicalRange({from:Math.max(-2,last-120),to:last+5});
      else {
        const target=kind==='first'?[...buys.keys()].sort()[0]:date;
        if(!target){node('dcaCandleState').textContent='尚无已核对买入记录';return;}
        let index=list.findIndex(row=>row.time>=target);if(index<0)index=last;
        scale.setVisibleLogicalRange({from:Math.max(-2,index-40),to:Math.min(last+5,index+80)});readout(list[index]);node('dcaCandleDate').value=target;
      }
      if(['all','year','latest'].includes(kind))readout(list[last]);
      for(const button of node('dcaCandleRanges').querySelectorAll('button[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===kind));
    }
    function zoom(factor){
      if(!chart)return;const scale=chart.timeScale(),range=scale.getVisibleLogicalRange();if(!range)return;
      const middle=(range.from+range.to)/2,width=Math.max(12,Math.min(20000,(range.to-range.from)*factor));scale.setVisibleLogicalRange({from:middle-width/2,to:middle+width/2});hideTip();
    }
    function paint(next){
      const previous=data;data=next;
      if(!makeChart())return;
      const list=next.candles,old=previous&&previous.candles||[];
      // Update the last bars in place; never reset an inspected historical range.
      const samePrefix=old.length&&list.length>=old.length&&old.slice(0,-1).every((row,index)=>{const b=list[index];return b&&row.time===b.time&&row.open===b.open&&row.high===b.high&&row.low===b.low&&row.close===b.close;});
      if(samePrefix){for(let index=old.length-1;index<list.length;index++)series.update({...list[index]});}
      else{const range=!initial&&chart.timeScale().getVisibleLogicalRange();series.setData(list.map(row=>({...row})));if(range)chart.timeScale().setVisibleLogicalRange(range);}
      drawMarkers();node('dcaCandleEmpty').hidden=!!list.length;
      if(list.length){node('dcaCandleDate').max=list[list.length-1].time;if(initial){initial=false;rangeView(selection?'date':'latest',selection);if(!selection)readout(list[list.length-1]);}}
      if(inspectedDate)readout(list.find(row=>row.time===inspectedDate));
      const quotedAt=Date.parse(next.asOf),age=clock()-quotedAt;
      const stale=next.status!=='fresh'||!next.complete||!Number.isFinite(quotedAt)||age>15000||age< -2000;node('dcaCandleDot').dataset.state=stale?'stale':'live';
      node('dcaCandleState').textContent=!stale?'实时同步 · 5 秒':!next.complete&&list.length?'部分历史待补齐':list.length?'行情暂未更新 · 保留历史':'行情暂不可用，自动重试';
      node('dcaCandleCoverage').textContent=(list.length?list[0].time+' — '+list[list.length-1].time:'2024-07-01 起')+' · 北京时间 · 滚轮缩放 / 拖动平移 / B 查看买入';
      node('dcaCandleState').title=[next.source,next.asOf?new Date(next.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'',next.error||''].filter(Boolean).join(' · ');
    }
    function cancelRead(){if(!read)return;const token=read;read=null;sequence++;token.cancelled=true;clearTimer(token.timeout);token.controller.abort();token.cancel();}
    async function load(){
      if(!active()||read)return;stop();const token={controller:new root.AbortController(),sequence:++sequence,cancelled:false};read=token;let refill=false;
      const interrupted=new Promise((_,reject)=>{token.cancel=()=>reject(new Error('cancelled'));});token.timeout=setTimer(()=>{token.controller.abort();token.cancel();},TIMEOUT_MS);
      try{
        const tail=data&&data.complete&&data.candles.length&&!needsHistory;
        const request=(async()=>{const r=await fetcher('/api/wallet/btc-dca-candles'+(tail?'?tail=1':''),{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:token.controller.signal});if(!r.ok)throw new Error('unavailable');const next=normalized(await r.json());if(!next)throw new Error('invalid');return next;})();
        const next=await Promise.race([request,interrupted]);if(!active()||token.cancelled||token.sequence!==sequence)return;
        if(next.mode==='tail'&&data&&data.candles.length&&next.candles.length){
          const last=data.candles[data.candles.length-1].time;
          if(dateTime(next.candles[0].time)>dateTime(last)+DAY){needsHistory=true;refill=true;node('dcaCandleState').textContent='补齐中断期间的行情';return;}
          const merged=new Map(data.candles.map(row=>[row.time,row]));for(const row of next.candles)merged.set(row.time,row);
          next.candles=[...merged.values()].sort((a,b)=>a.time.localeCompare(b.time));next.complete=data.complete&&next.complete;
        }else if(next.mode!=='tail'){
          needsHistory=false;
          if(data&&data.candles.length&&next.candles.length&&!next.complete){
            const retained=new Map(data.candles.map(row=>[row.time,row]));for(const row of next.candles)retained.set(row.time,row);
            next.candles=[...retained.values()].sort((a,b)=>a.time.localeCompare(b.time));
          }
        }
        if(data&&data.candles.length&&(!next.candles.length||next.asOf&&data.asOf&&Date.parse(next.asOf)<Date.parse(data.asOf))){node('dcaCandleState').textContent='行情暂未更新 · 保留历史';node('dcaCandleDot').dataset.state='stale';return;}
        paint(next);
      }catch(_){if(active()&&!token.cancelled&&token.sequence===sequence){node('dcaCandleState').textContent=data&&data.candles.length?'行情暂未更新 · 保留历史':'行情暂不可用，自动重试';node('dcaCandleDot').dataset.state='stale';if(!data)node('dcaCandleEmpty').textContent='暂时无法读取日 K 线，稍后自动重试。';}}
      finally{clearTimer(token.timeout);if(read===token){read=null;if(refill&&active()){stop();timer=setTimer(()=>{timer=null;load();},0);}else schedule();}}
    }
    function updateBuys(next){model=next;buys=purchases(model);drawMarkers();hideTip();if(data&&data.candles.length)readout(data.candles.find(row=>row.time===inspectedDate)||data.candles[data.candles.length-1]);}
    function open(next,selectedDate=null){
      if(disposed)return;if(!opened)opener=document.activeElement||null;updateBuys(next);selection=dateKey(selectedDate);opened=true;sheet.hidden=false;
      node('dcaCandleState').textContent='正在更新行情';node('dcaCandleDot').dataset.state='stale';
      makeChart();if(data){theme();if(selection)rangeView('date',selection);}
      if(typeof dialog.focus==='function')dialog.focus();load();
    }
    function close(){
      if(!opened)return;opened=false;sheet.hidden=true;stop();cancelRead();hideTip();
      if(opener&&opener.isConnected&&typeof opener.focus==='function')opener.focus();opener=null;
    }
    function visibility(){if(active())load();else{stop();cancelRead();hideTip();}}
    function sheetClick(event){
      if(event.target===sheet){close();return;}const button=event.target.closest&&event.target.closest('button');if(!button)return;
      if(button.dataset.view)rangeView(button.dataset.view);
      else if(button.id==='dcaCandleClose')close();else if(button.id==='dcaCandleZoomIn')zoom(.72);else if(button.id==='dcaCandleZoomOut')zoom(1/.72);
      else if(button.id==='dcaCandleJump'){const date=node('dcaCandleDate').value;if(dateTime(date)!==null)rangeView('date',date);}
    }
    function keydown(event){
      if(event.key==='Escape'){event.preventDefault();close();return;}
      const input=event.target&&['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName);
      if(!input&&['+','=','-'].includes(event.key)){event.preventDefault();zoom(event.key==='-'?1/.72:.72);return;}
      if(!input&&['ArrowLeft','ArrowRight'].includes(event.key)&&chart){const range=chart.timeScale().getVisibleLogicalRange();if(range){event.preventDefault();const delta=(range.to-range.from)*.2*(event.key==='ArrowLeft'?-1:1);chart.timeScale().setVisibleLogicalRange({from:range.from+delta,to:range.to+delta});}return;}
      if(event.key!=='Tab')return;const items=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href], [tabindex="0"]')];if(!items.length)return;
      if(event.shiftKey&&(document.activeElement===items[0]||document.activeElement===dialog)){event.preventDefault();items[items.length-1].focus();}else if(!event.shiftKey&&document.activeElement===items[items.length-1]){event.preventDefault();items[0].focus();}
    }
    const events=[[sheet,'click',sheetClick],[sheet,'keydown',keydown],[chartNode,'pointerleave',hideTip],[document,'visibilitychange',visibility],[root,'pagehide',close],[root,'blur',()=>{if(root.parent&&root.parent!==root)close();}]];
    for(const [target,event,handler]of events)target.addEventListener(event,handler);
    function destroy(){if(disposed)return;close();disposed=true;for(const [target,event,handler]of events)target.removeEventListener(event,handler);resizeObserver?.disconnect();themeObserver?.disconnect();markers?.detach();chart?.remove();sheet.remove();}
    const controller={open,close,updateBuys,destroy,refresh:load,isOpen:()=>opened};sheet.__controller=controller;return controller;
  }
  return {START,REFRESH_MS,TIMEOUT_MS,dateTime,dateKey,amount,normalized,purchases,markerRows,mount};
});
