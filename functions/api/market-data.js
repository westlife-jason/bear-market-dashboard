// Cloudflare Pages Function — 베어마켓 대시보드 자동조회 (v1.7)
// v1.6: FRED가 2024-06-03 윌셔 지수 전체 제거 → 버핏지수 분자를 Yahoo ^W5000으로 교체
// v1.7: Sentiment Layer Phase 1 — sentiment{} 반환 (S1 VIX+3년백분위, S5 CNN F&G, S3 풋콜 원시값)
// 엔드포인트: /api/market-data  (프론트 autoFetch()가 호출)
// 환경변수: Cloudflare 프로젝트 설정에 FRED_API_KEY 등록 (context.env로 접근)

export async function onRequest(context) {
  const KEY = context.env && context.env.FRED_API_KEY;
  const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  if (!KEY) {
    return J({ error: 'FRED_API_KEY 환경변수가 설정되지 않았습니다. (Cloudflare 프로젝트 → Settings → Environment variables)' }, 500);
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

  // FRED 관측값 배열(최신순, "."/결측 제거). limit: 백분위 계산 시 크게 (VIX 3년≈756거래일)
  async function fredList(series, limit = 24) {
    try {
      const url = 'https://api.stlouisfed.org/fred/series/observations'
        + `?series_id=${series}&api_key=${KEY}&file_type=json&sort_order=desc&limit=${limit}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      return (j.observations || [])
        .filter(o => o.value && o.value !== '.')
        .map(o => ({ v: parseFloat(o.value), date: o.date }));
    } catch (e) { return []; }
  }
  const first = arr => (arr && arr.length ? arr[0] : { v: null, date: null });

  // Yahoo Finance: 최신 종가 (지수/티커) — 심볼의 ^는 %5E로 인코딩
  async function yahooLast(sym) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const c = j && j.chart && j.chart.result && j.chart.result[0]
        && j.chart.result[0].indicators.quote[0].close;
      if (!c) return null;
      const clean = c.filter(x => x !== null && x !== undefined);
      return clean.length ? clean[clean.length - 1] : null;
    } catch (e) { return null; }
  }

  // Yahoo Finance: 기간 수익률(%)
  async function yahooReturn(sym, range) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const c = j && j.chart && j.chart.result && j.chart.result[0]
        && j.chart.result[0].indicators.quote[0].close;
      if (!c) return null;
      const clean = c.filter(x => x !== null && x !== undefined);
      if (clean.length < 2) return null;
      return Math.round((clean[clean.length - 1] / clean[0] - 1) * 1000) / 10;
    } catch (e) { return null; }
  }

  // CNN Fear & Greed (브라우저 UA 필요)
  async function cnnFearGreed() {
    try {
      const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
        { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const s = j && j.fear_and_greed && j.fear_and_greed.score;
      return (s === undefined || s === null || isNaN(s)) ? null : Math.round(s);
    } catch (e) { return null; }
  }

  // ── Sentiment Layer (Phase 1) ──
  // 백분위: 현재값이 과거 분포에서 몇 %ile인지 (0~100)
  function pctRank(arr, cur) {
    if (!arr || arr.length < 30 || cur === null) return null;
    const n = arr.filter(v => v <= cur).length;
    return Math.round(n / arr.length * 1000) / 10;
  }

  // CBOE 일간 통계 페이지에서 Total Put/Call 현재값 스크래핑
  // ⚠️ 이 페이지엔 당일 값만 있어 10일 MA·백분위는 계산 불가 (pc-collector Worker가 일별 누적 담당)
  async function cboeTotalPC() {
    try {
      const r = await fetch('https://www.cboe.com/us/options/market_statistics/daily/', { headers: { 'User-Agent': UA } });
      if (!r.ok) return null;
      const html = await r.text();
      const m = html.match(/TOTAL\s*PUT\/CALL\s*RATIO[^0-9]*([0-9]\.[0-9]{1,2})/i);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return (v >= 0.3 && v <= 3.0) ? v : null;
    } catch (e) { return null; }
  }

  // multpl Shiller CAPE (현재값만, 10~70 범위 검증)
  async function multplCape() {
    try {
      const r = await fetch('https://www.multpl.com/shiller-pe', { headers: { 'User-Agent': UA } });
      if (!r.ok) return null;
      const html = await r.text();
      let m = html.match(/Current Shiller PE Ratio[^0-9]*([0-9]{1,2}\.[0-9]{1,2})/i)
           || html.match(/id="current"[^>]*>[^0-9]*([0-9]{1,2}\.[0-9]{1,2})/i);
      if (!m) return null;
      const v = parseFloat(m[1]);
      return (v >= 10 && v <= 70) ? v : null;
    } catch (e) { return null; }
  }

  const [
    t10y2yA, hyA, sahmA, vixA, fedA, gdpA,
    fng, cape, putCall,
    wilshire,
    soxx1m, xlk3m, xlp3m, spy3m, tlt3m,
  ] = await Promise.all([
    fredList('T10Y2Y'), fredList('BAMLH0A0HYM2'), fredList('SAHMREALTIME'),
    fredList('VIXCLS', 800), fredList('FEDFUNDS'), fredList('GDP'),
    cnnFearGreed(), multplCape(), cboeTotalPC(),
    yahooLast('%5EW5000'),
    yahooReturn('SOXX', '1mo'),
    yahooReturn('XLK', '3mo'), yahooReturn('XLP', '3mo'),
    yahooReturn('SPY', '3mo'), yahooReturn('TLT', '3mo'),
  ]);

  const t10y2y = first(t10y2yA), hy = first(hyA), sahm = first(sahmA);
  const vix = first(vixA), fed = first(fedA), gdp = first(gdpA);

  // 버핏지수 = 윌셔5000(≈시총 $10억) ÷ 명목GDP($10억) × 100. 50~400 검증(벗어나면 null→수동)
  let buffett = null;
  if (wilshire && gdp.v) {
    const b = Math.round(wilshire / gdp.v * 1000) / 10;
    buffett = (b >= 50 && b <= 400) ? b : null;
  }

  // ── 추천: 연준 국면 (기준금리 3개월 변화 + Sahm) ──
  let fedSuggest = null;
  if (fedA.length){
    const cur = fedA[0].v;
    const prior = fedA.length > 3 ? fedA[3].v : cur;
    const d3 = cur - prior;
    if (d3 >= 0.25) fedSuggest = 'y';
    else if (d3 <= -0.25) fedSuggest = (sahm.v !== null && sahm.v >= 0.3) ? 'r' : 'g';
    else fedSuggest = 'g';
  }

  // ── 추천: 섹터 리더십 (테크 vs 방어 vs 현금/국채 쏠림) ──
  let leaderSuggest = null;
  if (xlk3m !== null && xlp3m !== null){
    if (spy3m !== null && spy3m < 0 && tlt3m !== null && tlt3m > 2 && tlt3m > xlk3m) leaderSuggest = 'cash';
    else if (xlk3m >= xlp3m) leaderSuggest = 'tech';
    else leaderSuggest = 'defensive';
  }

  // ── Sentiment Layer (Phase 1): 원시값 + 백분위 ──
  const sentiment = {
    s1_vix:     { value: vix.v, pct3y: pctRank(vixA.map(o => o.v), vix.v), source: 'fred' },
    s5_cnn_fg:  { value: fng, source: 'cnn' },
    s3_putcall: { value: putCall, ma10: null, pct3y: null, source: 'cboe', note: 'raw_daily_only' },
  };

  return J({
    t10y2y: t10y2y.v, hySpread: hy.v, sahm: sahm.v, vix: vix.v, fedFunds: fed.v,
    fearGreed: fng, buffett, cape,
    semi1m: soxx1m,
    fedSuggest, leaderSuggest,
    sentiment,
    _meta: { xlk3m, xlp3m, spy3m, tlt3m, fedPrior3m: fedA.length > 3 ? fedA[3].v : null, wilshire, gdp: gdp.v },
    asOf: t10y2y.date || hy.date || sahm.date || null,
  });
}
