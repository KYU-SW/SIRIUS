import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* 검사 지도(vf-map.js)·지도별 비교(vf-core.js)·경과 관찰 연동(followup-core.js). 합성 데이터만 사용합니다. */
const ctx = vm.createContext({});
for(const f of ['vf-map.js', 'vf-core.js', 'followup-core.js']) vm.runInContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), ctx);
const M = vm.runInContext('VFMap', ctx), VF = vm.runInContext('VF', ctx), FU = vm.runInContext('FU', ctx);
const J = v => JSON.parse(JSON.stringify(v));
const SELLAR = ['sellar-mid-v1', 'sellar-left-v1', 'sellar-right-v1'];
const REL_OK = { fp:0, fpN:6, fl:0, flN:6, fn:0, fnN:3 };

/* ── 지도 모양 ─────────────────────────────────────────── */
test('지도: 기본 28점/14쌍, 안장결절 34점/17쌍(눈마다), legacy-30 은 30점', () => {
  for(const eye of ['R', 'L']){
    assert.equal(M.mapById('base-v1', eye).n, 28); assert.equal(M.mapById('base-v1', eye).pairs, 14);
    for(const id of SELLAR){ assert.equal(M.mapById(id, eye).n, 34, id + eye); assert.equal(M.mapById(id, eye).pairs, 17); }
    assert.equal(M.mapById('legacy-30', eye).n, 30);
    assert.equal(VF.grid(eye).length, 30);
  }
});
test('지도: 기본 격자는 x=±3,±9,±15,±21 · y=±3,±9 에서 x=±15,y=±3 네 점만 뺀다', () => {
  for(const eye of ['R', 'L']){
    const base = M.mapById('base-v1', eye).points;
    const want = [];
    for(const x of [-21, -15, -9, -3, 3, 9, 15, 21]) for(const y of [-9, -3, 3, 9]) if(!(Math.abs(x) === 15 && Math.abs(y) === 3)) want.push(x + ',' + y);
    assert.deepEqual(J(base.map(p => p.id).sort()), want.sort());
    assert.ok(base.every(p => p.role === 'base' && !p.zone));
  }
});
test('지도: 모든 짝은 같은 y 에서 x 부호만 반대이고, 한쪽은 귀쪽·한쪽은 코쪽이다', () => {
  for(const id of M.MAP_IDS.filter(x => x !== 'legacy-30')) for(const eye of ['R', 'L']){
    const pts = M.mapById(id, eye).points, by = new Map();
    for(const p of pts){ assert.ok(Number.isInteger(p.pair) && p.pair > 0, id + eye + ' 짝 번호'); (by.get(p.pair) || by.set(p.pair, []).get(p.pair)).push(p); }
    for(const [n, ps] of by){
      assert.equal(ps.length, 2, `${id} ${eye} 짝 ${n}`);
      const [a, b] = ps;
      assert.equal(a.y, b.y); assert.equal(a.x, -b.x); assert.equal(a.tx, -b.tx);
      assert.notEqual(a.temporal, b.temporal);
      assert.equal(a.role, b.role);
    }
    assert.equal(new Set(pts.map(p => p.id)).size, pts.length, '중복 점 없음');
  }
});
test('맹점: 기준 좌표 (15,−1.5) 반경 5° 안에는 어떤 지도에도 점이 없다 (가장 가까운 점 6.18°)', () => {
  let nearest = Infinity;
  for(const id of M.MAP_IDS) for(const eye of ['R', 'L']){
    const map = M.mapById(id, eye);
    for(const p of map.points){
      const d = Math.hypot(p.tx - 15, p.y + 1.5);
      assert.ok(d >= 5, `${id} ${eye} ${p.id} 맹점과 ${d.toFixed(2)}°`);
      assert.ok(Math.hypot(p.x - map.blind.x, p.y - map.blind.y) >= 5);
      nearest = Math.min(nearest, d);
    }
  }
  assert.ok(Math.abs(nearest - Math.hypot(6, 1.5)) < 1e-9);
  assert.deepEqual(J(M.blindCenter('R')), { x:15, y:-1.5 });
  assert.deepEqual(J(M.blindCenter('L')), { x:-15, y:-1.5 });
  /* 명세의 집중 점도 모두 반경 밖: 귀쪽 위 (12,6) 은 8.08°, 중심 (6,−3) 은 9.12° */
  for(const z of Object.values(M.ZONES)) for(const [tx, y] of z.pts){ assert.ok(Math.hypot(tx - 15, y + 1.5) > 5); assert.ok(Math.hypot(-tx - 15, y + 1.5) > 5); }
});
test('좌우: 귀쪽을 +tx 로 정의하고 눈에 따라 화면 x 가 뒤집힌다', () => {
  const R = M.mapById('base-v1', 'R').points, L = M.mapById('base-v1', 'L').points;
  assert.ok(R.find(p => p.x === 21).temporal && !R.find(p => p.x === -21).temporal);
  assert.ok(L.find(p => p.x === -21).temporal && !L.find(p => p.x === 21).temporal);
  assert.ok(R.every(p => p.x === p.tx) && L.every(p => p.x === -p.tx));
  assert.equal(R.filter(p => p.temporal).length, 14); assert.equal(L.filter(p => p.temporal).length, 14);
});
test('집중 구역: 위치·치우친 쪽·눈별로 맞는 구역과 좌표를 쓴다', () => {
  const zoneOf = (loc, side, eye) => M.buildMap({ eye, loc, side }).zone;
  for(const side of ['mid', 'unknown', undefined, 'weird']) for(const eye of ['R', 'L']) assert.equal(zoneOf('sellar', side, eye), 'temporal-upper', String(side) + eye);
  assert.equal(zoneOf('sellar', 'left', 'L'), 'central'); assert.equal(zoneOf('sellar', 'left', 'R'), 'temporal-upper');
  assert.equal(zoneOf('sellar', 'right', 'L'), 'temporal-upper'); assert.equal(zoneOf('sellar', 'right', 'R'), 'central');
  for(const loc of ['cavernous', 'olfactory', 'parasagittal', 'convexity', 'cpa', 'unknown']) for(const side of M.SIDES){
    const m = M.buildMap({ eye:'R', loc, side });
    assert.equal(m.mapId, 'base-v1'); assert.equal(m.zone, null); assert.equal(m.n, 28);
  }
  const prim = m => m.points.filter(p => p.zone).map(p => [p.tx, p.y]);
  assert.deepEqual(J(prim(M.mapById('sellar-mid-v1', 'R'))), [[6, 6], [12, 6], [6, 3]]);
  assert.deepEqual(J(prim(M.mapById('sellar-left-v1', 'L'))), [[6, 3], [6, -3], [6, 6]]);
  /* 귀쪽 위 집중 점은 왼눈에서 화면 왼쪽(x<0), 오른눈에서 화면 오른쪽(x>0) */
  assert.ok(M.mapById('sellar-mid-v1', 'L').points.filter(p => p.zone).every(p => p.x < 0 && p.y > 0));
  assert.ok(M.mapById('sellar-mid-v1', 'R').points.filter(p => p.zone).every(p => p.x > 0 && p.y > 0));
  /* 각 집중 점마다 −x 짝(코쪽)이 함께 들어간다: 집중 6점 = 3쌍 */
  for(const id of SELLAR) for(const eye of ['R', 'L']){
    const f = M.mapById(id, eye).points.filter(p => p.role === 'focus');
    assert.equal(f.length, 6); assert.equal(f.filter(p => p.zone).length, 3); assert.ok(f.filter(p => p.zone).every(p => p.temporal));
  }
  /* 21° 유지: 가장 바깥 점은 모든 새 지도에서 21° */
  for(const id of M.MAP_IDS) assert.equal(Math.max(...M.mapById(id, 'R').points.map(p => Math.abs(p.x))), 21);
});
test('mapId: 같은 입력이면 같은 지도(점 순서까지), 다른 입력이면 구분된다', () => {
  const a = J(M.buildMap({ eye:'L', loc:'sellar', side:'left' })), b = J(M.buildMap({ eye:'L', loc:'sellar', side:'left' }));
  assert.deepEqual(a, b);
  assert.equal(a.mapId, 'sellar-left-v1');
  assert.equal(M.mapIdFor('sellar', 'mid'), 'sellar-mid-v1'); assert.equal(M.mapIdFor('sellar', 'unknown'), 'sellar-mid-v1');
  assert.equal(M.mapIdFor('sellar', 'left'), 'sellar-left-v1'); assert.equal(M.mapIdFor('sellar', 'right'), 'sellar-right-v1');
  assert.equal(M.mapIdFor('cpa', 'left'), 'base-v1'); assert.equal(M.mapIdFor(undefined, undefined), 'base-v1');
  assert.equal(new Set(M.MAP_IDS).size, M.MAP_IDS.length);
  assert.ok(typeof a.desc === 'string' && a.desc.includes('34'));
  assert.throws(() => M.buildMap({ eye:'X', loc:'sellar' })); assert.throws(() => M.mapById('nope', 'R'));
  assert.deepEqual(J(M.ptsOf(M.mapById('sellar-left-v1', 'L'))), a.points.map(p => [p.x, p.y]));
  assert.equal(M.firstEye('left'), 'L'); assert.equal(M.firstEye('right'), 'R'); assert.equal(M.firstEye('mid'), null);
});

