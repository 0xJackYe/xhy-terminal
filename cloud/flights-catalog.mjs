// Small departure catalogue; location and passport preferences live in encrypted D1.
export const AIRPORTS = [
 ['NKG','南京禄口','南京',31.742,118.862],['WUX','苏南硕放','无锡',31.494,120.429],
 ['HFE','合肥新桥','合肥',31.990,116.977],['HGH','杭州萧山','杭州',30.236,120.435],
 ['PVG','上海浦东','上海',31.144,121.805],['SHA','上海虹桥','上海',31.198,121.336],
 ['NTG','南通兴东','南通',32.071,120.976],['YTY','扬州泰州','扬州',32.563,119.719],
 ['PEK','北京首都','北京',40.080,116.585],['PKX','北京大兴','北京',39.510,116.411],
 ['CAN','广州白云','广州',23.392,113.299],['SZX','深圳宝安','深圳',22.639,113.811],
 ['CTU','成都双流','成都',30.578,103.947],['TFU','成都天府','成都',30.313,104.442],
 ['CKG','重庆江北','重庆',29.720,106.642],['KMG','昆明长水','昆明',25.102,102.929],
 ['XMN','厦门高崎','厦门',24.544,118.128],['FOC','福州长乐','福州',25.935,119.663],
 ['TAO','青岛胶东','青岛',36.361,120.088],['TSN','天津滨海','天津',39.124,117.346],
 ['XIY','西安咸阳','西安',34.447,108.752],['CSX','长沙黄花','长沙',28.189,113.220],
 ['WUH','武汉天河','武汉',30.784,114.208],['SHE','沈阳桃仙','沈阳',41.640,123.483],
 ['DLC','大连周水子','大连',38.966,121.539],['NNG','南宁吴圩','南宁',22.608,108.172],
].map(([iata,name,city,lat,lon],i)=>({iata,name,city,lat,lon,country_code:'CN',time_zone:'Asia/Shanghai',search_cities:i<8?['南京']:[],official_url:null}));

const REVIEWED='2026-10-28T21:00:00.000Z';
export const ENTRY_POLICIES = [
 {code:'TH',name:'泰国',entry_status:'visa_free',official_url:'https://th.china-embassy.gov.cn/zgqz/1w1/202609/t20260902_12014754.html',form_url:'https://tdac.immigration.go.th/',note:'中国普通护照适用双边免签：单次不超过30日，180日内累计不超过90日。按规定提交TDAC；须核实护照有效期、离境机票、住宿及资金要求。'},
 {code:'MY',name:'马来西亚',entry_status:'visa_free',official_url:'https://www.kln.gov.my/web/chn_beijing/requirement_foreigner',form_url:'https://imigresen-online.imi.gov.my/mdac/main',note:'中国普通护照单次免签不超过30日，180日内累计不超过90日。须按规定提交MDAC，并核实护照有效期、返程/续程机票和住宿。'},
 {code:'SG',name:'新加坡',entry_status:'visa_free',official_url:'https://www.ica.gov.sg/news-and-publications/newsroom/media-release/mutual-30-day-visa-exemption-arrangement-between-singapore-and-the-people-s-republic-of-china',form_url:'https://www.ica.gov.sg/enter-transit-depart/entering-singapore/sg-arrival-card',note:'中国普通护照可免签停留最多30日。SG Arrival Card须在抵达前3日内（含抵达日）提交；核实护照有效期、返程/续程及入境条件。'},
 {code:'JP',name:'日本',entry_status:'visa_required',official_url:'https://www.cn.emb-japan.go.jp/itpr_zh/visa.html',note:'中国大陆普通护照一般须事先取得相应签证；已有签证请向航空公司核实有效性。'},
 {code:'KR',name:'韩国',entry_status:'visa_required',official_url:'https://www.visa.go.kr/',note:'一般须事先办签证。济州等特殊免签安排有路线及个人条件限制，需单独核实，不能按韩国全国免签处理。'},
 {code:'ID',name:'印度尼西亚',entry_status:'verify',official_url:'https://evisa.imigrasi.go.id/',note:'落地签/e-VOA资格、入境口岸、费用及申报要求请到移民局核实；未自动认定为免签。'},
].map(p=>({...p,passport_country:'CN',checked_at:REVIEWED}));

export const BOOKING_LINKS = [
 {label:'中国东方航空',url:'https://www.ceair.com/'},
 {label:'春秋航空',url:'https://www.ch.com/'},
 {label:'吉祥航空',url:'https://www.juneyaoair.com/'},
 {label:'酷航',url:'https://www.flyscoot.com/'},
 {label:'亚洲航空',url:'https://www.airasia.com/'},
 {label:'新加坡航空',url:'https://www.singaporeair.com/'},
];
const AIRLINE_URLS={MU:'https://www.ceair.com/',FM:'https://www.ceair.com/','9C':'https://www.ch.com/',HO:'https://www.juneyaoair.com/',TR:'https://www.flyscoot.com/',SQ:'https://www.singaporeair.com/',AK:'https://www.airasia.com/',D7:'https://www.airasia.com/',FD:'https://www.airasia.com/',XJ:'https://www.airasia.com/',CZ:'https://www.csair.com/',CA:'https://www.airchina.com.cn/',ZH:'https://www.shenzhenair.com/',MH:'https://www.malaysiaairlines.com/',OD:'https://www.batikair.com.my/'};
export function enrichFlight(flight,passport){
 const policy=passport==='CN'?ENTRY_POLICIES.find(p=>p.code===flight.destination?.country_code):null;
 const scoped=policy?.code==='KR'&&flight.destination?.iata==='CJU'?{...policy,entry_status:'verify'}:policy;
 const prefix=flight.airline?.iata||String(flight.flight_number||'').replace(/\s/g,'').slice(0,2);
 return {...flight,booking_url:AIRLINE_URLS[prefix]||null,entry:scoped?{status:scoped.entry_status,passport_country:'CN',official_url:scoped.official_url,checked_at:scoped.checked_at,note:scoped.note}:{status:'verify',passport_country:passport,official_url:null,checked_at:null,note:'需按所持护照到目的地官方渠道核实。'}};
}
