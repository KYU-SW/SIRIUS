'use strict';
/* ═══════════════════════════════════════════════════════════
   V. 시야 자가기록 — 핵심 로직 (화면·저장소·네트워크 없음)
   ───────────────────────────────────────────────────────────
   · 측정: 정적 역치 시야검사 방식 (고정점 + 점등 자극, 4-2 dB 계단법,
           고정 손실·거짓 양성·거짓 음성 점검). 녹내장 자동시야계에서 쓰는 방식을 따릅니다.
   · 해석: 정상인 평균과 비교하지 않고 "내 기준선"과만 비교합니다.
           화면·밝기·거리가 보정되지 않은 장치이므로 절대값이 아니라 변화만 의미가 있습니다.
   · 수막종용: 중심 10° 변화, 코쪽/귀쪽(수직 중앙선) 비대칭(좌우 짝으로 계산), 양안 바깥쪽 저하,
           안장결절 위치의 집중 구역(vf-map.js) 변화를 봅니다.
   · 화면의 숫자는 '앱 점수'(0~30, 클수록 잘 보임)입니다. 내부 계산 단위는 이 장치 기준의 상대 dB 입니다.
   · 기록마다 검사 지도(mapId·점 목록)를 저장하고, 같은 mapId 기록끼리만 기준선과 비교합니다.
   · 입력은 숫자·고정 목록뿐입니다. 자유 입력 글자는 받지 않습니다.
   ═══════════════════════════════════════════════════════════ */
