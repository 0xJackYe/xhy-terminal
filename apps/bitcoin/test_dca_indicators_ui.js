'use strict';
const assert=require('node:assert/strict');
const api=require('./terminal/dist/dca-indicators.js');
const candles=[{time:'2026-11-10'},{time:'2026-11-11'},{time:'2026-11-12'}];
const buys=new Map([['2026-11-10',{btc:'0.00031335633'}],['2026-11-12',{btc:'0.00002681316'}]]);
const distribution={bucket_usdt:'5000',priced_btc:'0.009',unpriced_btc:'0.001',bins:[{from:'60000',to:'65000',btc:'0.006'},{from:'65000',to:'70000',btc:'0.003'}]};
function harness({mutateInput=false}={}){
  let logical={from:12,to:40},offset=0;const added=[],removed=[],attached=[],detached=[],paneHeights=[300],rangeCalls=[];
  const panes=[{getHeight:()=>paneHeights[0],setHeight:value=>{paneHeights[0]=value;}}];
  const scale={width:()=>500,getVisibleLogicalRange:()=>({...logical}),setVisibleLogicalRange:value=>{logical={...value};rangeCalls.push({...value});}};
  const chart={timeScale:()=>scale,panes:()=>panes,
    addSeries(type,options,pane){
      if(!panes[1]){paneHeights[1]=100;panes[1]={getHeight:()=>paneHeights[1],setHeight:value=>{paneHeights[1]=value;}};}
      const histogram={type,options:{...options},pane,sets:[],scales:[],applyOptions(value){this.options={...this.options,...value};},priceScale(){return {applyOptions:value=>this.scales.push(value)};},setData(value){this.sets.push(value);if(mutateInput)for(const row of value){const [year,month,day]=row.time.split('-').map(Number);row.time={year,month,day};}}};added.push(histogram);return histogram;
    },removeSeries(value){removed.push(value);panes.length=1;paneHeights.length=1;}
  };
  const series={priceToCoordinate:value=>200-(value-60000)/100+offset,attachPrimitive(primitive){attached.push(primitive);primitive.attached({chart,series,requestUpdate:()=>primitive.updateAllViews()});primitive.updateAllViews();},detachPrimitive(primitive){detached.push(primitive);primitive.detached();}};
  const lib={HistogramSeries:{type:'histogram'}},controller=api.create({chart,series,lib});
  return {chart,series,lib,controller,added,removed,attached,detached,panes,paneHeights,rangeCalls,range:()=>logical,shift:value=>{offset=value;}};
}
let count=0;function check(name,fn){fn();count++;console.log('OK '+name);}
check('daily bars use personal net BTC and preserve zero-buy calendar days',()=>{
  assert.deepEqual(api.dailyRows(buys,candles),[{time:'2026-11-10',value:.00031335633},{time:'2026-11-11',value:0},{time:'2026-11-12',value:.00002681316}]);
  const invalid=new Map(buys);invalid.set('2026-11-12',{btc:null});assert.deepEqual(api.dailyRows(invalid,candles).at(-1),{time:'2026-11-12'});
  invalid.set('2020-01-01',{btc:'10'});assert.equal(api.dailyRows(invalid,[...candles,candles[0],{time:'2026-02-30'}]).length,3,'no extra dates, invalid dates or duplicate candles');
});
check('price buckets retain their original precision and reject malformed or overlapping data',()=>{
  const rows=api.profileRows(distribution);assert.equal(rows[0].btc,'0.006');assert.equal(rows[0].low,60000);assert.equal(rows[1].id,'buy-profile-65000');
  for(const bins of [[{from:'60000',to:'60000',btc:'1'}],[{from:'60000',to:'65000',btc:'-1'}],[{from:'60000',to:'65000',btc:'NaN'}],[{from:'60000',to:'65000',btc:'1'},{from:'64000',to:'70000',btc:'1'}]])assert.deepEqual(api.profileRows({bins}),[]);
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
  assert.equal(profile.items.length,2);assert.equal(profile.items[0].x,0);assert.equal(profile.items[0].width,110);assert.equal(profile.items[1].width,55);assert.equal(profile.items[0].y,150);assert.equal(profile.items[0].height,49);
  assert.equal(profile.paneViews()[0].zOrder(),'bottom');assert.equal(profile.hitTest(20,170).externalId,'buy-profile-60000');assert.equal(profile.hitTest(200,170),null);assert.equal(typeof profile.autoscaleInfo,'undefined','profile never forces the candle price range');
  h.shift(40);profile.updateAllViews();assert.equal(profile.items[0].y,190);assert.equal(profile.items[0].width,110,'panning does not renormalize buy quantities');
  const info=h.controller.getProfileBin('buy-profile-60000');assert.deepEqual(info,{from:'60000',to:'65000',btc:'0.006'});info.btc='999';assert.equal(h.controller.getProfileBin('buy-profile-60000').btc,'0.006');
  h.controller.destroy();
});
check('profile rendering clips offscreen bins and draws a translucent narrow overlay',()=>{
  const h=harness();h.controller.update({buys,candles,distribution:{bins:[...distribution.bins,{from:'90000',to:'95000',btc:'.001'}]}});h.controller.setProfileVisible(true);
  // The backend serialises a leading zero; malformed decimals are never drawn.
  assert.equal(h.attached[0].items.length,0);
  h.controller.update({buys,candles,distribution:{bins:[...distribution.bins,{from:'90000',to:'95000',btc:'0.001'}]}});const profile=h.attached[0];assert.equal(profile.items.length,2);
  h.shift(-170);profile.updateAllViews();assert.equal(profile.items.length,1);assert.equal(profile.items[0].y,0);assert.equal(profile.items[0].height,29);
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
console.log(count+' DCA indicator UI checks passed');
