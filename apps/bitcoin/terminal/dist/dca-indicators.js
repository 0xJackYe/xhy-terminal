(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DCAIndicators=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const PROFILE_PREFIX='buy-profile-';
  const DAY_MS=86400000,AVERAGE_COLOR='#916122';
  const AVERAGE_WINDOWS=new Set(['all','7','30','90']);
  const decimal=value=>typeof value==='string'&&value.length<=512&&/^\d+(?:\.\d+)?$/.test(value);
  function dateKey(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
    const time=Date.parse(value+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?value:null;
  }
  function profileRows(distribution){
    if(!distribution||!Array.isArray(distribution.bins)||distribution.bins.length>20000)return [];
    const rows=[],seen=new Set();
    for(const bin of distribution.bins){
      if(!bin||!decimal(bin.from)||!decimal(bin.to)||!decimal(bin.btc))return [];
      const from=Number(bin.from),to=Number(bin.to),volume=Number(bin.btc);
      if(!Number.isFinite(from)||!Number.isFinite(to)||!Number.isFinite(volume)||from<0||to<=from||to>1e12||volume<=0||volume>1e12||seen.has(from))return [];
      rows.push({from:bin.from,to:bin.to,btc:bin.btc,low:from,high:to,volume,id:PROFILE_PREFIX+bin.from});seen.add(from);
    }
    rows.sort((a,b)=>a.low-b.low);
    if(rows.some((row,index)=>index&&row.low<rows[index-1].high))return [];
    return rows;
  }
  function dailyRows(buys,candles){
    const seen=new Set(),rows=[];
    for(const candle of Array.isArray(candles)?candles:[]){
      const time=dateKey(candle?.time);if(!time||seen.has(time))continue;seen.add(time);
      const buy=buys instanceof Map?buys.get(time):null;
      if(!buy){rows.push({time,value:0});continue;}
      const value=decimal(buy.btc)?Number(buy.btc):NaN;
      rows.push(Number.isFinite(value)&&value>=0&&value<=1e12?{time,value}:{time});
    }
    return rows.sort((a,b)=>a.time.localeCompare(b.time));
  }
  // Integrate the cost from one trade-day close up to the next. Two cursors
  // give the sum and covered days in a rolling window, even if candles omit dates.
  function costIntegral(changes){
    let index=0, previous=changes[0]?.day??0, value=null, sum=0, knownDays=0;
    return end=>{
      while(index<changes.length&&changes[index].day<end){
        const change=changes[index++];
        const days=change.day-previous;
        if(value!==null){sum+=value*days;knownDays+=days;}
        previous=change.day;
        value=change.value;
      }
      const days=value===null?0:end-previous;
      return {sum:sum+(value??0)*days,days:knownDays+days};
    };
  }

  function averageRows(costs,times,window){
    const changes=[];
    for(const [time,value] of costs){
      if(!dateKey(time)||value!==null&&(!Number.isFinite(value)||value<0||value>1e12))continue;
      changes.push({day:Date.parse(time+'T00:00:00Z')/DAY_MS,value});
    }
    changes.sort((a,b)=>a.day-b.day);
    const to=costIntegral(changes),from=costIntegral(changes),period=Number(window);
    const rows=[];
    let index=0,current=null,lastTime='';
    for(const time of times){
      if(!dateKey(time)||time<=lastTime)continue;
      lastTime=time;
      const day=Date.parse(time+'T00:00:00Z')/DAY_MS;
      let value=null;
      if(window==='all'){
        while(index<changes.length&&changes[index].day<=day)current=changes[index++].value;
        value=current;
      }else{
        const end=to(day+1),start=from(day+1-period);
        if(end.days-start.days===period)value=(end.sum-start.sum)/period;
      }
      rows.push(value===null?{time}:{time,value});
    }
    return rows;
  }
  // LineSeries connects the points on each side of whitespace. Use the native
  // series for scaling and draw the disjoint runs on the same pane when needed.
  class DisjointAverageLine{
    constructor(){this.rows=[];this.color=AVERAGE_COLOR;this.views=[{zOrder:()=>'normal',renderer:()=>this}];}
    attached({chart,series,requestUpdate}){this.chart=chart;this.series=series;this.requestUpdate=requestUpdate;}
    detached(){this.chart=null;this.series=null;this.requestUpdate=null;this.rows=[];}
    paneViews(){return this.views;}
    setData(rows){this.rows=rows;this.requestUpdate?.();}
    setColor(color){this.color=color;this.requestUpdate?.();}
    draw(target){
      const scale=this.chart?.timeScale(),range=scale?.getVisibleLogicalRange();
      if(!range||!this.series)return;
      // Rows share the candle series' dates and logical indexes. Include one
      // point on either side so continuing segments reach the pane edges.
      const from=Math.max(0,Math.floor(range.from)-1),to=Math.min(this.rows.length-1,Math.ceil(range.to)+1);
      target.useMediaCoordinateSpace(({context:ctx})=>{
        ctx.save();try{
          ctx.strokeStyle=this.color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.setLineDash([]);ctx.beginPath();
          let previous=null,length=0;
          const finishRun=()=>{
            if(length===1){ctx.moveTo(previous.x-1,previous.y);ctx.lineTo(previous.x+1,previous.y);}
            previous=null;length=0;
          };
          for(let index=from;index<=to;index++){
            const row=this.rows[index];
            if(row.value===undefined){finishRun();continue;}
            const x=scale.timeToCoordinate(row.time),y=this.series.priceToCoordinate(row.value);
            if(!Number.isFinite(x)||!Number.isFinite(y)){finishRun();continue;}
            if(previous){ctx.lineTo(x,previous.y);ctx.lineTo(x,y);}else ctx.moveTo(x,y);
            previous={x,y};length++;
          }
          finishRun();ctx.stroke();
        }finally{ctx.restore();}
      });
    }
  }
  class BuyPriceProfile{
    constructor(){this.rows=[];this.items=[];this.color='#a98773';this.views=[{zOrder:()=>'bottom',renderer:()=>this}];}
    attached({chart,series,requestUpdate}){this.chart=chart;this.series=series;this.requestUpdate=requestUpdate;}
    detached(){this.chart=null;this.series=null;this.requestUpdate=null;this.items=[];}
    paneViews(){return this.views;}
    setData(rows){this.rows=rows;this.requestUpdate?.();}
    setColor(color){this.color=color;this.requestUpdate?.();}
    updateAllViews(){
      this.items=[];if(!this.chart||!this.series||!this.rows.length)return;
      const width=this.chart.timeScale().width(),height=this.chart.panes()[0]?.getHeight();
      if(!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0)return;
      const max=Math.max(...this.rows.map(row=>row.volume)),limit=Math.min(240,width*.22);
      for(const row of this.rows){
        const low=this.series.priceToCoordinate(row.low),high=this.series.priceToCoordinate(row.high);
        if(low===null||high===null||!Number.isFinite(low)||!Number.isFinite(high))continue;
        const top=Math.max(0,Math.min(low,high)),bottom=Math.min(height,Math.max(low,high));if(bottom<=top)continue;
        this.items.push({...row,x:0,y:top,width:Math.max(1,limit*row.volume/max),height:Math.max(1,bottom-top-1)});
      }
    }
    draw(target){
      target.useMediaCoordinateSpace(({context:ctx})=>{
        ctx.save();try{ctx.fillStyle=this.color;ctx.strokeStyle=this.color;
          for(const item of this.items){ctx.globalAlpha=.22;ctx.fillRect(item.x,item.y,item.width,item.height);ctx.globalAlpha=.55;ctx.fillRect(item.width-1,item.y,1,item.height);}
        }finally{ctx.restore();}
      });
    }
    hitTest(x,y){
      const item=this.items.find(row=>x>=row.x&&x<=row.x+row.width&&y>=row.y&&y<=row.y+row.height);
      return item?{externalId:item.id,cursorStyle:'default',zOrder:'bottom'}:null;
    }
  }
  function create({chart,series,lib}={}){
    if(!chart||!series||!lib||typeof chart.addSeries!=='function'||typeof series.attachPrimitive!=='function')return null;
    const profile=new BuyPriceProfile();let profileVisible=false,dailyVisible=false,daily=null,destroyed=false,profileSignature='',dailySignature='',dailyData=[],profileData=[];
    const averageStroke=new DisjointAverageLine();
    let average=null,averageWindow=null,averageGaps=false,averageSignature='',averageValues=new Map(),latestCosts=new Map(),latestCandles=[];
    let colors={profile:'#a98773',volume:'#a98773',average:AVERAGE_COLOR};
    function retainRange(action){const scale=chart.timeScale(),range=scale.getVisibleLogicalRange();action();if(range)scale.setVisibleLogicalRange(range);}
    function updateAverage(){
      if(!averageWindow)return;
      const times=latestCandles.map(row=>row?.time);
      const signature=JSON.stringify([averageWindow,times,[...latestCosts]]);
      if(signature===averageSignature)return;
      averageSignature=signature;
      const rows=averageRows(latestCosts,times,averageWindow);
      averageValues.clear();let first=-1,last=-1;
      rows.forEach((row,index)=>{
        if(row.value===undefined)return;
        if(first<0)first=index;
        last=index;averageValues.set(row.time,row.value);
      });
      if(!average&&!averageValues.size)return;
      const gaps=averageValues.size>0&&last-first+1>averageValues.size;
      retainRange(()=>{
        if(!average){
          const priceScaleId=(typeof series.options==='function'?series.options().priceScaleId:null)??'right';
          average=chart.addSeries(lib.LineSeries,{priceScaleId,color:colors.average,lineStyle:lib.LineStyle?.Solid??0,lineWidth:2,lineType:lib.LineType?.WithSteps??1,lineVisible:!gaps,lastValueVisible:false,priceLineVisible:false,baseLineVisible:false,crosshairMarkerVisible:false},0);
        }else if(gaps!==averageGaps)average.applyOptions({lineVisible:!gaps});
        if(gaps){
          averageStroke.setData(rows);
          if(!averageGaps)series.attachPrimitive(averageStroke);
        }else if(averageGaps)series.detachPrimitive(averageStroke);
        averageGaps=gaps;
        average.setData(averageValues.size?rows.map(row=>({...row})):[]);
      });
    }
    function removeAverage(){
      if(averageGaps){series.detachPrimitive(averageStroke);averageGaps=false;}
      if(average){chart.removeSeries(average);average=null;}
    }
    function setAverageWindow(window){
      if(destroyed)return null;
      const next=lib.LineSeries&&AVERAGE_WINDOWS.has(window)?window:null;
      if(next===averageWindow)return averageWindow;
      averageWindow=next;
      if(next)updateAverage();
      else{
        averageSignature='';averageValues.clear();
        if(average)retainRange(removeAverage);
      }
      return averageWindow;
    }
    function averageAt(time){
      if(time&&Number.isInteger(time.year)&&Number.isInteger(time.month)&&Number.isInteger(time.day))time=String(time.year).padStart(4,'0')+'-'+String(time.month).padStart(2,'0')+'-'+String(time.day).padStart(2,'0');
      return averageValues.get(time)??null;
    }
    function update({buys,holdingCosts,candles,distribution}={}){
      if(destroyed)return;
      const rows=profileRows(distribution),signature=JSON.stringify(rows.map(({from,to,btc})=>[from,to,btc]));
      if(signature!==profileSignature){profileSignature=signature;profileData=rows;profile.setData(rows);}
      const next=dailyRows(buys,candles),nextSignature=JSON.stringify(next);
      if(nextSignature!==dailySignature){dailySignature=nextSignature;dailyData=next;if(daily)retainRange(()=>daily.setData(next.map(row=>({...row}))));}
      latestCosts=holdingCosts instanceof Map?holdingCosts:new Map();latestCandles=Array.isArray(candles)?candles:[];updateAverage();
    }
    function setProfileVisible(visible){
      if(destroyed)return false;visible=!!visible;if(visible===profileVisible)return profileVisible;
      profileVisible=visible;if(visible){profile.setData(profileData);profile.setColor(colors.profile);series.attachPrimitive(profile);}else series.detachPrimitive(profile);
      return profileVisible;
    }
    function setDailyVisible(visible){
      if(destroyed)return false;visible=!!visible;if(visible===dailyVisible)return dailyVisible;
      if(visible&&!lib.HistogramSeries)return false;
      retainRange(()=>{
        if(visible){
          // An overlay scale keeps the pane's empty default right-axis widget
          // intact. Hiding that default scale per pane breaks LWC 5.3 layout.
          daily=chart.addSeries(lib.HistogramSeries,{color:colors.volume,priceScaleId:'buy-volume',base:0,lastValueVisible:false,priceLineVisible:false,baseLineVisible:false,priceFormat:{type:'price',precision:8,minMove:1e-8}},1);
          daily.setData(dailyData.map(row=>({...row})));
          daily.priceScale().applyOptions({scaleMargins:{top:.1,bottom:0}});
          const panes=chart.panes(),height=panes.reduce((sum,pane)=>sum+pane.getHeight(),0);panes[1]?.setHeight(Math.max(60,Math.min(100,height*.24)));
        }else if(daily){chart.removeSeries(daily);daily=null;}
      });
      dailyVisible=visible;return dailyVisible;
    }
    function theme(next={}){
      if(destroyed)return;colors={...colors,...next};profile.setColor(colors.profile);daily?.applyOptions({color:colors.volume});
      averageStroke.setColor(colors.average);average?.applyOptions({color:colors.average});
    }
    function getProfileBin(id){
      if(!profileVisible||typeof id!=='string')return null;const row=profileData.find(row=>row.id===id);return row?{from:row.from,to:row.to,btc:row.btc}:null;
    }
    function destroy(){
      if(destroyed)return;if(daily){chart.removeSeries(daily);daily=null;}if(profileVisible)series.detachPrimitive(profile);profileData=[];dailyData=[];profile.rows=[];profile.items=[];profileVisible=false;dailyVisible=false;destroyed=true;
      removeAverage();averageValues.clear();latestCosts=new Map();latestCandles=[];
    }
    return {update,setProfileVisible,setDailyVisible,setAverageWindow,averageAt,theme,getProfileBin,destroy};
  }
  return {PROFILE_PREFIX,profileRows,dailyRows,BuyPriceProfile,create};
});
