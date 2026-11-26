'use strict';
const assert=require('node:assert/strict');
const api=require('./terminal/dist/dca-indicators.js');
const candles=[{time:'2026-11-10'},{time:'2026-11-11'},{time:'2026-11-12'}];
const buys=new Map([['2026-11-10',{btc:'0.00031335633'}],['2026-11-12',{btc:'0.00002681316'}]]);
const distribution={bucket_usdt:'2000',priced_btc:'0.009',unpriced_btc:'0.001',bins:[{from:'60000',to:'62000',btc:'0.006'},{from:'62000',to:'64000',btc:'0.003'}]};
function harness({mutateInput=false,priceScaleId='right'}={}){
  let logical={from:12,to:40},offset=0;const added=[],removed=[],attached=[],detached=[],paneHeights=[300],rangeCalls=[],coordinateTimes=[];
  const panes=[{getHeight:()=>paneHeights[0],setHeight:value=>{paneHeights[0]=value;}}];
  const scale={width:()=>500,getVisibleLogicalRange:()=>({...logical}),setVisibleLogicalRange:value=>{logical={...value};rangeCalls.push({...value});},timeToCoordinate(time){coordinateTimes.push(time);return Number(time.slice(-2))*10;}};
  const chart={timeScale:()=>scale,panes:()=>panes,
    addSeries(type,options,pane){
      if(pane===1&&!panes[1]){paneHeights[1]=100;panes[1]={getHeight:()=>paneHeights[1],setHeight:value=>{paneHeights[1]=value;}};}
      const plotted={type,options:{...options},pane,sets:[],scales:[],applyOptions(value){this.options={...this.options,...value};},priceScale(){return {applyOptions:value=>this.scales.push(value)};},setData(value){this.sets.push(value);if(mutateInput)for(const row of value){const [year,month,day]=row.time.split('-').map(Number);row.time={year,month,day};}}};added.push(plotted);return plotted;
    },removeSeries(value){removed.push(value);if(value.pane===1){panes.length=1;paneHeights.length=1;}}
  };
  const series={options:()=>({priceScaleId}),priceToCoordinate:value=>200-(value-60000)/100+offset,attachPrimitive(primitive){attached.push(primitive);primitive.attached({chart,series,requestUpdate:()=>primitive.updateAllViews?.()});primitive.updateAllViews?.();},detachPrimitive(primitive){detached.push(primitive);primitive.detached();}};
  const lib={HistogramSeries:{type:'histogram'},LineSeries:{type:'line'},LineType:{WithSteps:1},LineStyle:{Solid:0}},controller=api.create({chart,series,lib});
  return {chart,series,lib,controller,added,removed,attached,detached,panes,paneHeights,rangeCalls,coordinateTimes,range:()=>logical,shift:value=>{offset=value;}};
}
let count=0;function check(name,fn){fn();count++;console.log('OK '+name);}
check('daily bars use personal net BTC and preserve zero-buy calendar days',()=>{
  assert.deepEqual(api.dailyRows(buys,candles),[{time:'2026-11-10',value:.00031335633},{time:'2026-11-11',value:0},{time:'2026-11-12',value:.00002681316}]);
  const invalid=new Map(buys);invalid.set('2026-11-12',{btc:null});assert.deepEqual(api.dailyRows(invalid,candles).at(-1),{time:'2026-11-12'});
  invalid.set('2020-01-01',{btc:'10'});assert.equal(api.dailyRows(invalid,[...candles,candles[0],{time:'2026-02-30'}]).length,3,'no extra dates, invalid dates or duplicate candles');
});
check('price buckets retain their original precision and reject malformed or overlapping data',()=>{
  const rows=api.profileRows(distribution);assert.equal(rows[0].btc,'0.006');assert.equal(rows[0].low,60000);assert.equal(rows[1].id,'buy-profile-62000');
  for(const bins of [[{from:'60000',to:'60000',btc:'1'}],[{from:'60000',to:'62000',btc:'-1'}],[{from:'60000',to:'62000',btc:'NaN'}],[{from:'60000',to:'62000',btc:'1'},{from:'61000',to:'64000',btc:'1'}]])assert.deepEqual(api.profileRows({bins}),[]);
  assert.deepEqual(api.profileRows(null),[]);assert.deepEqual(api.profileRows({bins:[]}),[]);
});
check('indicators are dormant until toggled and preserve inspected time ranges',()=>{
  const h=harness();h.controller.update({buys,candles,distribution});assert.equal(h.added.length,0);assert.equal(h.attached.length,0);
  assert.equal(h.controller.setProfileVisible(true),true);assert.equal(h.attached.length,1);assert.deepEqual(h.range(),{from:12,to:40});
  assert.equal(h.controller.setDailyVisible(true),true);assert.equal(h.added.length,1);assert.equal(h.added[0].pane,1);assert.equal(h.added[0].options.priceFormat.precision,8);assert.equal(h.added[0].options.priceLineVisible,false);assert.equal(h.added[0].options.priceScaleId,'buy-volume');assert.equal(h.added[0].scales[0].visible,undefined,'keep the default right-axis widget for LWC multi-pane layout');
  assert.ok(h.paneHeights[1]>=60&&h.paneHeights[1]<=100);assert.deepEqual(h.range(),{from:12,to:40});
  h.controller.setProfileVisible(true);h.controller.setDailyVisible(true);assert.equal(h.added.length,1);assert.equal(h.attached.length,1);
  h.controller.destroy();
});
check('horizontal bucket lengths represent BTC and stay anchored to the native price scale',()=>{
  const h=harness();h.controller.update({buys,candles,distribution});h.controller.setProfileVisible(true);const profile=h.attached[0];
  assert.equal(profile.items.length,2);assert.equal(profile.items[0].x,0);assert.equal(profile.items[0].width,110);assert.equal(profile.items[1].width,55);assert.equal(profile.items[0].y,180);assert.equal(profile.items[0].height,19);assert.equal(profile.items[1].y,160);assert.equal(profile.items[1].height,19);
  assert.equal(profile.paneViews()[0].zOrder(),'bottom');assert.equal(profile.hitTest(20,190).externalId,'buy-profile-60000');assert.equal(profile.hitTest(20,170).externalId,'buy-profile-62000');assert.equal(profile.hitTest(200,190),null);assert.equal(typeof profile.autoscaleInfo,'undefined','profile never forces the candle price range');
  h.shift(40);profile.updateAllViews();assert.equal(profile.items[0].y,220);assert.equal(profile.items[0].width,110,'panning does not renormalize buy quantities');
  const info=h.controller.getProfileBin('buy-profile-60000');assert.deepEqual(info,{from:'60000',to:'62000',btc:'0.006'});info.btc='999';assert.equal(h.controller.getProfileBin('buy-profile-60000').btc,'0.006');
  h.controller.destroy();
});
check('profile rendering clips offscreen bins and draws a translucent narrow overlay',()=>{
  const h=harness();h.controller.update({buys,candles,distribution:{bins:[...distribution.bins,{from:'90000',to:'92000',btc:'.001'}]}});h.controller.setProfileVisible(true);
  // The backend serialises a leading zero; malformed decimals are never drawn.
  assert.equal(h.attached[0].items.length,0);
  h.controller.update({buys,candles,distribution:{bins:[...distribution.bins,{from:'90000',to:'92000',btc:'0.001'}]}});const profile=h.attached[0];assert.equal(profile.items.length,2);
  h.shift(-190);profile.updateAllViews();assert.equal(profile.items.length,1);assert.equal(profile.items[0].y,0);assert.equal(profile.items[0].height,9);
  const paint=[],ctx={globalAlpha:1,save(){this.savedAlpha=this.globalAlpha;},restore(){this.globalAlpha=this.savedAlpha;},fillRect(x,y,width,height){paint.push({x,y,width,height,alpha:this.globalAlpha,color:this.fillStyle});}};
  profile.draw({useMediaCoordinateSpace:fn=>fn({context:ctx})});assert.ok(paint.every(row=>row.width<=110&&row.x>=0&&row.y>=0&&row.alpha<1));assert.equal(ctx.globalAlpha,1);
  h.controller.destroy();
});
check('new buy snapshots update personal volume without resetting pan or mutating application dates',()=>{
  const h=harness({mutateInput:true});h.controller.update({buys,candles,distribution});h.controller.setDailyVisible(true);const histogram=h.added[0];assert.equal(histogram.sets[0][0].time.year,2026);
  const changed=new Map(buys);changed.set('2026-11-12',{btc:'0.001'});h.controller.update({buys:changed,candles,distribution});assert.equal(histogram.sets.length,2);assert.equal(histogram.sets[1].at(-1).value,.001);assert.deepEqual(h.range(),{from:12,to:40});assert.equal(candles[0].time,'2026-11-10');
  h.controller.update({buys:changed,candles,distribution});assert.equal(histogram.sets.length,2,'unchanged 5-second market ticks do not rewrite personal volume');
  h.controller.setDailyVisible(false);h.controller.setDailyVisible(true);assert.equal(h.added[1].sets[0][0].time.year,2026,'a native time normalisation never corrupts the saved series data');h.controller.destroy();
});
check('themes update both indicators, account clearing removes old quantities, and toggles release resources',()=>{
  const h=harness();h.controller.update({buys,candles,distribution});h.controller.setProfileVisible(true);h.controller.setDailyVisible(true);h.controller.theme({profile:'#aabbcc',volume:'#334455'});
  assert.equal(h.attached[0].color,'#aabbcc');assert.equal(h.added[0].options.color,'#334455');
  h.controller.update({buys:new Map(),candles,distribution:{bins:[]}});assert.equal(h.attached[0].items.length,0);assert.equal(h.controller.getProfileBin('buy-profile-60000'),null);assert.ok(h.added[0].sets.at(-1).every(row=>row.value===0));
  h.controller.setProfileVisible(false);h.controller.setDailyVisible(false);assert.equal(h.detached.length,1);assert.equal(h.removed.length,1);assert.equal(h.controller.getProfileBin('buy-profile-60000'),null);
  h.controller.destroy();h.controller.destroy();assert.equal(h.controller.setDailyVisible(true),false);assert.equal(h.controller.setProfileVisible(true),false);assert.equal(h.added.length,1);
});
check('destruction detaches active indicators without touching the candlestick series',()=>{
  const h=harness();h.controller.update({buys,candles,distribution});h.controller.setProfileVisible(true);h.controller.setDailyVisible(true);h.controller.destroy();assert.equal(h.detached.length,1);assert.equal(h.removed.length,1);assert.equal(h.removed[0],h.added[0]);assert.notEqual(h.removed[0],h.series);assert.equal(h.detached[0].items.length,0);
  assert.equal(api.create(),null);const noHistogram=harness();delete noHistogram.lib.HistogramSeries;assert.equal(noHistogram.controller.setDailyVisible(true),false);assert.equal(noHistogram.added.length,0);noHistogram.controller.destroy();
});
const candleDates=(...times)=>times.map(time=>({time}));
check('purchase averages weight actual spend by net BTC across inclusive calendar windows',()=>{
  const h=harness(),dates=candleDates('2026-09-30','2026-10-01','2026-11-08','2026-11-09','2026-11-15','2026-11-16','2026-12-01','2026-12-02','2026-12-29','2026-12-30');
  const transactions=new Map([['2026-11-09',{usdt:'90000',btc:'3'}],['2026-11-02',{usdt:'10000',btc:'1'}],['2026-10-01',{usdt:'10000',btc:'2'}],['2027-01-01',{usdt:'1',btc:'10'}]]);
  const c=h.controller;c.update({buys:transactions,candles:dates});
  assert.equal(h.added.length,0);
  assert.equal(c.setAverageWindow('all'),'all');
  assert.equal(c.averageAt('2026-09-30'),null,'no backfill before the first buy');
  assert.equal(c.averageAt('2026-10-01'),5000);
  assert.equal(c.averageAt('2026-11-08'),20000/3,'a buy without its own candle still counts');
  assert.equal(c.averageAt('2026-11-09'),110000/6);
  assert.equal(c.averageAt('2026-12-30'),110000/6,'days without buys leave the cumulative average unchanged');
  assert.equal(c.setAverageWindow('7'),'7');
  assert.equal(c.averageAt('2026-11-08'),10000);
  assert.equal(c.averageAt('2026-11-09'),30000);
  assert.equal(c.averageAt('2026-11-15'),30000);
  assert.equal(c.averageAt('2026-11-16'),null,'an empty window has no average');
  assert.equal(c.setAverageWindow('30'),'30');
  assert.equal(c.averageAt('2026-12-01'),25000);
  assert.equal(c.averageAt('2026-12-02'),30000);
  assert.equal(c.setAverageWindow('90'),'90');
  assert.equal(c.averageAt('2026-12-29'),110000/6);
  assert.equal(c.averageAt('2026-12-30'),25000);
  c.destroy();
});
check('unpriced purchases make the window unavailable and break the step line until they roll out',()=>{
  const h=harness();const c=h.controller;
  h.chart.timeScale().setVisibleLogicalRange({from:0,to:6});
  const dates=candleDates('2026-11-08','2026-11-09','2026-11-10','2026-11-16','2026-11-17','2026-11-18','2026-11-19');
  const transactions=new Map([['2026-11-08',{usdt:'60000',btc:'1'}],['2026-11-10',{usdt:null,btc:'1'}],['2026-11-16',{usdt:'70000',btc:'1'}],['2026-11-18',{usdt:'74000',btc:'1'}]]);
  c.update({buys:transactions,candles:dates});c.setAverageWindow('7');
  const [line]=h.added,[gaps]=h.attached;
  assert.equal(line.options.lineVisible,false);
  assert.equal(c.averageAt('2026-11-09'),60000);
  assert.equal(c.averageAt('2026-11-10'),null);
  assert.equal(c.averageAt('2026-11-16'),null);
  assert.equal(c.averageAt('2026-11-17'),70000);
  assert.equal(c.averageAt({year:2026,month:11,day:18}),72000);
  assert.deepEqual(line.sets[0].slice(2,4),dates.slice(2,4));
  c.theme({average:'#123456'});
  const path=[],ctx={save(){},restore(){},setLineDash(){},beginPath(){},moveTo(x,y){path.push(['move',x,y]);},lineTo(x,y){path.push(['line',x,y]);},stroke(){}};
  gaps.draw({useMediaCoordinateSpace:fn=>fn({context:ctx})});
  assert.equal(ctx.strokeStyle,'#123456');
  assert.deepEqual(path.filter(point=>point[0]==='move'),[['move',80,200],['move',170,100]],'two paths with no stroke between valid spans');
  assert.ok(path.some((point,index)=>point[1]===180&&point[2]===100&&path[index+1]?.[1]===180&&path[index+1]?.[2]===80),'a change in value draws a step at its candle');
  h.coordinateTimes.length=0;h.chart.timeScale().setVisibleLogicalRange({from:0,to:1});
  gaps.draw({useMediaCoordinateSpace:fn=>fn({context:ctx})});
  assert.deepEqual(h.coordinateTimes,dates.slice(0,2).map(row=>row.time),'panning limits the path to visible points and a one-bar buffer');
  c.setAverageWindow('all');
  assert.equal(c.averageAt('2026-11-19'),null);
  assert.equal(line.options.lineVisible,true,'native steps render a single uninterrupted run');
  assert.equal(h.detached[0],gaps);c.destroy();
});
check('the dedicated exact purchase snapshot preserves tiny buys after large balances roll out',()=>{
  const h=harness();const c=h.controller;
  const exactBuys=new Map([['2026-11-01',{usdt:'1000000000000',btc:'100000000'}],['2026-11-07',{usdt:'0.0000000000001',btc:'0.000000000000000001'}]]);
  const roundedBuys=new Map([['2026-11-01',{usdt:'1000000000000',btc:'100000000'}]]);
  c.update({buys:roundedBuys,averageBuys:exactBuys,candles:candleDates('2026-11-07','2026-11-08')});
  c.setAverageWindow('7');
  assert.equal(c.averageAt('2026-11-07'),10000);
  assert.equal(c.averageAt('2026-11-08'),100000);
  c.setDailyVisible(true);
  assert.ok(h.added[1].sets[0].every(row=>row.value===0),'exact average-only buys leave daily volume behavior unchanged');
  c.destroy();
});
check('average series shares the candle scale, handles refreshes, and clears on account changes or teardown',()=>{
  const h=harness({mutateInput:true,priceScaleId:'left'}),c=h.controller;
  const transactions=new Map([['2026-11-10',{usdt:'60000',btc:'1'}]]);
  assert.equal(c.setAverageWindow('all'),'all');
  assert.equal(h.added.length,0,'wait for usable purchase and candle data');
  c.update({buys:transactions,candles});const [line]=h.added;
  assert.equal(line.type,h.lib.LineSeries);assert.equal(line.pane,0);assert.equal(h.panes.length,1);
  assert.equal(line.options.priceScaleId,'left');assert.equal(line.options.lineType,h.lib.LineType.WithSteps);
  assert.equal(line.options.lineStyle,h.lib.LineStyle.Solid);assert.equal(line.options.lineVisible,true);
  for(const key of ['lastValueVisible','priceLineVisible','baseLineVisible','crosshairMarkerVisible'])assert.equal(line.options[key],false);
  assert.equal(line.sets[0][0].time.year,2026);assert.equal(candles[0].time,'2026-11-10');
  c.update({buys:new Map(transactions),candles:candles.map(row=>({...row,close:90000}))});
  assert.equal(line.sets.length,1,'quote changes do not rewrite average data or the current range');
  assert.equal(h.rangeCalls.length,1);
  c.theme({average:'#abcdef'});assert.equal(line.options.color,'#abcdef');
  c.update({buys:new Map(),candles});assert.deepEqual(line.sets.at(-1),[]);assert.equal(c.averageAt('2026-11-10'),null);
  c.update({buys:transactions,candles});assert.equal(c.setAverageWindow(null),null);assert.equal(h.removed[0],line);
  assert.equal(c.averageAt('2026-11-10'),null);assert.deepEqual(h.range(),{from:12,to:40});
  c.setAverageWindow('all');assert.equal(c.averageAt('2026-11-12'),60000);assert.equal(h.added.length,2);
  c.destroy();c.destroy();assert.equal(h.removed[1],h.added[1]);assert.equal(c.averageAt('2026-11-12'),null);
  assert.equal(c.setAverageWindow('all'),null);
  const unsupported=harness();delete unsupported.lib.LineSeries;
  assert.equal(unsupported.controller.setAverageWindow('all'),null);assert.equal(unsupported.added.length,0);unsupported.controller.destroy();
});
console.log(count+' DCA indicator UI checks passed');
