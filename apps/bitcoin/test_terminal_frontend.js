'use strict';
const assert = require('node:assert/strict');
const {beijingTime,marketHealth,clockPresentation,chartPoints,chartGeometry,validateSettings,eligibleNotifications,walletMessageAction,pageFromHash,createPageRouter,optionsMessageAction,soundLabel,createAudioPreview,fmtPrice,fmtPct} = require('./terminal/dist/terminal.js');
let checks = 0;
function test(name, callback) {callback();checks++;console.log('PASS ' + name);}
const now = Date.UTC(2026,9,14,7,0,0);
const live = {price:83427.81,event_ms:now-1000,received_ms:now-900,status:'live'};
test('All calendar labels use Beijing time, independent of OS timezone',()=>assert.equal(beijingTime(Date.UTC(2026,9,13,16,0,0),true),'2026-10-14 00:00:00'));
test('Invalid timestamps stay missing',()=>assert.equal(beijingTime(NaN),'—'));
test('Fresh live feed is marked live',()=>assert.equal(marketHealth(live,now,true).status,'live'));
test('Disconnected transport never claims fresh data is live',()=>assert.equal(marketHealth(live,now,false).status,'stale'));
test('Old market event is stale despite a recent receipt',()=>assert.equal(marketHealth({...live,event_ms:now-16000},now,true).status,'stale'));
test('Old local receipt is stale despite fresh event time',()=>assert.equal(marketHealth({...live,received_ms:now-16000},now,true).status,'stale'));
test('Future event clock cannot fabricate freshness',()=>assert.equal(marketHealth({...live,event_ms:now+6000},now,true).status,'stale'));
test('An explicitly degraded backend cannot be relabelled live',()=>assert.equal(marketHealth({...live,status:'error',error:'socket disconnected'},now,true).status,'error'));
test('Live trade without the midnight baseline remains pending',()=>{const health=marketHealth({...live,status:'waiting_baseline'},now,true);assert.equal(health.status,'connecting');assert.match(health.note,/基准/);});
test('REST bootstrap is never described as realtime',()=>assert.equal(marketHealth({...live,status:'waiting_live'},now,true).status,'connecting'));
test('Baseline and live waiting states never hide exchange clock errors',()=>{for(const status of ['waiting_live','waiting_baseline'])assert.equal(marketHealth({...live,status,error:'交易所行情时间超前，正在重新校准'},now,true).note,'交易所行情时间超前，正在重新校准');});
test('Waiting without a price also preserves the clock error',()=>assert.equal(marketHealth({status:'waiting_live',error:'校准失败'},now,true).note,'校准失败'));
test('Waiting for time gives exchange clock error priority',()=>{const health=marketHealth({...live,status:'waiting_time',error:'普通连接错误',clock_error:'交易所时间正在校准'},now,true);assert.equal(health.status,'connecting');assert.equal(health.note,'交易所时间正在校准');});
test('Time calibration shows the sign of local clock skew',()=>{assert.match(clockPresentation({clock_status:'calibrated',clock_offset_ms:10500}).text,/本机慢 10.5 秒/);assert.match(clockPresentation({clock_status:'calibrated',clock_offset_ms:-2100}).text,/本机快 2.1 秒/);});
test('Unverified initial time does not create an error warning',()=>assert.deepEqual(clockPresentation({clock_status:'unverified',clock_offset_ms:null}),{text:'',note:''}));
test('Expired calibration warns and cannot claim calibrated time',()=>{const clock=clockPresentation({clock_status:'expired',clock_offset_ms:10500,clock_error:'时间校准过期'});assert.equal(clock.note,'时间校准过期');assert.doesNotMatch(clock.text,/已校准/);});
test('Temporary calibration fetch warning leaves the valid calibration visible',()=>{const clock=clockPresentation({clock_status:'calibrated',clock_offset_ms:10500,clock_warning:'重新校准暂不可用'});assert.match(clock.text,/时间已校准/);assert.equal(clock.note,'重新校准暂不可用');});
test('Stopped and reconnecting backends get distinct warnings',()=>{assert.equal(marketHealth({...live,status:'stopped'},now,true).status,'error');assert.match(marketHealth({...live,status:'reconnecting'},now,true).text,/重连/);});
test('No price yields no live status',()=>assert.equal(marketHealth({status:'live'},now,true).status,'connecting'));
test('Nonpositive prices cannot be presented as a live market',()=>{for(const price of [0,-1])assert.equal(marketHealth({...live,price},now,true).status,'connecting');});
test('Chart filters missing and nonpositive prices and sorts event times',()=>assert.deepEqual(chartPoints([{time_ms:2,price:2},{time_ms:1,price:1},{time_ms:3,price:null},{time_ms:4,price:0}]),[{time_ms:1,price:1},{time_ms:2,price:2}]));
test('Duplicate chart timestamp keeps newest value',()=>assert.deepEqual(chartPoints([{time_ms:1,price:1},{time_ms:1,price:2}]),[{time_ms:1,price:2}]));
test('Large live history is bounded and keeps actual endpoints',()=>{const history=Array.from({length:3001},(_,i)=>({time_ms:i,price:100+i}));const result=chartPoints(history);assert.equal(result.length,1000);assert.deepEqual(result[0],history[0]);assert.deepEqual(result[999],history[3000]);});
test('Flat price chart remains finite',()=>{const geometry=chartGeometry([{time_ms:now,price:100},{time_ms:now+1000,price:100}]);assert(!/NaN|Infinity/.test(geometry.path));assert(geometry.max>geometry.min);});
test('One genuine price can draw without a fabricated series',()=>{const geometry=chartGeometry([{time_ms:now,price:100}]);assert.equal(geometry.points.length,1);assert.equal(geometry.xy.length,1);});
test('Empty history creates no fake chart',()=>assert.equal(chartGeometry([]),null));
test('Default 2.5 percent setting is validated numerically',()=>assert.deepEqual(validateSettings({threshold_pct:'2.5',metric:'daily_change',sound:true}),{threshold_pct:2.5,metric:'daily_change',sound:true}));
test('Three ascending alarm tiers are sent as numeric thresholds',()=>assert.deepEqual(validateSettings({threshold_pct:'2.5',thresholds_pct:['2.5','3.5','5'],metric:'daily_change',sound:true}),{threshold_pct:2.5,thresholds_pct:[2.5,3.5,5],metric:'daily_change',sound:true}));
test('Invalid, duplicated, descending and mismatched alarm tiers are rejected',()=>{for(const thresholds_pct of [[],[2.5,2.5],[2.5,2],[3.5,5],[2.5,Infinity],[2.5,3.5,5,6]])assert.throws(()=>validateSettings({threshold_pct:2.5,thresholds_pct,metric:'daily_change'}));});
test('Invalid thresholds and unknown metrics are rejected',()=>{for(const threshold_pct of ['','0',0.09,50.01,Infinity,'<script>'])assert.throws(()=>validateSettings({threshold_pct,metric:'daily_change'}));assert.throws(()=>validateSettings({threshold_pct:2.5,metric:'unknown'}));});
test('Changing to daily range remains a distinct setting',()=>assert.equal(validateSettings({threshold_pct:2.5,metric:'day_range',sound:false}).metric,'day_range'));
test('Only recent new market events can notify',()=>{const seen=new Set(['seen']);const alerts=[{id:'seen',kind:'market',at_ms:now},{id:'test',kind:'test',at_ms:now},{id:'old',kind:'market',at_ms:now-31000},{id:'new',kind:'market',at_ms:now-1000}];assert.deepEqual(eligibleNotifications(alerts,seen,now).map(a=>a.id),['new']);assert.equal(seen.size,4);});
test('Repeated snapshots cannot repeat the same notification',()=>{const seen=new Set();const alerts=[{id:'market-1',kind:'market',at_ms:now}];assert.equal(eligibleNotifications(alerts,seen,now).length,1);assert.equal(eligibleNotifications(alerts,seen,now).length,0);});
test('Future invalid alarm timestamps do not notify',()=>assert.equal(eligibleNotifications([{id:'future',kind:'market',at_ms:now+6000}],new Set(),now).length,0));
const walletOrigin='http://127.0.0.1:8766', walletWindow={};
const walletEvent=data=>({origin:walletOrigin,source:walletWindow,data});
test('Trusted wallet Escape exits only while wallet focus is active',()=>{assert.deepEqual(walletMessageAction(walletEvent({type:'wallet-escape'}),walletOrigin,walletWindow,true),{type:'escape'});assert.equal(walletMessageAction(walletEvent({type:'wallet-escape'}),walletOrigin,walletWindow,false),null);});
test('A foreign origin cannot exit wallet focus',()=>assert.equal(walletMessageAction({...walletEvent({type:'wallet-escape'}),origin:'https://foreign.example'},walletOrigin,walletWindow,true),null));
test('A different same-origin frame cannot exit wallet focus',()=>assert.equal(walletMessageAction({...walletEvent({type:'wallet-escape'}),source:{}},walletOrigin,walletWindow,true),null));
test('Trusted iframe height keeps both bounds',()=>{assert.deepEqual(walletMessageAction(walletEvent({type:'wallet-height',height:20}),walletOrigin,walletWindow,true),{type:'height',height:700});assert.deepEqual(walletMessageAction(walletEvent({type:'wallet-height',height:9999}),walletOrigin,walletWindow,false),{type:'height',height:5000});});
test('Unknown iframe messages and nonfinite height are ignored',()=>{assert.equal(walletMessageAction(walletEvent({type:'unknown'}),walletOrigin,walletWindow,true),null);assert.equal(walletMessageAction(walletEvent({type:'wallet-height',height:NaN}),walletOrigin,walletWindow,true),null);});
test('Direct page links and legacy bookmarks select the intended module',()=>{for(const hash of ['','#alerts','#price-alert','#unknown'])assert.equal(pageFromHash(hash),'alerts');for(const hash of ['#wallet','#wallet-panel'])assert.equal(pageFromHash(hash),'wallet');assert.equal(pageFromHash('#options'),'options');});
test('Options is loaded once across navigation and browser back/forward',()=>{const router=createPageRouter();assert.equal(router.change('#alerts').loadOptions,false);const first=router.change('#options');assert.equal(first.loadOptions,true);assert.equal(first.requestOptionsState,true);assert.equal(first.stopPreview,true);assert.equal(router.change('#wallet').loadOptions,false);const back=router.change('#options');assert.equal(back.loadOptions,false);assert.equal(back.requestOptionsState,true);assert.equal(router.change('#alerts').stopPreview,false);assert.equal(router.change('#options').loadOptions,false);});
test('Repeated and equivalent hashes do not reset the page or replay transitions',()=>{const router=createPageRouter();router.change('#wallet');assert.equal(router.change('#wallet-panel').changed,false);router.change('#options');const repeated=router.change('#options');assert.equal(repeated.changed,false);assert.equal(repeated.requestOptionsState,false);assert.equal(repeated.loadOptions,false);});
test('Browser preview stops on departure from alerts and stays untouched between other pages',()=>{const router=createPageRouter();router.change('#alerts');assert.equal(router.change('#wallet').stopPreview,true);assert.equal(router.change('#options').stopPreview,false);assert.equal(router.change('#alerts').stopPreview,false);});
const optionsWindow={},optionsEvent=data=>({origin:walletOrigin,source:optionsWindow,data});
test('Options focus is accepted only from its same-origin iframe on the options page',()=>{const e=optionsEvent({type:'options-focus',focused:true});assert.deepEqual(optionsMessageAction(e,walletOrigin,optionsWindow,'options'),{type:'focus',focused:true});assert.equal(optionsMessageAction(e,walletOrigin,optionsWindow,'wallet'),null);assert.equal(optionsMessageAction(e,walletOrigin,optionsWindow,'alerts'),null);assert.equal(optionsMessageAction({...e,origin:'https://foreign.example'},walletOrigin,optionsWindow,'options'),null);assert.equal(optionsMessageAction({...e,source:walletWindow},walletOrigin,optionsWindow,'options'),null);});
test('Options exits fullscreen only through a boolean focus state and ignores malformed messages',()=>{assert.deepEqual(optionsMessageAction(optionsEvent({type:'options-focus',focused:false}),walletOrigin,optionsWindow,'options'),{type:'focus',focused:false});for(const focused of [0,'false',null,undefined])assert.equal(optionsMessageAction(optionsEvent({type:'options-focus',focused}),walletOrigin,optionsWindow,'options'),null);assert.equal(optionsMessageAction(optionsEvent({type:'wallet-escape'}),walletOrigin,optionsWindow,'options'),null);});
test('Options content height reports never resize the viewport or create a chain-scroll feedback loop',()=>{for(const height of [200,1800,1e9,Infinity,NaN,'1000'])assert.equal(optionsMessageAction(optionsEvent({type:'options-height',height}),walletOrigin,optionsWindow,'options'),null);assert.equal(optionsMessageAction({...optionsEvent({type:'options-height',height:1800}),source:walletWindow},walletOrigin,optionsWindow,'options'),null);});
test('Missing, zero and negative values are displayed distinctly',()=>{assert.equal(fmtPrice(null),'—');assert.equal(fmtPrice(0),'0.00');assert.equal(fmtPct(0),'0.00%');assert.equal(fmtPct(-2.5),'-2.50%');assert.equal(fmtPct(2.5),'+2.50%');});
test('A completed backend call never claims the user heard the alarm',()=>{assert.equal(soundLabel({sound_status:'played'}),'播放调用完成');assert.equal(soundLabel({sound_status:'error'}),'声音不可用');assert.equal(soundLabel({sound_status:'silenced'}),'已停止');});
function previewFixture() {
  const sounds=[],reports=[];
  const preview=createAudioPreview(src=>{
    const listeners={};let resolve,reject;
    const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const audio={src,currentTime:2,volume:0,plays:0,pauses:0,resolve,reject,addEventListener:(type,callback)=>{listeners[type]=callback;},play(){this.plays++;return result;},pause(){this.pauses++;},emit:type=>listeners[type]()};
    sounds.push(audio);return audio;
  },(message,error=false)=>reports.push({message,error}));
  return {preview,sounds,reports};
}
async function audioTest(name, callback) {await callback();checks++;console.log('PASS '+name);}
async function checkPreview() {
  await audioTest('Each preview tier uses its own WAV and cancels the preceding sound',async()=>{
    const f=previewFixture();for(const level of [1,2,3]){f.preview.start(level);const audio=f.sounds.at(-1);assert.equal(audio.src,level===1?'/audio/alert.wav':`/audio/alert-${level}.wav`);audio.resolve();await Promise.resolve();}assert.equal(f.sounds[0].pauses,1);assert.equal(f.sounds[1].pauses,1);
  });
  await audioTest('Browser preview calls play synchronously and waits for its promise before claiming playback',async()=>{
    const f=previewFixture();f.preview.start();assert.equal(f.sounds[0].src,'/audio/alert.wav');assert.equal(f.sounds[0].plays,1);assert.equal(f.sounds[0].volume,1);assert.doesNotMatch(f.reports.at(-1).message,/正在通过/);
    f.sounds[0].resolve();await Promise.resolve();assert.equal(f.reports.at(-1).message,'正在试听。');
  });
  await audioTest('Rejected browser playback gives an actionable error instead of a success message',async()=>{
    const f=previewFixture();f.preview.start();f.sounds[0].reject(new Error('NotAllowedError'));await Promise.resolve();assert.equal(f.reports.at(-1).error,true);assert.match(f.reports.at(-1).message,/允许网页/);assert.equal(f.sounds[0].pauses,1);
  });
  await audioTest('Natural playback completion reports the ended preview',async()=>{
    const f=previewFixture();f.preview.start();f.sounds[0].resolve();await Promise.resolve();f.sounds[0].emit('ended');assert.equal(f.reports.at(-1).message,'试听已结束。');assert.equal(f.reports.at(-1).error,false);
  });
  await audioTest('Stopping cancels pending playback even if pause throws and ignores its late resolution',async()=>{
    const f=previewFixture();f.preview.start();f.sounds[0].pause=()=>{throw new Error('pause failed');};f.preview.stop();assert.equal(f.sounds[0].currentTime,0);const before=f.reports.length;f.sounds[0].resolve();await Promise.resolve();assert.equal(f.reports.length,before);
  });
  await audioTest('A replacement preview cannot be overwritten by old sound completion or failure',async()=>{
    const f=previewFixture();f.preview.start();const old=f.sounds[0];f.preview.start();const replacement=f.sounds[1];assert.equal(old.pauses,1);assert.equal(old.currentTime,0);replacement.resolve();await Promise.resolve();const before=f.reports.length;old.emit('ended');old.reject(new Error('stopped'));await Promise.resolve();assert.equal(f.reports.length,before);
  });
  await audioTest('Unsupported browser audio creation is reported without throwing out of the click handler',async()=>{
    const reports=[];const preview=createAudioPreview(()=>{throw new Error('Audio unavailable');},(message,error)=>reports.push({message,error}));assert.doesNotThrow(()=>preview.start());assert.equal(reports[0].error,true);
  });
  console.log(checks+' terminal frontend checks passed.');
}
checkPreview().catch(error=>{console.error(error);process.exitCode=1;});
