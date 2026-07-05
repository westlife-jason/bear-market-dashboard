// Cloudflare Pages Function — 베어마켓 대시보드 자동조회 (v1.3)
// 엔드포인트: /api/market-data  (프론트 autoFetch()가 호출)
// 환경변수: Cloudflare 프로젝트 설정에 FRED_API_KEY 등록 (context.env로 접근)
// 반환: { t10y2y, hySpread, sahm, vix, fedFunds, fearGreed, buffett, asOf }
//   - FRED 6계열 + CNN Fear&Greed. 각 소스는 독립적으로 실패해도 null만 반환(전체는 계속 작동).

export async function onRequest(context) {
  const KEY = context.env && context.env.FRED_API_KEY;
  const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

  if (!KEY) {
    return J({ error: 'FRED_API_KEY 환경변수가 설정되지 않았습니다. (Cloudflare 프로젝트 → Settings → Environment variables)' }, 500);
  }

  // FRED 최신 유효 관측값 1개 — "."(휴일/결측)은 건너뛰고 첫 유효값 사용
  async function fred(series) {
    try {
      const url = 'https://api.stlouisfed.org/fred/series/observations'
        + `?series_id=${series}&api_key=${KEY}&file_type=json&sort_order=desc&limit=12`;
      const r = await fetch(url);
      if (!r.ok) return { v: null, date: null };
      const j = await r.json();
      const obs = (j.observations || []).find(o => o.value && o.value !== '.');
      return obs ? { v: parseFloat(obs.value), date: obs.date } : { v: null, date: null };
    } catch (e) {
      return { v: null, date: null };
    }
  }

  // CNN Fear & Greed — 브라우저 UA 없으면 차단되므로 헤더 지정
  async function cnnFearGreed() {
    try {
      const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) return null;
      const j = await r.json();
      const s = j && j.fear_and_greed && j.fear_and_greed.score;
      return (s === undefined || s === null || isNaN(s)) ? null : Math.round(s);
    } catch (e) {
      return null;
    }
  }

  const [t10y2y, hy, sahm, vix, fed, wilshire, gdp, fng] = await Promise.all([
    fred('T10Y2Y'),          // 신호 01: 10Y-2Y 금리차
    fred('BAMLH0A0HYM2'),    // 신호 03: 하이일드 스프레드
    fred('SAHMREALTIME'),    // 신호 06: Sahm Rule
    fred('VIXCLS'),          // 보조: VIX
    fred('FEDFUNDS'),        // 참고: 연준 기준금리
    fred('WILL5000INDFC'),   // 진자: 윌셔5000 (≈ 시총 $10억)
    fred('GDP'),             // 진자: 명목 GDP ($10억, 연율)
    cnnFearGreed(),          // 보조: CNN Fear & Greed
  ]);

  // 버핏지수 = 윌셔5000 ÷ 명목GDP × 100 (소수 1자리)
  const buffett = (wilshire.v && gdp.v) ? Math.round(wilshire.v / gdp.v * 1000) / 10 : null;

  return J({
    t10y2y:   t10y2y.v,
    hySpread: hy.v,
    sahm:     sahm.v,
    vix:      vix.v,
    fedFunds: fed.v,
    fearGreed: fng,
    buffett,
    asOf: t10y2y.date || hy.date || sahm.date || null,
  });
}