/* ── 기록·비교 ─────────────────────────────────────────── */
const rec = (eye, mapId, th, date, rel = REL_OK) => {
  const map = M.mapById(mapId, eye);
  return { date, eye, mapId, pts:M.ptsOf(map), th: typeof th === 'function' ? map.points.map(th) : th, un:[], rel, reliable:VF.isReliable(rel), dist:33 };
};
const day = n => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const flat = () => 24;

test('지도 분리: 같은 mapId 끼리만 기준선을 쓰고, 지도가 바뀌면(돌아가도) 새 기준선 1/2 부터', () => {
  const tests = [rec('R', 'base-v1', flat, day(0)), rec('R', 'base-v1', flat, day(1)), rec('R', 'base-v1', flat, day(2))];
  let a = VF.analyzeEye('R', tests);
  assert.equal(a.mapId, 'base-v1'); assert.equal(a.state, 'stable');
  tests.push(rec('R', 'sellar-mid-v1', () => 10, day(3)));
  a = VF.analyzeEye('R', tests);
  assert.equal(a.mapId, 'sellar-mid-v1'); assert.equal(a.state, 'baseline'); assert.equal(a.nReliable, 1); assert.equal(a.need, 1); assert.equal(a.otherMap, 3);
  tests.push(rec('R', 'base-v1', flat, day(4)));                            // 예전 지도로 돌아감 → 새 구간
  a = VF.analyzeEye('R', tests);
  assert.equal(a.mapId, 'base-v1'); assert.equal(a.state, 'baseline'); assert.equal(a.nReliable, 1);
  assert.equal(VF.analyzeEye('L', tests).state, 'none');
});
test('귀쪽−코쪽은 좌우 짝으로 계산한다', () => {
  const map = M.mapById('base-v1', 'R');
  const th = map.points.map(p => p.temporal ? 20 : 26);
  const s = VF.stats('R', th, map.points);
  assert.equal(s.tn, -6); assert.equal(s.nPairs, 14);
  const sL = VF.stats('L', M.mapById('base-v1', 'L').points.map(p => p.temporal ? 20 : 26), M.mapById('base-v1', 'L').points);
  assert.equal(sL.tn, -6);
  const tests = [rec('R', 'base-v1', flat, day(0)), rec('R', 'base-v1', flat, day(1)), rec('R', 'base-v1', th, day(2))];
  const f = VF.analyzeEye('R', tests).latest;
  assert.equal(f.dTN, -6); assert.ok(f.reasons.includes('temporal'));
});
test('집중 구역: 평균을 따로 내고, 집중 점 2개 이상이 6점 이상 낮으면 임시 변화 사유(focus)', () => {
  const map = M.mapById('sellar-mid-v1', 'R');
  const zone = map.points.map((p, i) => p.zone ? i : -1).filter(i => i >= 0);
  const drop = k => (p, i) => zone.slice(0, k).includes(i) ? 18 : 24;
  const base = [rec('R', 'sellar-mid-v1', flat, day(0)), rec('R', 'sellar-mid-v1', flat, day(1))];
  const one = VF.analyzeEye('R', [...base, rec('R', 'sellar-mid-v1', drop(1), day(2))]).latest;
  assert.equal(one.nFocusWorse, 1); assert.ok(!one.reasons.includes('focus'));
  const two = VF.analyzeEye('R', [...base, rec('R', 'sellar-mid-v1', drop(2), day(2))]);
  assert.equal(two.latest.nFocusWorse, 2); assert.ok(two.latest.reasons.includes('focus'));
  assert.equal(two.latest.dFocus, -4); assert.equal(two.baseline.focus, 24);
  assert.equal(two.state, 'recheck'); assert.equal(two.pattern, 'temporal');
  const five = VF.analyzeEye('R', [...base, rec('R', 'sellar-mid-v1', (p, i) => zone.slice(0, 2).includes(i) ? 19 : 24, day(2))]).latest;
  assert.ok(!five.reasons.includes('focus'), '5점 하락은 사유가 아님');
  const central = M.mapById('sellar-left-v1', 'L'), cz = central.points.map((p, i) => p.zone ? i : -1).filter(i => i >= 0);
  const c = VF.analyzeEye('L', [rec('L', 'sellar-left-v1', flat, day(0)), rec('L', 'sellar-left-v1', flat, day(1)), rec('L', 'sellar-left-v1', (p, i) => cz.includes(i) ? 17 : 24, day(2))]);
  assert.ok(c.latest.reasons.includes('focus'));
  assert.equal(VF.analyzeEye('R', [rec('R', 'base-v1', flat, day(0)), rec('R', 'base-v1', flat, day(1)), rec('R', 'base-v1', flat, day(2))]).latest.dFocus, null);
  const sum = VF.buildSummary({ tests:[...base, rec('R', 'sellar-mid-v1', drop(2), day(2))], symptoms:[] }).lines.join('\n');
  assert.match(sum, /sellar-mid-v1/); assert.match(sum, /집중 구역/); assert.match(sum, /임시 변화 사유/); assert.match(sum, /앱 점수/);
  assert.doesNotMatch(sum, / dB\b(?! 와)/);
});
test('검사 지도로 실제 검사를 끝까지 돌리면 mapId·점 목록과 같은 길이의 결과가 나온다', () => {
  let a = 7; const rng = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const map = M.buildMap({ eye:'L', loc:'sellar', side:'right' });
  const t = VF.createTest({ eye:'L', map, rng });
  let n = 0; for(let tr = t.next(); tr; tr = t.next()){ t.answer(tr.kind === 'stim' ? tr.db <= 22 : tr.kind === 'fn'); if(++n > 5000) throw new Error('끝나지 않음'); }
  const res = J(t.result());
  assert.equal(res.mapId, 'sellar-right-v1'); assert.equal(res.th.length, 34); assert.ok(M.samePts(res.pts, map));
  assert.equal(res.rel.tr, n);
  assert.throws(() => VF.createTest({ eye:'R', map }));
  assert.equal(VF.createTest({ eye:'R' }).progress().total, 30, '지도를 주지 않으면 예전 30점');
});

