(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.DCAIndicators=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const PROFILE_PREFIX='buy-profile-';
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
    let colors={profile:'#a98773',volume:'#a98773'};
    function retainRange(action){const scale=chart.timeScale(),range=scale.getVisibleLogicalRange();action();if(range)scale.setVisibleLogicalRange(range);}
    function update({buys,candles,distribution}={}){
      if(destroyed)return;
      const rows=profileRows(distribution),signature=JSON.stringify(rows.map(({from,to,btc})=>[from,to,btc]));
      if(signature!==profileSignature){profileSignature=signature;profileData=rows;profile.setData(rows);}
      const next=dailyRows(buys,candles),nextSignature=JSON.stringify(next);
      if(nextSignature!==dailySignature){dailySignature=nextSignature;dailyData=next;if(daily)retainRange(()=>daily.setData(next.map(row=>({...row}))));}
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
    }
    function getProfileBin(id){
      if(!profileVisible||typeof id!=='string')return null;const row=profileData.find(row=>row.id===id);return row?{from:row.from,to:row.to,btc:row.btc}:null;
    }
    function destroy(){
      if(destroyed)return;if(daily){chart.removeSeries(daily);daily=null;}if(profileVisible)series.detachPrimitive(profile);profileData=[];dailyData=[];profile.rows=[];profile.items=[];profileVisible=false;dailyVisible=false;destroyed=true;
    }
    return {update,setProfileVisible,setDailyVisible,theme,getProfileBin,destroy};
  }
  return {PROFILE_PREFIX,profileRows,dailyRows,BuyPriceProfile,create};
});
