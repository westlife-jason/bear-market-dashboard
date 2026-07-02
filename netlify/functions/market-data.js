// netlify/functions/market-data.js
// 베어마켓 대시보드용 데이터 중계 서버
// - FRED API: 금리차(T10Y2Y), 신용 스프레드(BAMLH0A0HYM2), Sahm Rule, VIX, 연준 기준금리
// - CNN: Fear & Greed 지수
// FRED_API_KEY는 Netlify 환경변수에 등록해야 합니다.

const FRED_SERIES = {
  t10y2y:   'T10Y2Y',        // 10년-2년 금리차 (%p)
  hySpread: 'BAMLH0A0HYM2',  // 하이일드 스프레드 (%)
  sahm:     'SAHMREALTIME',  // Sahm Rule
  vix:      'VIXCLS',        // VIX 종가
  fedFunds: 'FEDFUNDS',      // 연준 실효 기준금리 (참고용)
};

// FRED에서 특정 시리즈의 최신 유효값 1개를 가져온다
async function fredLatest(seriesId, apiKey) {
  const url = 'https://api.stlouisfed.org/fred/series/observations'
    + `?series_id=${seriesId}&api_key=${apiKey}&file_type=json`
    + '&sort_order=desc&limit=10';
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  // 휴일 등으로 값이 "."인 날짜는 건너뛰고 첫 유효값 선택
  const obs = (json.observations || []).find(o => o.value !== '.');
  return obs ? { value: parseFloat(obs.value), date: obs.date } : null;
}

exports.handler = async function () {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Netlify에 FRED_API_KEY 환경변수가 등록되지 않았습니다' }),
    };
  }

  const out = {};
  let asOf = null;

  // FRED 지표 5개 조회 (하나 실패해도 나머지는 진행)
  for (const [key, seriesId] of Object.entries(FRED_SERIES)) {
    try {
      const r = await fredLatest(seriesId, apiKey);
      out[key] = r ? r.value : null;
      if (key === 't10y2y' && r) asOf = r.date;
    } catch (e) {
      out[key] = null;
    }
  }

  // CNN Fear & Greed (실패해도 무시)
  out.fearGreed = null;
  try {
    const res = await fetch(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (res.ok) {
      const json = await res.json();
      const score = json && json.fear_and_greed && json.fear_and_greed.score;
      if (typeof score === 'number') out.fearGreed = Math.round(score);
    }
  } catch (e) { /* CNN 실패 시 null 유지 */ }

  out.asOf = asOf;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(out),
  };
};