/* ── 신뢰도 ────────────────────────────────────────────── */
test('신뢰도: 거짓 양성 기준은 15%, 과다 stray(시행 20회 이상에서 15% 초과)도 신뢰도 낮음', () => {
  const r = o => ({ fp:0, fpN:20, fl:0, flN:10, fn:0, fnN:5, ...o });
  assert.equal(VF.isReliable(r({ fp:3 })), true, '3/20 = 15% 는 통과');
  assert.equal(VF.isReliable(r({ fp:4 })), false, '4/20 = 20% 는 낮음 (예전 기준 20% 에서는 통과했음)');
  assert.equal(VF.isReliable(r({ fp:1, fpN:3 })), true, '시행이 적으면 판단하지 않음');
  assert.equal(VF.isReliable(r({ st:15, tr:100 })), true);
  assert.equal(VF.isReliable(r({ st:16, tr:100 })), false);
  assert.deepEqual(J(VF.relProblems(r({ st:16, tr:100 }))), ['stray']);
  assert.equal(VF.isReliable(r({ st:5, tr:10 })), true, '시행 20회 미만은 stray 판단 안 함');
  assert.equal(VF.isReliable(r({})), true, 'st·tr 없는 예전 기록은 stray 기준을 적용하지 않음');
  assert.deepEqual(J(VF.STIM), { sizeDeg:0.43, durMs:200, windowMs:1100, minRtMs:100 }, '자극 0.43°·0.2초 유지');
});

