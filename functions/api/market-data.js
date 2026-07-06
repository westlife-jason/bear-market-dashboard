// Cloudflare Pages Function — 베어마켓 대시보드 자동조회 (v1.5)
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

  async function fredList(series) {
    try {
      const url = 'https://api.stlouisfed.org/fred/series/observations'
        + `?series_id=${series}&api_key=${KEY}&file_type=json&sort_order=desc&limit=24`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      return (j.observations || [])
        .filter(o => o.value && o.value !== '.')
        .map(o => ({ v: parseFloat(o.value), date: o.date }));
    } catch (e) { return []; }
  }
  const first = arr => (arr && arr.length ? arr[0] : { v: null, date: null });

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
    t10y2yA, hyA, sahmA, vixA, fedA, wilshireA, gdpA,
    fng, cape,
    soxx1m, xlk3m, xlp3m, spy3m, tlt3m,
  ] = await Promise.all([
    fredList('T10Y2Y'), fredList('BAMLH0A0HYM2'), fredList('SAHMREALTIME'),
    fredList('VIXCLS'), fredList('FEDFUNDS'), fredList('WILL5000INDFC'), fredList('GDP'),
    cnnFearGreed(), multplCape(),
    yahooReturn('SOXX', '1mo'),
    yahooReturn('XLK', '3mo'), yahooReturn('XLP', '3mo'),
    yahooReturn('SPY', '3mo'), yahooReturn('TLT', '3mo'),
  ]);

  const t10y2y = first(t10y2yA), hy = first(hyA), sahm = first(sahmA);
  const vix = first(vixA), fed = first(fedA), wilshire = first(wilshireA), gdp = first(gdpA);

  const buffett = (wilshire.v && gdp.v) ? Math.round(wilshire.v / gdp.v * 1000) / 10 : null;

  let fedSuggest = null;
  if (fedA.length){
    const cur = fedA[0].v;
    const prior = fedA.length > 3 ? fedA[3].v : cur;
    const d3 = cur - prior;
    if (d3 >= 0.25) fedSuggest = 'y';
    else if (d3 <= -0.25) fedSuggest = (sahm.v !== null && sahm.v >= 0.3) ? 'r' : 'g';
    else fedSuggest = 'g';
  }

  let leaderSuggest = null;
  if (xlk3m !== null && xlp3m !== null){
    if (spy3m !== null && spy3m < 0 && tlt3m !== null && tlt3m > 2 && tlt3m > xlk3m) leaderSuggest = 'cash';
    else if (xlk3m >= xlp3m) leaderSuggest = 'tech';
    else leaderSuggest = 'defensive';
  }

  return J({
    t10y2y: t10y2y.v, hySpread: hy.v, sahm: sahm.v, vix: vix.v, fedFunds: fed.v,
    fearGreed: fng, buffett, cape,
    semi1m: soxx1m,
    fedSuggest, leaderSuggest,
    _meta: { xlk3m, xlp3m, spy3m, tlt3m, fedPrior3m: fedA.length > 3 ? fedA[3].v : null },
    asOf: t10y2y.date || hy.date || sahm.date || null,
  });
}
