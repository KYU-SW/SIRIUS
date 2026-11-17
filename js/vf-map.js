'use strict';
/* ═══════════════════════════════════════════════════════════
   V. 시야 기록 — 검사 지도 (화면·저장소·네트워크 없음)
   ───────────────────────────────────────────────────────────
   · 기준 좌표(tx, y): 귀쪽을 +tx 로 정의합니다(눈과 무관). 화면 좌표 x 는 눈에 따라 좌우를 뒤집습니다.
       오른눈: x = +tx (귀쪽 = 화면 오른쪽) · 왼눈: x = −tx (귀쪽 = 화면 왼쪽)
   · 기본 지도(base-v1): tx = ±3, ±9, ±15, ±21 · y = ±3, ±9 (32점) 에서 tx = ±15, y = ±3 의 네 점을 빼 28점 / 14쌍.
       (귀쪽 (15,±3)은 맹점 (15,−1.5) 반경 5° 와 겹치고, 코쪽 (−15,±3)은 좌우 짝을 맞추려고 함께 뺍니다.)
   · 집중 구역: 귀쪽 위 (6,6)(12,6)(6,3) / 중심 (6,3)(6,−3)(6,6) — 각 점의 −tx 짝을 함께 넣어 3쌍(6점)을 더합니다.
   · 안장결절(sellar) 위치일 때만 집중 구역을 씁니다. 그 밖의 위치는 base-v1 입니다.
       가운데·모름 → sellar-mid-v1 (두 눈 귀쪽 위)
       왼쪽 치우침 → sellar-left-v1 (왼눈 중심 · 오른눈 귀쪽 위)
       오른쪽 치우침 → sellar-right-v1 (왼눈 귀쪽 위 · 오른눈 중심)
   · legacy-30: 예전 grid(eye) 30점(맹점 근처 두 점만 뺀 8×4 격자). 예전 기록을 읽고 비교하기 위해서만 둡니다.
   · 제안값(문서 기준, 임상 검증 전): 집중점 3쌍 · 가장 바깥 21° 유지 · 치우친 쪽 모름 = 가운데.
   ═══════════════════════════════════════════════════════════ */
