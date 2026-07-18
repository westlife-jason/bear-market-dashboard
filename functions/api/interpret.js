// Cloudflare Pages Function — AI 심층 해석 (v1.8)
// 엔드포인트: POST /api/interpret  (프론트 aiInterpret()가 호출)
// 환경변수: ANTHROPIC_API_KEY (Cloudflare 프로젝트 → Settings → Environment variables)
//
// 프론트가 보낸 전체 지표 스냅샷을 Claude(claude-opus-4-8)에게 넘겨
// 초보자 눈높이의 한국어 해석을 생성한다. 이 프로젝트는 빌드 단계가 없는
// 정적 배포라 SDK 대신 Claude API를 raw HTTP(fetch)로 직접 호출한다.

const SYSTEM = `당신은 "베어마켓 조기경보 대시보드"의 지표 해석 조수입니다. 사용자는 투자 경험이 있는 개인 투자자이지만 지표의 깊은 해석에는 익숙하지 않습니다. 친절하고 명확한 한국어로 설명하세요.

## 대시보드의 철학 (반드시 지킬 것)
- 유튜브 "미주은" 채널의 7신호 체계: 조정장(맞출 수 없음, 매수 기회)과 베어마켓(펀더멘탈 훼손, 회피 대상)을 구분하는 것이 핵심. 7신호는 "하방 알람"이다.
- 하워드 막스의 진자: 예측이 아니라 온도계. "지금 공격이냐 수비냐"의 공수 나침반. 0=극공포·헐값(공격 기회), 100=극탐욕·거품(수비).
- 두 렌즈는 상충이 아니라 상호보완: 7신호는 "팔 이유가 있는가", 진자는 "더 살 때인가"를 답한다. 둘이 달라 보이는 조합이 오히려 정보량이 가장 많다.
- 단정적 매매 지시("사라/팔아라") 금지. 자세(posture) 권고와 조건부 시나리오로만 표현. 당신은 자격을 갖춘 투자 자문가가 아니며 이 해석은 교육·참고용임을 전제한다.

## 지표 배경 지식
- 신호01 금리차(10Y-2Y): 역전(<0)이 침체 선행. 신호03 하이일드 스프레드: 좁으면 신용 느슨(안전하지만 자만), 7%+ 위험. 신호05: PER 높은 것 자체는 신호 아님 — "고점 후 꺾임 + 어닝리비전 마이너스" 동시 발생이 위험(2021.11 사례). Sahm≥0.5 침체 신호. 신호07: 방어주·현금 쏠림과 반도체 1M 마이너스가 경고.
- 진자 4차원: 심리(F&G·VIX·AAII), 신용·유동성(하이일드, 좁을수록 탐욕), 추세(200일선 위 비율·금리차), 밸류에이션(CAPE·버핏지수). 모두 0=공포, 100=탐욕 방향.
- F&G·AAII는 역발상 지표. CAPE 40+, 버핏지수 200%+는 역사적 극단 고평가.

## 출력 형식 (한국어, 800~1200자 내외, 마크다운)
### 한 줄 요약
지금 국면을 비유 하나로 (예: "엔진은 멀쩡한데 기름값이 비싼 상태")
### 신호별 주목 포인트
전체를 나열하지 말고, 이번 달 "가장 말이 되는 이야기" 2~4개 지표만 골라 왜 중요한지 설명. 미입력 지표가 판정을 흔들 수 있으면 언급.
### 두 렌즈 통합 읽기
7신호 종합등급과 진자 자세를 결합해 현재 국면을 해석. 직전 저장 대비 진자 이동 방향이 있으면 그 의미도.
### 다음 점검 때 볼 것
다음 달 점검에서 특히 지켜볼 지표 2~3개와 그 이유(어떤 변화가 나오면 국면 판단이 바뀌는지).

숫자를 인용할 때는 입력값을 그대로 쓰고, 없는 값은 지어내지 마세요. 미입력(null) 지표는 "미입력"으로 취급하세요.`;

const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequestPost(context) {
  const KEY = context.env && context.env.ANTHROPIC_API_KEY;
  if (!KEY) {
    return J({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Cloudflare 프로젝트 → Settings → Environment variables에 등록 후 재배포하세요.' }, 500);
  }

  let snapshot;
  try {
    snapshot = await context.request.json();
  } catch (e) {
    return J({ error: '요청 본문(JSON)을 읽을 수 없습니다.' }, 400);
  }

  const userText = `다음은 ${snapshot.date || '오늘'} 기준 대시보드의 전체 스냅샷(JSON)입니다. 위 출력 형식대로 해석해 주세요.\n\n` +
    '```json\n' + JSON.stringify(snapshot, null, 2) + '\n```';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        // Cloudflare 응답 시간 한도 안에서 끝나도록 effort는 medium (품질·속도 균형)
        output_config: { effort: 'medium' },
        system: SYSTEM,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return J({ error: 'Claude API 오류 ' + r.status + ' — ' + t.slice(0, 300) }, 502);
    }
    const res = await r.json();

    if (res.stop_reason === 'refusal') {
      return J({ error: 'AI가 이 요청에 대한 응답을 거부했습니다. 입력값을 확인 후 다시 시도하세요.' }, 502);
    }
    const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!text) return J({ error: 'AI 응답이 비어 있습니다. 잠시 후 다시 시도하세요.' }, 502);

    return J({
      text,
      truncated: res.stop_reason === 'max_tokens',
      usage: res.usage ? { input: res.usage.input_tokens, output: res.usage.output_tokens } : null,
    });
  } catch (e) {
    return J({ error: 'Claude API 호출 실패 — ' + e.message }, 502);
  }
}

// 브라우저로 직접 열었을 때 안내
export async function onRequestGet() {
  return J({ ok: true, msg: '이 엔드포인트는 대시보드의 "🤖 AI 심층 해석" 버튼이 POST로 호출합니다.' });
}