/* ── 검사 0회·기준선 수집 중 ──────────────────────────────── */
test('검사 0회·기준선 수집 중에는 ‘아직 비교 전입니다 (기준선 측정 중 n/2)’ (stable 로 보이지 않음)', () => {
  const a0 = VF.assess({ tests:[], symptoms:[] });
  assert.equal(a0.pending, true); assert.equal(a0.level, 0); assert.equal(a0.info.key, 'pending');
  assert.equal(a0.info.label, '아직 비교 전입니다 (기준선 측정 중 0/2)');
  assert.notEqual(a0.info.label, VF.LEVEL[0].label);
  const a1 = VF.assess({ tests:[rec('R', 'base-v1', flat, day(0))], symptoms:[] });
  assert.equal(a1.info.label, '아직 비교 전입니다 (기준선 측정 중 1/2)');
  const bad = { fp:9, fpN:10, fl:0, flN:0, fn:0, fnN:0 };
  const a1b = VF.assess({ tests:[rec('R', 'base-v1', flat, day(0)), rec('R', 'base-v1', flat, day(1), bad)], symptoms:[] });
  assert.equal(a1b.info.label, '아직 비교 전입니다 (기준선 측정 중 1/2)', '신뢰도 낮은 검사는 세지 않음');
  const a2 = VF.assess({ tests:[rec('R', 'base-v1', flat, day(0)), rec('R', 'base-v1', flat, day(1))], symptoms:[] });
  assert.equal(a2.pending, false); assert.equal(a2.info.key, 'stable');
  const em = VF.assess({ tests:[], symptoms:[{ date:day(0), ids:['sudden'] }] }, VF.dayNum(day(0)));
  assert.equal(em.pending, false); assert.equal(em.level, 4, '증상 응급은 비교 전이어도 그대로 알림');
  assert.match(VF.buildSummary({ tests:[], symptoms:[] }).lines.join('\n'), /아직 비교 전입니다 \(기준선 측정 중 0\/2\)/);
});

