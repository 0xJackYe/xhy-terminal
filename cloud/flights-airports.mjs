/**
 * Small destination reference registry, not a list of routes or operating flights.
 * Airport IATA/country/municipality references: OurAirports public-domain airports.csv.
 * https://ourairports.com/data/
 * https://davidmegginson.github.io/ourairports-data/airports.csv
 * IANA timezone references (Malaysia: peninsular / Sabah; Indonesia: Java / Bali):
 * https://data.iana.org/time-zones/tzdb/zone.tab
 * Names/cities below are Chinese display labels; this registry makes no entry/visa claims.
 */
export const DESTINATION_AIRPORTS_SOURCE = Object.freeze({
  checked_at: '2026-10-29',
  airports_url: 'https://ourairports.com/data/',
  time_zones_url: 'https://data.iana.org/time-zones/tzdb/zone.tab',
});

const records = [
  ['BKK', '曼谷素万那普机场', '曼谷', 'TH', '泰国', 'Asia/Bangkok'],
  ['DMK', '曼谷廊曼机场', '曼谷', 'TH', '泰国', 'Asia/Bangkok'],
  ['HKT', '普吉国际机场', '普吉', 'TH', '泰国', 'Asia/Bangkok'],
  ['CNX', '清迈国际机场', '清迈', 'TH', '泰国', 'Asia/Bangkok'],
  ['KBV', '甲米国际机场', '甲米', 'TH', '泰国', 'Asia/Bangkok'],
  ['KUL', '吉隆坡国际机场', '吉隆坡', 'MY', '马来西亚', 'Asia/Kuala_Lumpur'],
  ['PEN', '槟城国际机场', '槟城', 'MY', '马来西亚', 'Asia/Kuala_Lumpur'],
  ['BKI', '亚庇国际机场', '亚庇', 'MY', '马来西亚', 'Asia/Kuching'],
  ['JHB', '新山士乃国际机场', '新山', 'MY', '马来西亚', 'Asia/Kuala_Lumpur'],
  ['LGK', '兰卡威国际机场', '兰卡威', 'MY', '马来西亚', 'Asia/Kuala_Lumpur'],
  ['SIN', '新加坡樟宜机场', '新加坡', 'SG', '新加坡', 'Asia/Singapore'],
  ['NRT', '成田国际机场', '成田', 'JP', '日本', 'Asia/Tokyo'],
  ['HND', '东京羽田机场', '东京', 'JP', '日本', 'Asia/Tokyo'],
  ['KIX', '大阪关西国际机场', '大阪', 'JP', '日本', 'Asia/Tokyo'],
  ['NGO', '名古屋中部国际机场', '名古屋', 'JP', '日本', 'Asia/Tokyo'],
  ['FUK', '福冈机场', '福冈', 'JP', '日本', 'Asia/Tokyo'],
  ['OKA', '冲绳那霸机场', '那霸', 'JP', '日本', 'Asia/Tokyo'],
  ['ICN', '仁川国际机场', '仁川', 'KR', '韩国', 'Asia/Seoul'],
  ['GMP', '首尔金浦国际机场', '首尔', 'KR', '韩国', 'Asia/Seoul'],
  ['PUS', '釜山金海国际机场', '釜山', 'KR', '韩国', 'Asia/Seoul'],
  ['CJU', '济州国际机场', '济州', 'KR', '韩国', 'Asia/Seoul'],
  ['CGK', '雅加达苏加诺哈达国际机场', '雅加达', 'ID', '印度尼西亚', 'Asia/Jakarta'],
  ['DPS', '巴厘岛伍拉赖国际机场', '登巴萨', 'ID', '印度尼西亚', 'Asia/Makassar'],
];

export const DESTINATION_AIRPORTS = Object.freeze(records.map(([iata, name, city, country_code, country_name, time_zone]) =>
  Object.freeze({ iata, name, city, country_code, country_name, time_zone })));
export const DESTINATION_AIRPORTS_BY_IATA = Object.freeze(Object.fromEntries(DESTINATION_AIRPORTS.map(airport => [airport.iata, airport])));