const VFMap = (() => {
  const BLIND = Object.freeze({ tx:15, y:-1.5, r:5 });          // 기준 좌표의 맹점 (귀쪽 15°, 아래 1.5°), 제외 반경 5°
  const BASE_TX = Object.freeze([3, 9, 15, 21]);
  const BASE_Y = Object.freeze([9, 3, -3, -9]);
  const MAX_DEG = 21;
  const ZONES = Object.freeze({
    'temporal-upper': Object.freeze({ ko:'귀쪽 위', pts:Object.freeze([[6, 6], [12, 6], [6, 3]]) }),
    'central':        Object.freeze({ ko:'중심',   pts:Object.freeze([[6, 3], [6, -3], [6, 6]]) }),
  });
  const SIDES = Object.freeze(['mid', 'left', 'right', 'unknown']);
  /* mapId → 눈별 집중 구역 (null = 집중 구역 없음) */
  const PLAN = Object.freeze({
    'base-v1':         Object.freeze({ R:null, L:null }),
    'sellar-mid-v1':   Object.freeze({ R:'temporal-upper', L:'temporal-upper' }),
    'sellar-left-v1':  Object.freeze({ R:'temporal-upper', L:'central' }),
    'sellar-right-v1': Object.freeze({ R:'central', L:'temporal-upper' }),
  });
  const MAP_IDS = Object.freeze([...Object.keys(PLAN), 'legacy-30']);
  const EYE_KO = Object.freeze({ R:'오른눈', L:'왼눈' });

  const sideSign = eye => eye === 'R' ? 1 : -1;               // 오른눈의 귀쪽은 화면 오른쪽
  const checkEye = eye => { if(eye !== 'R' && eye !== 'L') throw new Error('eye'); };
  const blindCenter = eye => ({ x: BLIND.tx * sideSign(eye), y: BLIND.y });
  const blindDist = (tx, y) => Math.hypot(tx - BLIND.tx, y - BLIND.y);

  function mapIdFor(loc, side){
    if(loc !== 'sellar') return 'base-v1';
    if(side === 'left') return 'sellar-left-v1';
    if(side === 'right') return 'sellar-right-v1';
    return 'sellar-mid-v1';                                     // 가운데·모름·잘못된 값
  }
  function mkPoint(eye, tx, y, role, pair, zone){
    const x = tx * sideSign(eye);
    return Object.freeze({
      id: x + ',' + y, x, y, tx, role, pair, zone: !!zone,
      central: Math.hypot(x, y) <= 10,
      temporal: tx > 0,
      upper: y > 0
    });
  }
  /* 화면에서 읽는 순서(위→아래, 왼→오른)로 정렬해 같은 입력이면 언제나 같은 순서가 되게 합니다 */
  const readOrder = (a, b) => b.y - a.y || a.x - b.x;

  function describe(mapId, eye, zone){
    const n = zone ? 34 : 28;
    if(mapId === 'legacy-30') return `예전 30점 지도(legacy-30) · 예전 기록 비교용`;
    if(!zone) return `기본 지도 ${n}점 · 중심에서 ${MAX_DEG}°까지 좌우 짝 14쌍을 고르게 봅니다.`;
    const why = { 'sellar-mid-v1':'안장결절 가운데(또는 모름)', 'sellar-left-v1':'안장결절 왼쪽 치우침', 'sellar-right-v1':'안장결절 오른쪽 치우침' }[mapId];
    return `${why} · ${EYE_KO[eye]}은 ${ZONES[zone].ko} 3쌍을 더해 ${n}점을 봅니다.`;
  }

  const CACHE = new Map();
  function build(mapId, eye){
    const key = mapId + '|' + eye;
    if(CACHE.has(key)) return CACHE.get(key);
    let points, zone = null;
    if(mapId === 'legacy-30') points = legacyPoints(eye);
    else {
      zone = PLAN[mapId][eye];
      const base = [];
      let pair = 0;
      const pairOf = new Map();
      for(const y of BASE_Y) for(const tx of BASE_TX){
        if(tx === 15 && Math.abs(y) === 3) continue;
        pairOf.set(tx + ',' + y, ++pair);
      }
      for(const y of BASE_Y) for(const tx of [...BASE_TX].reverse().map(v => -v).concat(BASE_TX)){
        const p = pairOf.get(Math.abs(tx) + ',' + y);
        if(p) base.push(mkPoint(eye, tx, y, 'base', p, false));
      }
      base.sort(readOrder);
      const focus = [];
      if(zone){
        for(const [tx, y] of ZONES[zone].pts){
          ++pair;
          focus.push(mkPoint(eye, tx, y, 'focus', pair, true));
          focus.push(mkPoint(eye, -tx, y, 'focus', pair, false));
        }
      }
      points = [...base, ...focus];
    }
    const out = Object.freeze({
      mapId, eye, zone, zoneKo: zone ? ZONES[zone].ko : '',
      points: Object.freeze(points), n: points.length,
      pairs: new Set(points.filter(p => p.pair).map(p => p.pair)).size,
      desc: describe(mapId, eye, zone),
      blind: Object.freeze({ ...blindCenter(eye), r:BLIND.r })
    });
    CACHE.set(key, out);
    return out;
  }
  /* 예전 grid(eye): x 순서 [-21,-15,-9,-3,3,9,15,21] × y 순서 [-9,-3,3,9], 맹점 반경 5° 안 점 제외 → 30점 (순서 보존 필수) */
  function legacyPoints(eye){
    const XS = [-21, -15, -9, -3, 3, 9, 15, 21], YS = [-9, -3, 3, 9];
    const raw = [];
    for(const x of XS) for(const y of YS){
      const tx = x * sideSign(eye);
      if(blindDist(tx, y) < BLIND.r) continue;
      raw.push({ x, y, tx });
    }
    const has = new Set(raw.map(p => p.tx + ',' + p.y));
    const pairNo = new Map(); let n = 0;
    for(const p of raw){
      const k = Math.abs(p.tx) + ',' + p.y;
      if(!has.has(p.tx + ',' + p.y) || !has.has(-p.tx + ',' + p.y)) continue;
      if(!pairNo.has(k)) pairNo.set(k, ++n);
    }
    return raw.map(p => mkPoint(eye, p.tx, p.y, 'base', pairNo.get(Math.abs(p.tx) + ',' + p.y) || null, false));
  }

  /** buildMap({eye, loc, side}) → { mapId, eye, loc, side, zone, zoneKo, points[], n, pairs, desc, blind } */
  function buildMap({ eye, loc, side } = {}){
    checkEye(eye);
    const s = SIDES.includes(side) ? side : 'unknown';
    const mapId = mapIdFor(loc, s);
    return Object.freeze({ ...build(mapId, eye), loc: loc === 'sellar' ? 'sellar' : (typeof loc === 'string' ? loc : 'unknown'), side: s });
  }
  function mapById(mapId, eye){
    checkEye(eye);
    if(!MAP_IDS.includes(mapId)) throw new Error('mapId');
    return build(mapId, eye);
  }
  const legacy = eye => { checkEye(eye); return build('legacy-30', eye); };
  /* 기록에 저장하는 점 목록: 화면 좌표 [x, y] 쌍 (정수) */
  const ptsOf = map => map.points.map(p => [p.x, p.y]);
  function samePts(pts, map){
    if(!Array.isArray(pts) || pts.length !== map.points.length) return false;
    return pts.every((q, i) => Array.isArray(q) && q.length === 2 && q[0] === map.points[i].x && q[1] === map.points[i].y);
  }
  /* 치우친 쪽에 따라 먼저 검사할 눈: 왼쪽 → 왼눈, 오른쪽 → 오른눈, 가운데·모름 → 정하지 않음(null) */
  const firstEye = side => side === 'left' ? 'L' : side === 'right' ? 'R' : null;

  return Object.freeze({
    BLIND, BASE_TX, BASE_Y, MAX_DEG, ZONES, SIDES, PLAN, MAP_IDS,
    sideSign, blindCenter, blindDist, mapIdFor, buildMap, mapById, legacy, ptsOf, samePts, firstEye
  });
})();
