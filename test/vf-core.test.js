import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* 합성 데이터만 사용합니다. 실제 환자 정보·영상·기록은 쓰지 않습니다. */
const ctx = vm.createContext({});
for(const f of ['vf-map.js', 'vf-core.js']) vm.runInContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), ctx);
const VF = vm.runInContext('VF', ctx);
const J = v => JSON.parse(JSON.stringify(v));

function rngOf(seed){            // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/* 가상 환자: 점마다 진짜 역치가 있고, 확률적으로 대답한다 */
function observer(eye, trueOf, o = {}){
  const rnd = rngOf(o.seed || 7), { guess = 0.02, lapse = 0.02, noise = 1.2, fixLoss = 0.0 } = o;
  const g = VF.grid(eye);
  return trial => {
    if(trial.kind === 'fp') return rnd() < (o.fpRate ?? guess);
    if(trial.kind === 'blind') return rnd() < fixLoss;
    const i = g.findIndex(p => p.x === trial.x && p.y === trial.y);
    const thr = trueOf(g[i], i);
    const p = guess + (1 - guess - lapse) / (1 + Math.exp(-(thr - trial.db) / (noise / 1.7)));
    return rnd() < p;
  };
}
function runTest(eye, answer, seed = 3, cap = 3000){
  const t = VF.createTest({ eye, rng: rngOf(seed) });
  let n = 0;
  for(let tr = t.next(); tr; tr = t.next()){ t.answer(answer(tr)); if(++n > cap) throw new Error('끝나지 않음'); }
  assert.ok(t.finished());
  return { res: J(t.result()), trials: n };
}

/* ── 격자·기하·밝기 ──────────────────────────────────────── */
test('격자: 눈마다 30점, 맹점 근처 점 제외, 귀쪽 방향이 눈에 따라 뒤집힌다', () => {
  for(const eye of ['R', 'L']){
    const g = VF.grid(eye), b = VF.blindCenter(eye);
    assert.equal(g.length, 30);
    assert.ok(g.every(p => Math.hypot(p.x - b.x, p.y - b.y) >= 5));
    assert.equal(g.filter(p => p.central).length, 12);
    assert.equal(new Set(g.map(p => p.id)).size, 30);
  }
  const R = VF.grid('R'), L = VF.grid('L');
  assert.equal(R.filter(p => p.temporal).length, 14);
  assert.equal(L.filter(p => p.temporal).length, 14);
  assert.ok(R.find(p => p.x === 21).temporal && !R.find(p => p.x === -21).temporal);
  assert.ok(L.find(p => p.x === -21).temporal && !L.find(p => p.x === 21).temporal);
  assert.equal(VF.blindCenter('R').x, 15);
  assert.equal(VF.blindCenter('L').x, -15);
  assert.throws(() => VF.grid('X'));
});
test('기하: 각도→픽셀 변환과 화면 적합성 점검', () => {
  assert.equal(VF.degToMm(0, 330), 0);
  assert.ok(Math.abs(VF.degToMm(10, 330) + VF.degToMm(-10, 330)) < 1e-9);
  const ppm = VF.pxPerMmFromCard(323.5);
  assert.ok(Math.abs(ppm - 3.779) < 0.01);
  const p = VF.toPx({ x: 21, y: 9 }, 330, ppm, 700, 400);
  assert.ok(p.px > 700 && p.py < 400);                       // 오른쪽·위쪽
  assert.ok(Math.abs(VF.sizePx(0.43, 330, ppm) - 330 * 0.43 * Math.PI / 180 * ppm) < 0.1);
  assert.equal(VF.fitCheck({ w: 1440, h: 800, distMm: 330, ppm }).ok, true);
  const small = VF.fitCheck({ w: 600, h: 400, distMm: 330, ppm });
  assert.equal(small.ok, false);
  assert.ok(small.maxDistMm < 330 && small.maxDistMm > 100);
  assert.equal(VF.fitCheck({ w: 600, h: 400, distMm: small.maxDistMm, ppm }).ok, true);
});
test('밝기: dB가 클수록 배경에 가깝고, 2 dB 간격 모두 서로 다른 회색값이다', () => {
  let prev = 256;
  for(let db = 0; db <= 30; db += 2){
    const lv = VF.dbToLevel(db);
    assert.ok(lv < prev, `db ${db}`); prev = lv;
  }
  assert.ok(VF.dbToLevel(30) > VF.BG_LEVEL + 5);
  assert.equal(VF.dbToLevel(-5), VF.dbToLevel(0));
  assert.equal(VF.dbToLevel(99), VF.dbToLevel(30));
});

/* ── 검사 진행기 ─────────────────────────────────────────── */
test('4-2 계단법: 정상 반응에서 점별 역치를 ±3 dB 안으로 찾고 신뢰할 수 있다', () => {
  const trueOf = (p, i) => 24 + (i % 4);
  const { res, trials } = runTest('R', observer('R', trueOf, { seed: 11 }), 5);
  const err = res.th.map((v, i) => Math.abs(v - trueOf(null, i)));
  assert.ok(err.reduce((a, b) => a + b, 0) / err.length <= 2.5, '평균 오차 ' + err);
  assert.ok(err.filter(e => e > 6).length <= 2);
  assert.ok(trials >= 100 && trials <= 400, '시행 ' + trials);
  assert.ok(res.rel.fpN > 0 && res.rel.flN > 0);
  assert.equal(VF.isReliable(res.rel), true);
  assert.ok(res.th.every(v => Number.isInteger(v) && v >= 0 && v <= 30));
});
test('4-2 계단법: 가상 중심 시야 결손을 낮은 역치로 구분한다', () => {
  const g = VF.grid('L');
  const trueOf = p => p.central ? 8 : 26;
  const { res } = runTest('L', observer('L', trueOf, { seed: 5 }), 9);
  const c = res.th.filter((v, i) => g[i].central), o = res.th.filter((v, i) => !g[i].central);
  assert.ok(c.reduce((a, b) => a + b, 0) / c.length < 13);
  assert.ok(o.reduce((a, b) => a + b, 0) / o.length > 21);
});
test('전혀 못 보는 점은 0 dB·미응답으로 끝나고 검사는 끝난다', () => {
  const { res } = runTest('R', observer('R', () => -10, { seed: 1, guess: 0, lapse: 0 }), 2);
  assert.ok(res.th.every(v => v === 0));
  assert.equal(res.un.length, 30);
});
test('눌러 대는 사람은 거짓 양성으로 신뢰할 수 없음이 표시된다', () => {
  const { res } = runTest('R', () => true, 4);
  assert.ok(res.rel.fpN >= 4 && res.rel.fp === res.rel.fpN);
  assert.equal(VF.isReliable(res.rel), false);
});
test('시선이 자꾸 벗어나면(맹점 자극에 반응) 고정 손실로 신뢰할 수 없음이 표시된다', () => {
  const { res } = runTest('R', observer('R', () => 25, { seed: 8, fixLoss: 0.9 }), 6);
  assert.ok(res.rel.flN >= 4 && res.rel.fl / res.rel.flN > 0.5);
  assert.equal(VF.isReliable(res.rel), false);
});
test('시행 수가 적을 때는 우연으로 신뢰도 낮음 처리하지 않는다', () => {
  assert.equal(VF.isReliable({ fp: 1, fpN: 2, fl: 0, flN: 0, fn: 0, fnN: 0 }), true);
  assert.equal(VF.isReliable({ fp: 3, fpN: 10, fl: 0, flN: 0, fn: 0, fnN: 0 }), false);
});

/* ── 변화 분석 ───────────────────────────────────────────── */
function mk(eye, date, f, { noise = 0, seed = 1, reliable = true } = {}){
  const g = VF.grid(eye), rnd = rngOf(seed);
  const th = g.map((p, i) => Math.max(0, Math.min(30, Math.round(f(p, i) + (rnd() - .5) * 2 * noise))));
  return { date, eye, th, un: [], rel: { fp: reliable ? 0 : 5, fpN: 10, fl: 0, flN: 10, fn: 0, fnN: 5 }, reliable, dist: 33 };
}
const FLAT = () => 28;
const week = n => new Date(Date.UTC(2026, 0, 5 + 7 * n)).toISOString().slice(0, 10);
const series = (eye, fs, opt = {}) => fs.map((f, i) => mk(eye, week(i), f, { noise: 1, seed: 100 + i + (eye === 'L' ? 50 : 0), ...opt }));
const drop = (d, pred) => (p, i) => 28 - (pred(p) ? d : 0);

test('분석: 기준선 2회가 없으면 판정하지 않고 몇 번 더 필요한지 알려준다', () => {
  const a = VF.analyzeEye('R', series('R', [FLAT]));
  assert.equal(a.state, 'baseline'); assert.equal(a.need, 1);
  const b = VF.analyzeEye('R', [mk('R', week(0), FLAT), mk('R', week(1), FLAT, { reliable: false }), mk('R', week(2), FLAT)]);
  assert.equal(b.nReliable, 2); assert.equal(b.excluded, 1); assert.equal(b.state, 'tracking');
  assert.equal(VF.analyzeEye('L', []).state, 'none');
});
test('분석: 변화 없는 추적은 안정(0단계)이고 잡음만으로 경고하지 않는다', () => {
  for(let s = 0; s < 20; s++){
    const tests = [0, 1, 2, 3, 4, 5].map(i => mk('R', week(i), FLAT, { noise: 2, seed: 500 + s * 10 + i }));
    const a = VF.analyzeEye('R', tests);
    assert.equal(a.level, 0, `seed ${s}: ${JSON.stringify(a.follow.map(f => f.reasons))}`);
  }
});
test('분석: 중심 좁은 결손이 한 번이면 재검(1단계), 연속이면 연락(2단계)', () => {
  const small = drop(8, p => Math.abs(p.x) <= 3 && Math.abs(p.y) <= 3);     // 중심 4점
  const one = VF.analyzeEye('R', series('R', [FLAT, FLAT, FLAT, small]));
  assert.equal(one.state, 'recheck'); assert.equal(one.level, 1); assert.equal(one.pattern, 'central');
  assert.ok(one.latest.cluster >= 3 && one.latest.severe === false);
  const two = VF.analyzeEye('R', series('R', [FLAT, FLAT, FLAT, small, small]));
  assert.equal(two.state, 'confirmed'); assert.equal(two.level, 2);
  const back = VF.analyzeEye('R', series('R', [FLAT, FLAT, FLAT, small, FLAT]));
  assert.equal(back.state, 'stable'); assert.equal(back.level, 0);
});
test('분석: 중심 전체가 크게 떨어지면 한 번이어도 2단계(재검 기다리지 않고 연락)', () => {
  const wide = drop(8, p => p.central);
  const a = VF.analyzeEye('R', series('R', [FLAT, FLAT, FLAT, wide]));
  assert.equal(a.state, 'recheck'); assert.equal(a.level, 2); assert.equal(a.latest.severe, true); assert.equal(a.pattern, 'central');
});
test('분석: 같은 날 여러 번 검사해도 나빠진 검사를 순서로 구분한다 (날짜가 같아도 기준선 검사가 변화로 표시되지 않음)', () => {
  const central = drop(8, p => Math.abs(p.x) <= 3 && Math.abs(p.y) <= 3);
  const sameDay = [FLAT, FLAT, FLAT, central, central].map((f, i) => mk('R', '2026-03-03', f, { noise: 1, seed: 700 + i }));
  const a = VF.analyzeEye('R', sameDay);
  assert.deepEqual(a.follow.map(f => f.pos), [2, 3, 4]);
  assert.deepEqual(a.follow.map(f => f.worse), [false, true, true]);
});
test('분석: 큰 중심 시야 저하가 반복되면 오늘 연락(3단계)', () => {
  const big = drop(14, p => p.central);
  const a = VF.analyzeEye('L', series('L', [FLAT, FLAT, big, big]));
  assert.equal(a.state, 'confirmed'); assert.equal(a.level, 3);
  assert.equal(VF.analyzeEye('L', series('L', [FLAT, FLAT, big])).level, 2);
});
test('분석: 양쪽 눈 귀쪽 저하는 수직 중앙선 비대칭(양측 귀쪽 패턴)으로 묶어 본다', () => {
  const tmp = drop(7, p => p.temporal);
  const tests = [...series('R', [FLAT, FLAT, tmp, tmp]), ...series('L', [FLAT, FLAT, tmp, tmp])];
  const a = VF.assess({ tests, symptoms: [], rules: VF.RULES_DEFAULT });
  assert.equal(a.R.pattern, 'temporal'); assert.equal(a.L.pattern, 'temporal');
  assert.equal(a.bitemporal, true); assert.ok(a.level >= 2);
  const oneEye = VF.assess({ tests: [...series('R', [FLAT, FLAT, tmp, tmp]), ...series('L', [FLAT, FLAT, FLAT, FLAT])], symptoms: [], rules: VF.RULES_DEFAULT });
  assert.equal(oneEye.bitemporal, false);
});
test('분석: 이미 거의 안 보이는 점(기준선 6 dB 미만)은 더 나빠졌다고 세지 않는다', () => {
  const floor = (p, i) => i < 6 ? 3 : 28;
  const bad = (p, i) => i < 6 ? 0 : 28;
  const a = VF.analyzeEye('R', series('R', [floor, floor, bad]));
  assert.equal(a.latest.nWorse, 0);
});
test('분석: 신뢰도 낮은 검사는 기준선·판정에서 빠지고 목록에는 남는다', () => {
  const t = [mk('R', week(0), FLAT, { noise: 1, seed: 1 }), mk('R', week(1), FLAT, { noise: 1, seed: 2 }),
             mk('R', week(2), drop(10, p => p.central), { reliable: false }), mk('R', week(3), FLAT, { noise: 1, seed: 4 })];
  const a = VF.analyzeEye('R', t);
  assert.equal(a.level, 0); assert.equal(a.excluded, 1); assert.equal(a.follow.length, 1);
});
test('분석: 5회 이상이면 월별 추세를 계산하고 서서히 떨어지는 것을 알려 준다', () => {
  const slow = i => () => 28 - i * 0.6;       // 주 0.6 dB ≈ 월 2.6 dB 하락
  const dec = VF.analyzeEye('R', [0, 1, 2, 3, 4, 5].map(i => mk('R', week(i), slow(i), { noise: 0.5, seed: 30 + i })));
  assert.equal(dec.trend.declining, true); assert.ok(dec.trend.msPerMonth < -1);
  const flat = VF.analyzeEye('R', [0, 1, 2, 3, 4, 5].map(i => mk('R', week(i), FLAT, { noise: 1, seed: 40 + i })));
  assert.equal(flat.trend.declining, false);
  assert.equal(VF.analyzeEye('R', series('R', [FLAT, FLAT, FLAT])).trend, null);
});
test('증상: 응급 항목은 4단계, 긴급 항목은 3단계이고 14일 지난 응답은 쓰지 않는다', () => {
  const base = { tests: [], rules: VF.RULES_DEFAULT };
  const day = VF.dayNum('2026-03-10');
  assert.equal(VF.assess({ ...base, symptoms: [{ date: '2026-03-09', ids: ['sudden'] }] }, day).level, 4);
  assert.equal(VF.assess({ ...base, symptoms: [{ date: '2026-03-09', ids: ['diplopia'] }] }, day).level, 3);
  assert.equal(VF.assess({ ...base, symptoms: [{ date: '2026-02-01', ids: ['sudden'] }] }, day).level, 0);
  assert.equal(VF.assess({ ...base, symptoms: [{ date: '2026-03-09', ids: ['없는항목'] }] }, day).level, 0);
  assert.equal(VF.LEVEL[4].key, 'emergency');
  assert.match(VF.LEVEL[4].action, /119/);
});
test('기준값은 범위 안으로만 조정된다', () => {
  const r = J(VF.sanitizeRules({ pointDrop: 999, clusterMin: -4, centralDrop: 'x', evil: 1 }));
  assert.equal(r.pointDrop, 15); assert.equal(r.clusterMin, 2); assert.equal(r.centralDrop, 3);
  assert.equal(Object.keys(r).length, 8);                // focusDrop·focusMin(집중 구역 임시 기준) 포함
  assert.equal(r.focusDrop, 6); assert.equal(r.focusMin, 2);
});

/* ── 가져오기 검증 ───────────────────────────────────────── */
const goodRaw = () => J(VF.exportable({ tests: series('R', [FLAT, FLAT]), symptoms: [{ date: week(1), ids: ['blur'] }], rules: VF.RULES_DEFAULT }));
test('가져오기: 정상 파일은 통과하고 신뢰도는 다시 계산한다', () => {
  const raw = goodRaw();
  raw.tests[0].rel = { fp: 9, fpN: 10, fl: 0, flN: 0, fn: 0, fnN: 0 };
  raw.tests[0].reliable = true;                       // 위조해도 무시
  const s = J(VF.cleanState(raw));
  assert.equal(s.tests.length, 2); assert.equal(s.tests[0].reliable, false); assert.equal(s.tests[1].reliable, true);
});
test('가져오기: 형식이 틀리거나 범위를 벗어난 값은 거부한다', () => {
  const bad = [
    r => { r.app = 'other'; }, r => { r.v = 2; }, r => { r.tests = 'x'; },
    r => { r.tests[0].eye = 'X'; }, r => { r.tests[0].date = '2026-13-40'; }, r => { r.tests[0].date = '<img src=x>'; },
    r => { r.tests[0].th.pop(); }, r => { r.tests[0].th[0] = 31; }, r => { r.tests[0].th[0] = 1.5; }, r => { r.tests[0].th[0] = '20'; },
    r => { r.tests[0].un = [99]; }, r => { r.tests[0].rel.fp = -1; }, r => { r.tests[0].rel = null; },
    r => { r.tests = Array.from({ length: 401 }, () => r.tests[0]); }, r => { r.symptoms = [{ date: 'x', ids: [] }]; }
  ];
  for(const [i, mut] of bad.entries()){
    const raw = goodRaw(); mut(raw);
    assert.throws(() => VF.cleanState(raw), undefined, '거부되어야 함 #' + i);
  }
  assert.throws(() => VF.cleanState(null)); assert.throws(() => VF.cleanState('x'));
});
test('가져오기: 알 수 없는 필드와 증상 코드는 버리고 허용된 값만 남긴다', () => {
  const raw = goodRaw();
  raw.tests[0].name = '<script>alert(1)</script>'; raw.extra = { a: 1 };
  raw.tests[0].th = JSON.parse(JSON.stringify(raw.tests[0].th));
  raw.symptoms[0].ids.push('<b>', 'sudden'); raw.symptoms[0].note = 'x';
  const poisoned = JSON.parse('{"__proto__":{"polluted":1},"app":"sirius-vf","v":1,"tests":[],"symptoms":[]}');
  VF.cleanState(poisoned);
  const s = J(VF.cleanState(raw));
  assert.ok(!JSON.stringify(s).includes('script'));
  assert.deepEqual(s.symptoms[0].ids, ['blur', 'sudden']);
  assert.equal(s.tests[0].name, undefined);
  assert.equal({}.polluted, undefined);
});

/* ── 진료용 요약 ─────────────────────────────────────────── */
test('요약: 기록이 없어도 만들어지고, 문장에 HTML 문자가 들어가지 않는다', () => {
  const s = VF.buildSummary({ tests: [], symptoms: [], rules: VF.RULES_DEFAULT });
  assert.match(s.lines[0], /진단이 아닙니다/);
  assert.ok(s.lines.join('\n').indexOf('<') < 0 && s.questions.join('').indexOf('<') < 0);
  assert.ok(s.questions.length >= 4);
});
test('요약: 중심·귀쪽 변화에 맞는 질문이 붙고 한계를 항상 적는다', () => {
  const tests = [...series('R', [FLAT, FLAT, drop(8, p => p.central), drop(8, p => p.central)]),
                 ...series('L', [FLAT, FLAT, drop(7, p => p.temporal), drop(7, p => p.temporal)])];
  const s = VF.buildSummary({ tests, symptoms: [], rules: VF.RULES_DEFAULT });
  const text = s.lines.join('\n');
  assert.match(text, /오른쪽 눈/); assert.match(text, /왼쪽 눈/); assert.match(text, /한계:/); assert.match(text, /시험용/);
  assert.ok(s.questions.some(q => /중심 시야/.test(q)));
  assert.ok(s.questions.some(q => /바깥쪽 시야/.test(q)));
  assert.ok(!/진단합니다|종양이 (커|자라)/.test(text));
});