const VF = (() => {
  const DB_MIN = 0, DB_MAX = 30;           // 0 = 가장 밝은 자극, 30 = 가장 어두운 자극
  const BG_LIN = 0.10;                     // 배경의 선형 휘도 (0~1)
  const STIM = Object.freeze({ sizeDeg:0.43, durMs:200, windowMs:1100, minRtMs:100 });
  const CARD_MM = 85.6;                    // 신용카드 가로 길이(ISO/IEC 7810 ID-1) — 화면 보정용
  const BLIND = Object.freeze({ x:VFMap.BLIND.tx, y:VFMap.BLIND.y, exclude:VFMap.BLIND.r });   // 맹점: 귀쪽 15°, 아래 1.5°
  const UNIT = '앱 점수';

  /* 의료진과 정할 수 있는 판정 기준 (임상 검증 전 시험용 기본값) */
  const RULES_DEFAULT = Object.freeze({
    pointDrop:6,           // 한 점이 기준선보다 이 앱 점수 이상 떨어지면 '나빠진 점'
    clusterMin:3,          // 서로 붙은 나빠진 점이 이 개수 이상이면 '의미 있는 변화'
    centralDrop:3,         // 중심 10° 평균이 이 앱 점수 이상 떨어지면 변화
    tnDrop:3,              // 귀쪽 − 코쪽(좌우 짝 평균)이 이 앱 점수 이상 더 벌어지면 변화
    urgentCentralDrop:10,  // 중심 평균이 이 앱 점수 이상 떨어지면 '큰 변화'
    urgentCluster:6,       // 나빠진 점이 이 개수 이상 붙어 있으면 '큰 변화'
    focusDrop:6,           // (임시) 집중 구역의 한 점이 기준선보다 이 앱 점수 이상 낮으면
    focusMin:2             // (임시) … 그런 집중 점이 이 개수 이상이면 변화 사유
  });
  const RULE_LIMITS = Object.freeze({
    pointDrop:[3,15], clusterMin:2, centralDrop:[1,10], tnDrop:[1,10], urgentCentralDrop:[4,25], urgentCluster:[3,30],
    focusDrop:[3,15], focusMin:[1,3]
  });
  /* 신뢰도 기준 */
  const REL = Object.freeze({ fp:0.15, fl:0.33, fn:0.33, stray:0.15, strayMinTrials:20 });
  function sanitizeRules(r){
    const out = {};
    for(const k of Object.keys(RULES_DEFAULT)){
      const lim = RULE_LIMITS[k], v = r && Number(r[k]);
      const [lo, hi] = Array.isArray(lim) ? lim : [lim, 30];
      out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : RULES_DEFAULT[k];
    }
    return out;
  }

  /* ── 1. 검사 위치 ─────────────────────────────────────── */
  /* 좌표: 환자가 보는 방향 기준 (x>0 오른쪽, y>0 위쪽), 단위 도(°). 지도는 vf-map.js 가 만듭니다.
     grid(eye) 는 예전 30점 지도(legacy-30)이며 예전 기록과의 호환용으로만 남깁니다. */
  const YS = [-9,-3,3,9], XS_P = [-21,-15,15,21];
  const blindCenter = VFMap.blindCenter;
  const grid = eye => VFMap.legacy(eye).points;
  const LEGACY = 'legacy-30';
  /* 기록 → 지도. mapId 가 없는 예전 기록은 legacy-30 */
  const mapOf = t => VFMap.mapById(t && t.mapId ? t.mapId : LEGACY, t.eye);
  const pointsOf = t => mapOf(t).points;

  /* ── 2. 화면 기하·밝기 ────────────────────────────────── */
  const degToMm = (deg, distMm) => distMm * Math.tan(deg * Math.PI / 180);
  function toPx(p, distMm, ppm, cx, cy){
    return { px: cx + degToMm(p.x, distMm) * ppm, py: cy - degToMm(p.y, distMm) * ppm };
  }
  const sizePx = (deg, distMm, ppm) => 2 * distMm * Math.tan(deg / 2 * Math.PI / 180) * ppm;
  const pxPerMmFromCard = cardPx => cardPx / CARD_MM;
  /* 이 거리에서 가장 바깥 점(21°)이 화면에 들어오는지, 안 들어오면 몇 mm 이하여야 하는지 */
  function fitCheck({ w, h, distMm, ppm }){
    const maxX = Math.max(...XS_P.map(Math.abs)), maxY = Math.max(...YS.map(Math.abs));
    const margin = 12;   // px
    const haveW = w / 2 - margin, haveH = h / 2 - margin;
    const needW = degToMm(maxX, distMm) * ppm + sizePx(STIM.sizeDeg, distMm, ppm);
    const needH = degToMm(maxY, distMm) * ppm + sizePx(STIM.sizeDeg, distMm, ppm);
    const rad = d => d * Math.PI / 180, half = Math.tan(rad(STIM.sizeDeg / 2)) * 2;   // 자극 지름 몫
    const maxDistMm = Math.min(haveW / ppm / (Math.tan(rad(maxX)) + half), haveH / ppm / (Math.tan(rad(maxY)) + half));
    return { ok: needW <= haveW && needH <= haveH, needW, haveW, needH, haveH, maxDistMm: Math.floor(maxDistMm) };
  }
  const linToSrgb8 = l => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055));
  const BG_LEVEL = linToSrgb8(BG_LIN);
  /* dB → 화면 회색값(0~255). dB가 클수록 배경과 가까운(어두운) 자극 */
  function dbToLevel(db){
    const d = Math.min(DB_MAX, Math.max(DB_MIN, db));
    return linToSrgb8(BG_LIN + (1 - BG_LIN) * Math.pow(10, -d / 20));
  }

  /* ── 3. 검사 진행기 ───────────────────────────────────── */
  function newPoint(p){ return { p, cur:null, step:4, rev:0, dir:0, lastSeen:null, done:false, thr:null, unseen:false, n:0 }; }
  function finishPoint(st, thr){
    st.done = true;
    if(thr == null){ st.thr = DB_MIN; st.unseen = true; } else st.thr = thr;
  }
  function stepPoint(st, seen){
    st.n++;
    const dir = seen ? 1 : -1;
    if(seen) st.lastSeen = st.lastSeen == null ? st.cur : Math.max(st.lastSeen, st.cur);
    if(st.dir !== 0 && dir !== st.dir){ st.rev++; if(st.rev === 1) st.step = 2; }
    st.dir = dir;
    if(st.rev >= 2) return finishPoint(st, st.lastSeen);
    let next = st.cur + dir * st.step;
    if(next > DB_MAX){ if(seen && st.cur === DB_MAX) return finishPoint(st, DB_MAX); next = DB_MAX; }
    if(next < DB_MIN){ if(!seen && st.cur === DB_MIN) return finishPoint(st, null); next = DB_MIN; }
    st.cur = next;
  }
  const evenClamp = v => Math.min(28, Math.max(4, 2 * Math.round(v / 2)));

  function createTest({ eye, map = null, rng = Math.random, startDb = 26 } = {}){
    const pts = map ? map.points : grid(eye);
    if(map && map.eye !== eye) throw new Error('eye');
    const states = pts.map(newPoint);
    const rel = { fp:0, fpN:0, fl:0, flN:0, fn:0, fnN:0 };
    const fnQueue = [];
    let pending = null, last = null, trials = 0, fnPlanned = 0;

    function seed(st){
      if(st.cur != null) return;
      const near = states.filter(o => o.done && !o.unseen && Math.hypot(o.p.x - st.p.x, o.p.y - st.p.y) <= 8.5);
      const pool = near.length ? near : states.filter(o => o.done && !o.unseen);
      st.cur = pool.length ? evenClamp(pool.reduce((a, o) => a + o.thr, 0) / pool.length) : startDb;
    }
    function pickPoint(){
      const open = states.filter(s => !s.done);
      if(!open.length) return null;
      const choices = open.length > 1 ? open.filter(s => s !== last) : open;
      return choices[Math.floor(rng() * choices.length) % choices.length];
    }
    function next(){
      if(pending) return pending;
      const open = states.some(s => !s.done);
      if(!open && !fnQueue.length) return null;
      const r = rng();
      if(open && trials > 3){
        if(r < 0.08)      return (pending = { kind:'fp', x:0, y:0, db:null });
        if(r < 0.16){
          const b = blindCenter(eye);
          return (pending = { kind:'blind', x:b.x, y:b.y, db:6 });
        }
      }
      if(fnQueue.length && (!open || r > 0.82)){
        const st = fnQueue.shift();
        return (pending = { kind:'fn', x:st.p.x, y:st.p.y, db:Math.max(DB_MIN, st.thr - 9), ref:st });
      }
      const st = pickPoint();
      if(!st) return next();
      seed(st);
      return (pending = { kind:'stim', x:st.p.x, y:st.p.y, db:st.cur, st });
    }
    function answer(seen){
      const t = pending; if(!t) return;
      pending = null; trials++;
      if(t.kind === 'fp'){ rel.fpN++; if(seen) rel.fp++; }
      else if(t.kind === 'blind'){ rel.flN++; if(seen) rel.fl++; }
      else if(t.kind === 'fn'){ rel.fnN++; if(!seen) rel.fn++; }
      else {
        last = t.st;
        stepPoint(t.st, !!seen);
        if(t.st.done && !t.st.unseen && t.st.thr >= 9 && fnPlanned < 6 && rng() < 0.25){ fnQueue.push(t.st); fnPlanned++; }
      }
    }
    const progress = () => ({ done: states.filter(s => s.done).length, total: states.length, trials });
    const finished = () => !pending && states.every(s => s.done) && !fnQueue.length;
    function result(){
      const th = states.map(s => s.done ? s.thr : null);
      const out = {
        eye,
        th,
        un: states.map((s, i) => s.unseen ? i : -1).filter(i => i >= 0),
        rel: { ...rel, tr:trials }
      };
      if(map){ out.mapId = map.mapId; out.pts = VFMap.ptsOf(map); }
      return out;
    }
    const discard = () => { pending = null; };      // 화면을 벗어나 판단할 수 없는 시행은 기록하지 않고 버립니다
    return { next, answer, discard, progress, finished, result, get pending(){ return pending; } };
  }

  /* 신뢰도: 거짓 양성 >15%, 고정 손실 >33%, 거짓 음성 >33% 이면 신뢰하기 어려움 (시행 수가 충분할 때만).
     과다 stray(빛이 없을 때·반응 시간 밖에서 누른 횟수)가 전체 시행의 15%를 넘어도(시행 20회 이상) 신뢰하기 어려움.
     st·tr 가 없는 예전 기록은 stray 기준을 적용하지 않습니다. */
  function isReliable(r){
    const bad = (n, d, min, lim) => d >= min && n / d > lim;
    const stray = Number.isInteger(r.st) && Number.isInteger(r.tr) && bad(r.st, r.tr, REL.strayMinTrials, REL.stray);
    return !(bad(r.fp, r.fpN, 4, REL.fp) || bad(r.fl, r.flN, 4, REL.fl) || bad(r.fn, r.fnN, 3, REL.fn) || stray);
  }
  /* 신뢰도 낮음의 이유(화면 안내용 코드) */
  function relProblems(r){
    const bad = (n, d, min, lim) => d >= min && n / d > lim;
    const out = [];
    if(bad(r.fp, r.fpN, 4, REL.fp)) out.push('fp');
    if(bad(r.fl, r.flN, 4, REL.fl)) out.push('fl');
    if(bad(r.fn, r.fnN, 3, REL.fn)) out.push('fn');
    if(Number.isInteger(r.st) && Number.isInteger(r.tr) && bad(r.st, r.tr, REL.strayMinTrials, REL.stray)) out.push('stray');
    return out;
  }
  const pct = (n, d) => d ? Math.round(100 * n / d) : null;

  /* ── 4. 통계 ──────────────────────────────────────────── */
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  /* 짝 목록: [귀쪽 점 번호, 코쪽 점 번호] */
  function pairIdx(g){
    const by = new Map();
    g.forEach((p, i) => { if(p.pair == null) return; const e = by.get(p.pair) || {}; e[p.temporal ? 't' : 'n'] = i; by.set(p.pair, e); });
    return [...by.values()].filter(e => e.t != null && e.n != null).map(e => [e.t, e.n]);
  }
  /* th: 검사 한 번의 값 배열(지도 순서). pts 를 주지 않으면 예전 30점 지도 */
  function stats(eye, th, pts){
    const g = pts || grid(eye);
    const pick = f => mean(g.map((p, i) => f(p) ? th[i] : null).filter(v => v != null));
    const pairs = pairIdx(g);
    return {
      ms: pick(() => true),
      central: pick(p => p.central),
      periph: pick(p => !p.central),
      temporal: pick(p => p.temporal),
      nasal: pick(p => !p.temporal),
      tn: mean(pairs.map(([t, n]) => th[t] - th[n])),            // 귀쪽 − 코쪽 (좌우 짝 평균)
      nPairs: pairs.length,
      focus: pick(p => p.zone),                                   // 집중 구역 3점 평균 (없으면 null)
      focusMirror: pick(p => p.role === 'focus' && !p.zone),       // 집중 구역의 −x 짝 평균
      supTemporal: pick(p => p.temporal && p.upper),
      unseen: 0
    };
  }
  const statsOf = t => stats(t.eye, t.th, pointsOf(t));

  /* ── 5. 변화 분석 ─────────────────────────────────────── */
  function clusterSize(eye, idxs, pts){
    const g = pts || grid(eye), set = new Set(idxs); let best = 0;
    const seen = new Set();
    for(const i of idxs){
      if(seen.has(i)) continue;
      let n = 0; const stack = [i]; seen.add(i);
      while(stack.length){
        const a = stack.pop(); n++;
        for(const j of set){
          if(seen.has(j)) continue;
          if(Math.hypot(g[a].x - g[j].x, g[a].y - g[j].y) <= 8.5){ seen.add(j); stack.push(j); }
        }
      }
      best = Math.max(best, n);
    }
    return best;
  }
  function slope(xs, ys){
    const n = xs.length, mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0;
    for(let i = 0; i < n; i++){ sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    if(!sxx) return { slope:0, t:0 };
    const b = sxy / sxx, a = my - b * mx;
    let sse = 0; for(let i = 0; i < n; i++) sse += (ys[i] - (a + b * xs[i])) ** 2;
    const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
    return { slope:b, t: se > 0 && Number.isFinite(se) ? b / se : (b === 0 ? 0 : -Infinity * Math.sign(-b)) };
  }
  const dayNum = d => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);

  /* 이 눈에서 비교에 쓸 지도: 가장 최근 기록의 지도 (기록이 없으면 legacy-30) */
  function currentMapId(eye, tests){
    const mine = (tests || []).filter(t => t.eye === eye);
    return mine.length ? (mine[mine.length - 1].mapId || LEGACY) : LEGACY;
  }
  /* 비교 구간: 이 눈의 기록 중 끝에서부터 같은 mapId 가 이어진 기록들.
     지도가 바뀌면(예전 지도로 돌아가도) 새 구간이 시작되어 기준선을 새로 만듭니다(1/2). */
  function segmentOf(eye, tests){
    const all = (tests || []).filter(t => t.eye === eye);
    const mapId = all.length ? (all[all.length - 1].mapId || LEGACY) : LEGACY;
    let i = all.length;
    while(i > 0 && (all[i - 1].mapId || LEGACY) === mapId) i--;
    return { mapId, all, seg: all.slice(i) };
  }
  function analyzeEye(eye, tests, rulesIn){
    const rules = sanitizeRules(rulesIn);
    const { mapId, all, seg:mine } = segmentOf(eye, tests);           // 같은 지도 기록만 비교
    const rel = mine.filter(t => t.reliable);
    const map = VFMap.mapById(mapId, eye);
    const out = { eye, mapId, mapDesc:map.desc, zone:map.zone, nTests: mine.length, nAll: all.length, otherMap: all.length - mine.length,
                  nReliable: rel.length, excluded: mine.length - rel.length,
                  state:'none', level:0, follow:[], pattern:'none', trend:null, baseline:null, latest:null };
    if(!mine.length) return out;
    if(rel.length < 2) return { ...out, state:'baseline', need: 2 - rel.length };
    const g = map.points, a = rel[0].th, b = rel[1].th;
    const base = g.map((p, i) => (a[i] + b[i]) / 2);
    const d2 = g.map((p, i) => (a[i] - b[i]) ** 2);
    const pooled = Math.sqrt(mean(d2) / 2);                  // 두 기준선 검사에서 본 점별 흔들림(SD)
    const nCentral = g.filter(p => p.central).length || 1;
    const bs = stats(eye, base, g);
    const pointThr = Math.min(12, Math.max(rules.pointDrop, 2 * pooled));
    const centralThr = Math.max(rules.centralDrop, 2.5 * pooled / Math.sqrt(nCentral));
    const tnThr = Math.max(rules.tnDrop, 2.5 * pooled * Math.sqrt(2 / Math.max(1, bs.nPairs)));
    const zoneIdx = g.map((p, i) => p.zone ? i : -1).filter(i => i >= 0);
    out.baseline = { ms:r1(bs.ms), central:r1(bs.central), temporal:r1(bs.temporal), nasal:r1(bs.nasal), tn:r1(bs.tn), focus:r1(bs.focus),
                     pooledSd:r1(pooled), pointThr:r1(pointThr), dates:[rel[0].date, rel[1].date] };

    out.follow = rel.slice(2).map((t, k) => {
      const worse = [];
      g.forEach((p, i) => { if(base[i] >= 6 && t.th[i] - base[i] <= -pointThr) worse.push(i); });
      const s = stats(eye, t.th, g);
      const dCentral = s.central - bs.central, dPeriph = s.periph - bs.periph;
      const dTN = s.tn - bs.tn;                                   // 짝으로 계산한 귀쪽−코쪽 차이의 변화
      const dFocus = s.focus == null ? null : s.focus - bs.focus;
      const focusWorse = zoneIdx.filter(i => t.th[i] - base[i] <= -rules.focusDrop);
      const cluster = clusterSize(eye, worse, g);
      const reasons = [];
      if(cluster >= rules.clusterMin) reasons.push('cluster');
      if(dCentral <= -centralThr) reasons.push('central');
      if(dTN <= -tnThr) reasons.push('temporal');
      if(zoneIdx.length && focusWorse.length >= rules.focusMin) reasons.push('focus');   // 임시 기준 (임상 검증 전)
      const severe = dCentral <= -rules.urgentCentralDrop || cluster >= rules.urgentCluster;
      return {
        pos:k + 2, date:t.date, ms:r1(s.ms), dMs:r1(s.ms - bs.ms), central:r1(s.central), dCentral:r1(dCentral),
        dPeriph:r1(dPeriph), dTN:r1(dTN), focus:r1(s.focus), dFocus:r1(dFocus), nFocusWorse:focusWorse.length, focusWorseIdx:focusWorse,
        nWorse:worse.length, cluster, worse:reasons.length > 0, reasons, severe, worseIdx:worse
      };
    });
    out.latest = out.follow[out.follow.length - 1] || null;
    const L = out.latest, P = out.follow[out.follow.length - 2];
    if(!L){ out.state = 'tracking'; out.level = 0; }
    else if(L.worse && P && P.worse){ out.state = 'confirmed'; out.level = L.severe ? 3 : 2; }
    else if(L.worse){ out.state = 'recheck'; out.level = L.severe ? 2 : 1; }
    else { out.state = 'stable'; out.level = 0; }
    if(L && L.worse){
      const wc = L.worseIdx.filter(i => g[i].central).length;
      if((L.reasons.includes('central') && L.dCentral <= L.dPeriph - 2) || (L.nWorse >= 3 && wc >= 0.6 * L.nWorse)) out.pattern = 'central';
      else if(L.reasons.includes('temporal')) out.pattern = 'temporal';
      else if(L.reasons.includes('focus')) out.pattern = map.zone === 'central' ? 'central' : 'temporal';
      else out.pattern = 'diffuse';
    }
    if(rel.length >= 5){
      const d0 = dayNum(rel[0].date);
      const xs = rel.map(t => (dayNum(t.date) - d0) / 30.4);
      const ms = slope(xs, rel.map(t => stats(eye, t.th, g).ms));
      const ce = slope(xs, rel.map(t => stats(eye, t.th, g).central));
      out.trend = {
        msPerMonth:r1(ms.slope), msT:r1(ms.t), centralPerMonth:r1(ce.slope), centralT:r1(ce.t),
        declining: (ms.slope <= -0.5 && ms.t <= -2) || (ce.slope <= -0.5 && ce.t <= -2)
      };
    }
    return out;
  }

  /* ── 6. 증상 점검 (자유 입력 없음) ───────────────────── */
  const SYMPTOMS = Object.freeze([
    { id:'sudden',    tier:'emergency', text:'갑자기 한쪽 또는 양쪽 눈이 잘 안 보이게 됨 (커튼이 내려오듯 가려짐 포함)' },
    { id:'neuro',     tier:'emergency', text:'발작(경련), 의식이 흐려짐, 말이 안 나옴, 한쪽 팔다리에 힘이 빠짐' },
    { id:'headache',  tier:'emergency', text:'평소와 다른 심한 두통이 갑자기 시작되고 구토가 함께 있음' },
    { id:'diplopia',  tier:'urgent',    text:'물체가 둘로 보이는 증상이 새로 생김' },
    { id:'blur',      tier:'urgent',    text:'며칠 사이 흐려짐·가려짐이 눈에 띄게 늘어남' },
    { id:'color',     tier:'urgent',    text:'한쪽 눈으로 볼 때 색이 바랜 듯 보임 (특히 빨간색)' },
    { id:'pain',      tier:'urgent',    text:'눈을 움직일 때 눈 뒤쪽이 아픔' },
    { id:'proptosis', tier:'urgent',    text:'한쪽 눈이 튀어나오거나 눈꺼풀이 처짐' }
  ]);
  const SYMPTOM_IDS = new Set(SYMPTOMS.map(s => s.id));
  function symptomLevel(ids){
    let lv = 0;
    for(const id of ids || []){
      const s = SYMPTOMS.find(x => x.id === id);
      if(s) lv = Math.max(lv, s.tier === 'emergency' ? 4 : 3);
    }
    return lv;
  }

  const LEVEL = Object.freeze([
    { key:'stable',    label:'기준선과 비슷합니다', action:'지금 방식대로 정해진 간격으로 검사를 이어가세요. 다음 진료 때 이 기록을 보여 주세요.' },
    { key:'recheck',   label:'한 번 나빠진 결과가 있습니다', action:'피로·조명·자세 때문일 수 있습니다. 1~2일 안에 쉬고 난 뒤 같은 방식으로 다시 검사하세요. 같은 결과가 또 나오면 진료팀에 연락하세요.' },
    { key:'contact',   label:'나빠진 결과가 반복되었습니다', action:'다음 외래를 기다리지 말고 며칠 안에 담당 신경외과(또는 안과)에 연락해 이 요약을 전달하세요.' },
    { key:'urgent',    label:'오늘 연락이 필요한 신호입니다', action:'오늘 담당 진료과에 전화로 알리세요. 연결되지 않으면 응급실 진료를 고려하세요.' },
    { key:'emergency', label:'응급 신호가 선택되었습니다', action:'지금 바로 응급실로 가거나 119에 연락하세요. 이 앱의 검사는 하지 마세요.' }
  ]);

  /* 아직 어느 눈도 기준선과 비교할 수 없을 때(검사 0회 또는 기준선 2회 수집 중) 쓰는 상태.
     LEVEL[0](기준선과 비슷합니다)을 쓰면 비교하지 않았는데 '안정'처럼 보이므로 따로 둡니다. */
  const PENDING = Object.freeze({ key:'pending', label:'아직 비교 전입니다',
    action:'눈마다 같은 조건에서 기준선 검사를 2번(하루 이틀 간격) 하면 그다음 검사부터 내 기준선과 비교합니다.' });
  const pendingInfo = n => Object.freeze({ ...PENDING, n, label:`${PENDING.label} (기준선 측정 중 ${n}/2)` });

  /* 전체 판정: 눈별 분석 + 가장 최근 증상 점검 */
  function assess(state, nowDay){
    const tests = state.tests || [];
    const R = analyzeEye('R', tests, state.rules), L = analyzeEye('L', tests, state.rules);
    const logs = state.symptoms || [];
    const lastSym = logs.length ? logs[logs.length - 1] : null;
    const symFresh = lastSym && (nowDay == null || nowDay - dayNum(lastSym.date) <= 14);
    const sLevel = symFresh ? symptomLevel(lastSym.ids) : 0;
    let bitemporal = false;
    if(R.pattern === 'temporal' && L.pattern === 'temporal' && R.level >= 1 && L.level >= 1) bitemporal = true;
    let level = Math.max(R.level, L.level, sLevel);
    if(bitemporal) level = Math.max(level, 2);   // 양쪽 눈 바깥쪽 저하는 한쪽 변화보다 중요하게 봅니다
    const waiting = e => e.state === 'none' || e.state === 'baseline';
    const pending = level === 0 && waiting(R) && waiting(L);
    const n = Math.min(2, Math.max(R.nReliable, L.nReliable));
    return { R, L, level, bitemporal, pending, symptomLevel:sLevel, symptomIds: symFresh ? lastSym.ids : [],
             info: pending ? pendingInfo(n) : LEVEL[level] };
  }

  /* ── 7. 가져오기 검증 (신뢰하지 않는 입력을 숫자·목록으로만 다시 만든다) ── */
  const MAX_TESTS = 400, MAX_SYMPTOM_LOGS = 400;
  function validDate(s){
    if(typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s && s >= '2020-01-01' && s <= '2100-12-31';
  }
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  function cleanState(raw){
    if(!raw || typeof raw !== 'object' || raw.app !== 'sirius-vf' || raw.v !== 1) throw new Error('형식');
    if(!Array.isArray(raw.tests) || raw.tests.length > MAX_TESTS) throw new Error('검사 수');
    const tests = raw.tests.map(t => {
      if(!t || (t.eye !== 'R' && t.eye !== 'L') || !validDate(t.date)) throw new Error('검사 항목');
      /* 지도: mapId 가 없으면 예전 30점(legacy-30). 있으면 알려진 값이어야 하고, 점 목록은 그 지도와 정확히 같아야 합니다 */
      const mapId = t.mapId === undefined || t.mapId === null ? LEGACY : t.mapId;
      if(typeof mapId !== 'string' || !VFMap.MAP_IDS.includes(mapId)) throw new Error('지도');
      const map = VFMap.mapById(mapId, t.eye);
      if(t.pts !== undefined && t.pts !== null && !VFMap.samePts(t.pts, map)) throw new Error('지도 점');
      const n = map.n;
      if(!Array.isArray(t.th) || t.th.length !== n || !t.th.every(v => int(v, DB_MIN, DB_MAX))) throw new Error('역치');
      const un = Array.isArray(t.un) ? t.un : [];
      if(un.length > n || !un.every(i => int(i, 0, n - 1))) throw new Error('미응답 점');
      const r = t.rel || {};
      const rel = {};
      for(const k of ['fp', 'fpN', 'fl', 'flN', 'fn', 'fnN']){
        if(!int(r[k], 0, 1000)) throw new Error('신뢰도');
        rel[k] = r[k];
      }
      if(r.st !== undefined || r.tr !== undefined){                      // stray·전체 시행 수 (새 기록만)
        if(!int(r.st, 0, 5000) || !int(r.tr, 0, 5000)) throw new Error('신뢰도');
        rel.st = r.st; rel.tr = r.tr;
      }
      const dist = int(t.dist, 20, 80) ? t.dist : null;
      return { date:t.date, eye:t.eye, mapId, pts:VFMap.ptsOf(map), th:t.th.slice(), un:[...new Set(un)].sort((x, y) => x - y), rel, reliable:isReliable(rel), dist };
    });
    const symptoms = (Array.isArray(raw.symptoms) ? raw.symptoms : []).slice(0, MAX_SYMPTOM_LOGS).map(s => {
      if(!s || !validDate(s.date) || !Array.isArray(s.ids)) throw new Error('증상 항목');
      return { date:s.date, ids:[...new Set(s.ids.filter(id => SYMPTOM_IDS.has(id)))] };
    });
    return { tests, symptoms, rules: sanitizeRules(raw.rules) };
  }
  const exportable = state => ({
    app:'sirius-vf', v:1,
    tests: state.tests.map(t => ({ date:t.date, eye:t.eye, mapId:t.mapId || LEGACY, pts:t.pts || VFMap.ptsOf(mapOf(t)), th:t.th, un:t.un, rel:t.rel, dist:t.dist })),
    symptoms: state.symptoms,
    rules: state.rules
  });

  /* ── 8. 진료용 요약 (문장은 모두 이 파일의 고정 문구 + 숫자) ── */
  const EYE_KO = { R:'오른쪽 눈', L:'왼쪽 눈' };
  const PATTERN_KO = {
    central:'중심 시야 쪽 변화가 두드러집니다', temporal:'귀쪽(바깥쪽) 시야가 코쪽보다 더 나빠졌습니다',
    diffuse:'여러 곳에서 고르게 낮아졌습니다', none:'뚜렷한 패턴 없음'
  };
  const fmt = v => v == null ? '–' : (v > 0 ? '+' : '') + v;
  const ZONE_KO = Object.freeze({ 'temporal-upper':'귀쪽 위', central:'중심' });
  const focusDropLabel = L => `${UNIT} 6 이상 낮은 집중 점 ${L.nFocusWorse}/3`;
  function questions(a){
    const q = [
      '이 시야 기록의 변화가 최근 MRI 경과와 맞는지 알려 주세요.',
      '제가 집에서 하는 검사는 병원 시야검사를 대신할 수 없다고 이해합니다. 병원 시야검사(자동시야계)는 언제, 얼마나 자주 받으면 좋을까요?',
      '어느 정도 변화가 있을 때 바로 연락하면 좋을지 기준을 정해 주세요. (이 앱의 기준값은 조정할 수 있습니다.)'
    ];
    if(a.bitemporal || a.R.pattern === 'temporal' || a.L.pattern === 'temporal')
      q.push('양쪽 눈 바깥쪽 시야 변화는 시신경이 교차하는 부위와 관련될 수 있다고 들었습니다. 추가 검사가 필요한가요?');
    if(a.R.pattern === 'central' || a.L.pattern === 'central')
      q.push('중심 시야 변화가 있습니다. 시신경 가까이에 있는 병변과 관련해 시력·색각·시신경 검사를 더 받아야 하나요?');
    q.push('수술·방사선 치료 시기를 판단할 때 시야 변화를 어떻게 반영하나요?');
    return q;
  }
  function buildSummary(state, nowDay){
    const a = assess(state, nowDay);
    const lines = [];
    const tests = state.tests;
    lines.push('SIRIUS 시야 자가기록 요약 (진단이 아닙니다)');
    lines.push('측정: 집에서 화면으로 한 정적 시야검사 방식. 병원 자동시야계가 아니며 정상인 평균과 비교하지 않고 본인 기준선과의 변화만 봅니다.');
    lines.push(`기록: 검사 ${tests.length}회 (신뢰도 낮음 ${tests.filter(t => !t.reliable).length}회 제외) · ${tests.length ? tests[0].date + ' ~ ' + tests[tests.length - 1].date : '없음'}`);
    lines.push(`현재 판정: ${a.info.label}`);
    lines.push(`권장 행동: ${a.info.action}`);
    for(const eye of ['R', 'L']){
      const e = a[eye];
      const tag = `${EYE_KO[eye]} [지도 ${e.mapId}]`;
      if(!e.nAll){ lines.push(`${EYE_KO[eye]}: 검사 기록 없음`); continue; }
      const other = e.otherMap ? ` · 다른 지도 기록 ${e.otherMap}회는 비교에서 뺐습니다` : '';
      if(e.state === 'baseline'){ lines.push(`${tag}: 기준선 측정 중 (신뢰할 수 있는 검사 ${e.nReliable}/2)${other}`); continue; }
      const L = e.latest;
      lines.push(`${tag}: 기준선 평균 ${e.baseline.ms}, 중심 10° ${e.baseline.central}, 귀쪽−코쪽 ${fmt(e.baseline.tn)}${e.baseline.focus != null ? `, 집중 구역(${ZONE_KO[e.zone]}) ${e.baseline.focus}` : ''} (${UNIT}, 기준선 흔들림 SD ${e.baseline.pooledSd})${other}`);
      if(L){
        lines.push(`  최근(${L.date}) 평균 ${L.ms} (${fmt(L.dMs)}), 중심 ${L.central} (${fmt(L.dCentral)}), 귀쪽−코쪽 차이 변화 ${fmt(L.dTN)}${L.dFocus != null ? `, 집중 구역 변화 ${fmt(L.dFocus)} (${focusDropLabel(L)})` : ''}, 나빠진 점 ${L.nWorse}개 (붙은 최대 ${L.cluster}개)`);
        if(L.reasons.includes('focus')) lines.push(`  임시 변화 사유: 집중 구역 점 ${L.nFocusWorse}개가 기준선보다 ${UNIT} 6 이상 낮습니다 (임상 검증 전 임시 기준)`);
        if(e.pattern !== 'none') lines.push(`  양상: ${PATTERN_KO[e.pattern]}`);
      } else lines.push('  기준선 이후 검사 없음');
      if(e.trend) lines.push(`  추세: 평균 ${fmt(e.trend.msPerMonth)}/월, 중심 ${fmt(e.trend.centralPerMonth)}/월 (${UNIT})${e.trend.declining ? ' (감소 추세)' : ''}`);
    }
    if(a.bitemporal) lines.push('양쪽 눈 모두 귀쪽(바깥쪽) 시야가 나빠지는 양상이 함께 보입니다.');
    if(a.symptomIds.length) lines.push('최근 증상 점검 응답: ' + a.symptomIds.map(id => SYMPTOMS.find(s => s.id === id).text).join(' / '));
    lines.push(`한계: 숫자는 이 장치 기준의 ${UNIT}(0~30)이며 병원 시야계의 dB 와 다릅니다. 화면 크기·밝기·거리·고정 유지는 보정만 했을 뿐 시선 추적이 없고, 판정 기준값은 임상 검증 전 시험용입니다. 결정은 담당 의료진이 합니다.`);
    return { assessment:a, lines, questions:questions(a) };
  }

  /* 경과 관찰 화면용 요약: 눈마다 현재 지도 기준의 평균·귀쪽−코쪽·집중 구역 변화와 그래프 점 */
  function digest(state){
    const tests = (state && state.tests) || [];
    const out = [];
    for(const eye of ['R', 'L']){
      const e = analyzeEye(eye, tests, state && state.rules);
      if(!e.nAll) continue;
      const pts = segmentOf(eye, tests).seg.map(t => ({ date:t.date, v:r1(statsOf(t).ms), unreliable:!t.reliable }));
      const L = e.latest;
      out.push({
        eye, mapId:e.mapId, zone:e.zone, zoneKo:e.zone ? ZONE_KO[e.zone] : '', state:e.state, nTests:e.nTests, nReliable:e.nReliable, otherMap:e.otherMap,
        baseline:e.baseline, pts,
        latest: L ? { date:L.date, ms:L.ms, dMs:L.dMs, dTN:L.dTN, dFocus:L.dFocus, nFocusWorse:L.nFocusWorse, worse:L.worse, reasons:L.reasons.slice() } : null
      });
    }
    return out;
  }

  return Object.freeze({
    DB_MIN, DB_MAX, BG_LEVEL, STIM, CARD_MM, BLIND, RULES_DEFAULT, REL, UNIT, SYMPTOMS, LEVEL, PENDING, EYE_KO, PATTERN_KO, ZONE_KO, LEGACY,
    sanitizeRules, grid, mapOf, pointsOf, blindCenter, degToMm, toPx, sizePx, pxPerMmFromCard, fitCheck, dbToLevel,
    createTest, isReliable, relProblems, pct, stats, statsOf, analyzeEye, currentMapId, segmentOf, assess, symptomLevel, dayNum, validDate,
    cleanState, exportable, buildSummary, questions, digest, r1, fmt
  });
})();