/* ── 가져오기 (legacy-30 호환) ─────────────────────────── */
test('legacy-30: mapId 없는 예전 기록은 예전 30점 순서 그대로 읽고, 다시 내보내면 mapId·점 목록이 붙는다', () => {
  /* 예전 grid(eye) 알고리즘을 그대로 다시 써서 순서가 같은지 확인 */
  const oldGrid = eye => { const s = eye === 'R' ? 1 : -1, out = [];
    for(const x of [-21, -15, -9, -3, 3, 9, 15, 21]) for(const y of [-9, -3, 3, 9]) if(Math.hypot(x - 15 * s, y + 1.5) >= 5) out.push(x + ',' + y);
    return out; };
  for(const eye of ['R', 'L']) assert.deepEqual(J(VF.grid(eye).map(p => p.id)), oldGrid(eye));
  const old = { app:'sirius-vf', v:1, symptoms:[], tests:[{ date:'2026-01-01', eye:'L', th:VF.grid('L').map((p, i) => i % 31), un:[], rel:REL_OK, dist:33 }] };
  const s = VF.cleanState(J(old));
  assert.equal(s.tests[0].mapId, 'legacy-30'); assert.equal(s.tests[0].th.length, 30);
  assert.deepEqual(J(s.tests[0].pts), J(M.ptsOf(M.legacy('L'))));
  const again = VF.cleanState(J(VF.exportable(s)));
  assert.deepEqual(J(again), J(s), '내보내기 → 가져오기 왕복이 같음');
  assert.equal(VF.analyzeEye('L', s.tests).mapId, 'legacy-30');
});
test('가져오기: 모르는 mapId·지도와 다른 점 목록·점 수가 다른 값은 거부한다', () => {
  const good = () => J(VF.exportable({ tests:[rec('R', 'sellar-left-v1', flat, day(0))], symptoms:[], rules:VF.RULES_DEFAULT }));
  assert.equal(VF.cleanState(good()).tests[0].mapId, 'sellar-left-v1');
  const bad = [
    r => { r.tests[0].mapId = 'sellar-up-v9'; }, r => { r.tests[0].mapId = '<img>'; }, r => { r.tests[0].mapId = 3; },
    r => { r.tests[0].pts[0] = [99, 99]; }, r => { r.tests[0].pts.pop(); }, r => { r.tests[0].pts = 'x'; },
    r => { r.tests[0].mapId = 'base-v1'; },                                   // 34개 값을 28점 지도로 위조
    r => { delete r.tests[0].mapId; delete r.tests[0].pts; },               // 34개 값을 legacy-30 으로 위조
    r => { r.tests[0].rel.st = -1; r.tests[0].rel.tr = 10; }, r => { r.tests[0].rel.st = 1; delete r.tests[0].rel.tr; }
  ];
  for(const [i, mut] of bad.entries()){ const raw = good(); mut(raw); assert.throws(() => VF.cleanState(raw), undefined, '#' + i); }
  const st = good(); st.tests[0].rel.st = 30; st.tests[0].rel.tr = 100;
  assert.equal(VF.cleanState(st).tests[0].reliable, false, 'stray 가 많으면 가져올 때도 다시 판정');
});

/* ── 경과 관찰 연동 ────────────────────────────────────── */
test('경과 관찰: 치우친 쪽(side) 입력 — 예전 기록은 unknown, 목록 밖 값은 거부', () => {
  assert.equal(FU.clean({ v:1, loc:'sellar' }).side, 'unknown');
  assert.equal(FU.clean({ v:1, loc:'sellar', side:'left' }).side, 'left');
  assert.equal(FU.clean({ v:1, side:'<b>' }).side, 'unknown');
  assert.deepEqual(J(FU.SIDES.map(s => s.id)), ['mid', 'left', 'right', 'unknown']);
  assert.match(FU.SIDES.map(s => s.ko).join(' '), /Rt\..*|Lt\./); assert.match(FU.SIDES.find(s => s.id === 'mid').ko, /midline/);
  const r = FU.setSide(FU.empty(), 'right'); assert.equal(r.ok, true); assert.equal(r.state.side, 'right');
  assert.equal(FU.setSide(FU.empty(), 'up').ok, false);
});
test('경과 관찰: 안장결절은 정밀 시야검사를 먼저 권하고 간단 시야(vf4)는 빠른 확인용으로 남긴다', () => {
  const c = FU.setupFor('sellar');
  assert.equal(c.precise, true); assert.ok(c.core.includes('vf4'));
  for(const loc of ['cavernous', 'olfactory', 'parasagittal', 'convexity', 'cpa', 'unknown']) assert.equal(FU.setupFor(loc).precise, false);
});
test('경과 관찰: 정밀 시야 요약(평균·귀쪽−코쪽·집중 구역 변화·mapId)이 진료 요약과 MRI 그래프에 들어간다', () => {
  const map = M.mapById('sellar-mid-v1', 'R'), zone = map.points.map((p, i) => p.zone ? i : -1).filter(i => i >= 0);
  const tests = [rec('R', 'sellar-mid-v1', flat, '2026-01-05'), rec('R', 'sellar-mid-v1', flat, '2026-02-05'), rec('R', 'sellar-mid-v1', (p, i) => zone.includes(i) ? 16 : 24, '2026-03-05')];
  const vf = J(VF.digest({ tests }));
  let st = FU.addMri(FU.empty(), '2026-01-01', 18, '2026-11-01').state;
  st = FU.addMri(st, '2026-03-01', 19, '2026-11-01').state;
  const sum = FU.summary(st, '2026-11-01', { vf });
  assert.equal(sum.vf.length, 1);
  const line = sum.vfLines[0];
  assert.match(line, /sellar-mid-v1/); assert.match(line, /평균 [+−-]/); assert.match(line, /귀쪽−코쪽 변화/); assert.match(line, /집중 구역 변화 -8/);
  assert.match(line, /집중 구역 점 하락\(임시 기준\)/);
  const g = FU.graph(st, { vf });
  assert.deepEqual(J(g.panels.map(p => p.id)), ['mri', 'vfx']);
  const vfx = g.panels.find(p => p.id === 'vfx');
  assert.deepEqual(J(vfx.ticks), [0, 10, 20, 30]); assert.match(vfx.series[0].label, /sellar-mid-v1/);
  assert.deepEqual(J(g.dates), ['2026-01-01', '2026-01-05', '2026-02-05', '2026-03-01', '2026-03-05'], 'MRI 와 같은 날짜 축');
  /* 외부에서 들어온 값은 숫자·날짜·고정 코드로만 다시 만든다 */
  const evil = FU.cleanVf([{ eye:'R', mapId:'<img src=x>', pts:[] }, { eye:'L', mapId:'base-v1', zone:'<b>', state:'<i>', pts:[{ date:'<x>', v:1 }, { date:'2026-01-01', v:'9' }], latest:{ date:'2026-01-01', reasons:['<script>', 'focus'] } }]);
  assert.equal(evil.length, 1); assert.equal(evil[0].state, 'none'); assert.equal(evil[0].zoneKo, ''); assert.deepEqual(J(evil[0].pts), []);
  assert.deepEqual(J(evil[0].latest.reasons), ['focus']);
  assert.deepEqual(J(FU.graph(st).panels.map(p => p.id)), ['mri'], '시야 기록이 없으면 패널도 없음');
});
