import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/followup-core.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ Math, Date });
vm.runInContext(SRC + ';globalThis.FU = FU;', ctx);
const FU = ctx.FU;
const TODAY = '2026-11-10';
const J = x => JSON.parse(JSON.stringify(x));
const same = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const ok = r => { assert.equal(r.ok, true, r.error); return r.state; };
const tap = (date, l, r, cl = 10, cr = 10) => ({ type:'tap', date, L:{ n:l, cv:cl }, R:{ n:r, cv:cr } });
const vf = (date, eye, u, d, l, r, pressed = 0) => ({ type:'vf4', date, eye, seen:{ u, d, l, r }, catch:{ shown:2, pressed } });
const add = (s, rec) => ok(FU.addCheck(s, rec, TODAY));

test('종양 위치는 6개 + 모름이고 위치마다 체크 구성이 다르다', () => {
  assert.equal(FU.LOCS.length, 7);
  assert.equal(FU.LOCS.filter(l => l.id !== 'unknown').length, 6);
  const cores = new Set(FU.LOCS.map(l => FU.setupFor(l.id).core.join()));
  assert.ok(cores.size >= 5, '위치별 구성이 거의 같음');
  assert.equal(FU.setupFor('sellar').core[0], 'vf4');
  same(FU.setupFor('cpa').core.slice(0, 1), ['hear']);
  assert.ok(FU.setupFor('olfactory').core.includes('smell') && FU.setupFor('olfactory').core.includes('care'));
  assert.ok(FU.setupFor('parasagittal').core.includes('tap'));
  same(FU.setupFor('없는위치').loc, 'unknown');
  for(const l of FU.LOCS){
    const c = FU.setupFor(l.id);
    same([...c.core, ...c.extra].sort(), [...FU.TYPES].sort());
    assert.equal(c.sym.filter(i => i.em).length, 5, '응급 증상 5개는 모든 위치에 항상 포함');
  }
});

test('clean: 잘못된 입력은 빈 상태, 잘못된 항목은 버리고, 알 수 없는 키·프로토타입 오염은 무시', () => {
  for(const bad of [null, undefined, 3, 'x', [], {}, { v:2 }, { v:1, loc:5 }]) same(FU.clean(bad), FU.empty());
  const raw = JSON.parse('{"v":1,"loc":"<img src=x onerror=1>","next":"2026-02-30","mri":[{"date":"2026-01-01","size":"12,5"},{"date":"2026-01-01","size":9},{"date":"x","size":3},{"date":"2026-02-01","size":0}],'
    + '"checks":[{"type":"tap","date":"2026-01-02","id":7,"L":{"n":10,"cv":5},"R":{"n":11,"cv":null},"__proto__":{"polluted":1},"extra":"x"},'
    + '{"type":"tap","date":"2026-01-03","id":7,"L":{"n":10},"R":{"n":300}},{"type":"nope","date":"2026-01-02"},{"type":"tap","date":"2026-01-02","L":{"n":-1},"R":{"n":1}}],'
    + '"meds":{"hormone":"banana"},"__proto__":{"x":1}}');
  const s = FU.clean(raw);
  assert.equal(s.loc, 'unknown'); assert.equal(s.next, null);
  same(s.mri, [{ date:'2026-01-01', size:12.5 }]);
  assert.equal(s.checks.length, 2);
  assert.equal(new Set(s.checks.map(c => c.id)).size, 2, 'id 는 중복되지 않는다');
  assert.equal(Object.keys(s.checks[0]).sort().join(), 'L,R,date,id,type');
  assert.equal(({}).polluted, undefined);
  assert.equal(s.meds.hormone, 'unknown');
  same(FU.clean(JSON.parse(JSON.stringify(s))), s, '직렬화 왕복에도 같다');
});

test('MRI 크기·촬영일 검증: 범위, 형식, 미래 날짜, 같은 날 덮어쓰기, 개수 한도', () => {
  const e = FU.empty();
  for(const sz of [0, -3, 151, NaN, 'abc', '', null, '1e3', '12.345', {}]) assert.equal(FU.addMri(e, '2026-01-01', sz, TODAY).ok, false, String(sz));
  for(const d of ['2026-13-01', '2026-02-30', '20260101', '', null, '2026-1-1', '1999-01-01']) assert.equal(FU.addMri(e, d, 10, TODAY).ok, false, String(d));
  assert.equal(FU.addMri(e, '2026-11-11', 10, TODAY).ok, false, '미래 촬영일은 거절');
  let s = ok(FU.addMri(e, '2026-01-01', '18,5', TODAY));
  assert.equal(s.mri[0].size, 18.5);
  const r = FU.addMri(s, '2026-01-01', 20, TODAY); assert.equal(r.replaced, true); assert.equal(r.state.mri.length, 1); assert.equal(r.state.mri[0].size, 20);
  s = ok(FU.addMri(s, '2025-06-01', 17, TODAY)); same(s.mri.map(m => m.date), ['2025-06-01', '2026-01-01'], '날짜순');
  let big = FU.empty();
  for(let i = 0; i < FU.MAX_MRI; i++) big = ok(FU.addMri(big, `2020-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, 10, TODAY));
  assert.equal(FU.addMri(big, '2024-01-01', 10, TODAY).ok, false);
  assert.equal(FU.setNext(e, '2026-99-99').ok, false);
  assert.equal(ok(FU.setNext(e, '2027-03-01')).next, '2027-03-01');
  assert.equal(ok(FU.setNext(ok(FU.setNext(e, '2027-03-01')), '')).next, null);
});

test('체크 기록 검증: 형식·범위·미래 날짜·알 수 없는 항목 거절, 추가 필드 제거', () => {
  const e = FU.empty();
  const bad = [
    tap('2026-11-11', 10, 10), tap('2026-01-01', -1, 10), tap('2026-01-01', 10, 301), tap('2026-01-01', 1.5, 10),
    { type:'vf4', date:'2026-01-01', eye:'X', seen:{ u:0, d:0, l:0, r:0 }, catch:{ shown:2, pressed:0 } },
    vf('2026-01-01', 'R', 4, 0, 0, 0), { ...vf('2026-01-01', 'R', 1, 1, 1, 1), catch:{ shown:2, pressed:3 } },
    { type:'sym', date:'2026-01-01', items:['없는항목'] }, { type:'sym', date:'2026-01-01', items:'em1' },
    { type:'smell', date:'2026-01-01', L:3, R:1 }, { type:'hear', date:'2026-01-01', L:1 }, { type:'care', date:'2026-01-01', items:['em1'] },
    { type:'other', date:'2026-01-01' }, null, 'x', [],
  ];
  for(const b of bad) assert.equal(FU.addCheck(e, b, TODAY).ok, false, JSON.stringify(b));
  const s = add(e, { ...tap('2026-01-01', 10, 12), hack:'<script>', id:99 });
  assert.equal(s.checks[0].hack, undefined); assert.equal(s.checks[0].id, 1);
  const s2 = add(s, { type:'sym', date:'2026-01-02', items:['em1', 'em1', 'vis1'] });
  same(s2.checks[1].items, ['em1', 'vis1']);
  assert.equal(FU.removeCheck(s2, 999).ok, false);
  assert.equal(FU.removeCheck(s2, 1).state.checks.length, 1);
  let big = FU.empty();
  for(let i = 0; i < FU.MAX_CHECKS; i++) big = add(big, tap('2026-01-01', 5, 5));
  assert.equal(FU.addCheck(big, tap('2026-01-01', 5, 5), TODAY).ok, false);
});

test('손가락 두드리기 측정: 10초 밖·잘못된 값 제외, 30ms 중복 제거, 6번 미만이면 리듬 없음', () => {
  same({ ...FU.tapMetrics([]) }, { n:0, cv:null });
  same({ ...FU.tapMetrics('x') }, { n:0, cv:null });
  assert.equal(FU.tapMetrics([0, 100, 200, 300, 400]).cv, null);
  const reg = FU.tapMetrics([0, 200, 400, 600, 800, 1000, 1200]);
  assert.equal(reg.n, 7); assert.equal(reg.cv, 0);
  assert.equal(FU.tapMetrics([100, 110, 120, 500, NaN, -5, 10001, 'a', null, Infinity]).n, 2, '30ms 안 중복·범위 밖·비숫자 제외');
  const irr = FU.tapMetrics([0, 100, 500, 560, 1100, 1180, 2000]);
  assert.ok(irr.cv > 30);
  assert.equal(FU.tapMetrics(Array.from({ length: 1000 }, (_, i) => i * 10)).n, 300, '한도');
  assert.equal(FU.tapLR({ L:{ n:50 }, R:{ n:40 } }), 20);
  assert.equal(FU.tapLR({ L:{ n:0 }, R:{ n:0 } }), null);
});

test('간단 시야 계획·점수: 4방향×3번 + 확인용 2번, 눌림 집계', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const plan = FU.vfPlan(rnd);
  assert.equal(plan.length, 14);
  for(const d of ['u', 'd', 'l', 'r']) assert.equal(plan.filter(p => p.dir === d).length, 3);
  assert.equal(plan.filter(p => p.dir === null).length, 2);
  assert.ok(plan.every(p => p.wait >= 1200 && p.wait < 2800));
  assert.notDeepEqual(plan.map(p => p.dir), FU.vfPlan(() => 0.999).map(p => p.dir), '섞인다');
  const res = plan.map(p => ({ dir:p.dir, pressed:p.dir === 'u' || p.dir === null }));
  const sc = FU.vfScore(res);
  same({ ...sc.seen }, { u:3, d:0, l:0, r:0 }); same({ ...sc.catch }, { shown:2, pressed:2 });
  assert.equal(FU.vfReliable({ catch:{ shown:2, pressed:2 } }), false);
  assert.equal(FU.vfReliable({ catch:{ shown:2, pressed:1 } }), true);
  same({ ...FU.vfScore(null).seen }, { u:0, d:0, l:0, r:0 });
});

test('기준점 비교: 첫 측정이 기준점, 이후 비슷함/변화 있음만 말하고 이유를 숫자로 보여 준다', () => {
  let s = FU.empty();
  assert.equal(FU.compare(s, 'tap').state, 'none');
  s = add(s, tap('2026-01-01', 50, 52));
  assert.equal(FU.compare(s, 'tap').state, 'baseline');
  s = add(s, tap('2026-02-01', 48, 53));
  const c = FU.compare(s, 'tap'); assert.equal(c.state, 'same'); same([...c.reasons], []);
  s = add(s, tap('2026-03-01', 35, 52));
  const c2 = FU.compare(s, 'tap');
  assert.equal(c2.state, 'changed'); assert.equal(c2.streak, 1); assert.equal(c2.repeated, false);
  assert.match(c2.reasons[0], /왼손 두드린 횟수 50회 → 35회/); assert.ok(c2.reasons.some(r => /좌우 차이/.test(r)));
  s = add(s, tap('2026-04-01', 34, 52));
  assert.equal(FU.compare(s, 'tap').repeated, true, '변화가 이어짐');
  s = add(s, tap('2026-05-01', 50, 52));
  assert.equal(FU.compare(s, 'tap').streak, 0, '기준점 가까이 돌아오면 이어짐이 끊김');
  assert.equal(FU.compare(s, 'tap').state, 'same');
});

test('간단 시야는 눈별로 따로 비교하고, 확인용 응답이 많은 검사는 기준점·비교에서 제외한다', () => {
  let s = FU.empty();
  s = add(s, vf('2026-01-01', 'R', 3, 3, 3, 3, 2));            // 신뢰 낮음 → 기준점 아님
  assert.equal(FU.compare(s, 'vf4', 'R').state, 'none');
  s = add(s, vf('2026-01-02', 'R', 3, 3, 3, 3));
  s = add(s, vf('2026-01-03', 'L', 3, 2, 3, 3));
  assert.equal(FU.compare(s, 'vf4', 'R').state, 'baseline'); assert.equal(FU.compare(s, 'vf4', 'R').base.date, '2026-01-02');
  assert.equal(FU.compare(s, 'vf4', 'L').state, 'baseline');
  s = add(s, vf('2026-02-01', 'R', 3, 3, 1, 3));
  const r = FU.compare(s, 'vf4', 'R'); assert.equal(r.state, 'changed'); assert.match(r.reasons[0], /왼쪽 방향 3\/3 → 1\/3/);
  s = add(s, vf('2026-02-02', 'L', 3, 3, 3, 3));
  assert.equal(FU.compare(s, 'vf4', 'L').state, 'same', '한 방향 1 차이는 변화 아님');
  const all = FU.allCompare(s); same(all.map(x => x.type + (x.eye || '')), ['vf4R', 'vf4L']);
});

test('증상·보호자·후각·청력도 기준점과 비교한다 (새로 체크한 항목 / 단계 차이)', () => {
  let s = FU.empty();
  s = add(s, { type:'sym', date:'2026-01-01', items:['vis1'] });
  s = add(s, { type:'sym', date:'2026-02-01', items:['vis1'] });
  assert.equal(FU.compare(s, 'sym').state, 'same');
  s = add(s, { type:'sym', date:'2026-03-01', items:['vis1', 'dip'] });
  assert.match(FU.compare(s, 'sym').reasons[0], /새로 체크함: 물체가 겹쳐 보임/);
  s = add(s, { type:'smell', date:'2026-01-01', L:2, R:2 }); s = add(s, { type:'smell', date:'2026-02-01', L:2, R:1 });
  assert.match(FU.compare(s, 'smell').reasons[0], /오른쪽 뚜렷하게 맡음 → 약하게 맡음/);
  s = add(s, { type:'hear', date:'2026-01-01', L:2, R:2 }); s = add(s, { type:'hear', date:'2026-02-01', L:2, R:2 });
  assert.equal(FU.compare(s, 'hear').state, 'same');
  s = add(s, { type:'care', date:'2026-01-01', items:[] }); s = add(s, { type:'care', date:'2026-02-01', items:['seiz'] });
  assert.equal(FU.compare(s, 'care').state, 'changed');
});

test('그래프: 단위가 다른 값은 패널·눈금을 나누고, 기록한 날짜에만 점이 있으며 사이값을 만들지 않는다', () => {
  let s = FU.empty();
  s = ok(FU.addMri(s, '2025-01-01', 18, TODAY)); s = ok(FU.addMri(s, '2026-01-01', 18.5, TODAY));
  s = add(s, tap('2025-06-01', 50, 52)); s = add(s, tap('2026-03-01', 45, 50));
  s = add(s, vf('2025-06-02', 'R', 3, 3, 3, 3)); s = add(s, { ...vf('2026-03-02', 'R', 3, 2, 3, 3, 2) });
  const g = FU.graph(s);
  same(g.panels.map(p => p.unit), ['mm', '/12', '회']);
  same([...g.panels[2].ticks].every(t => t >= 0), true);
  same([...g.panels[1].ticks], [0, 3, 6, 9, 12]);
  assert.equal(g.panels[0].series[0].pts.length, 2);
  assert.equal(g.panels[1].series[0].pts.length, 2);
  assert.equal(g.panels[1].series[0].pts[1].unreliable, true);
  assert.equal(g.panels[2].series.length, 2);
  same([...g.dates], ['2025-01-01', '2025-06-01', '2025-06-02', '2026-01-01', '2026-03-01', '2026-03-02']);
  assert.equal(g.maxDay - g.minDay, FU.dayNum('2026-03-02') - FU.dayNum('2025-01-01'));
  for(const p of g.panels) for(const se of p.series) for(const q of se.pts) assert.ok(g.dates.includes(q.date));
  same(FU.graph(FU.empty()).panels, []);
  const t = FU.niceTicks(17.2, 18.9); assert.ok(t[0] <= 17.2 && t[t.length - 1] >= 18.9);
});

test('엇갈림 안내: 체크의 기준점·최근 날짜가 최근 두 MRI 날짜와 같을 때만 하고, 다르면 판단 불가라고만 한다', () => {
  const mri = (s, d, v) => ok(FU.addMri(s, d, v, TODAY));
  // ① 날짜가 모두 맞고 MRI는 늘지 않았는데 체크가 달라짐 → 엇갈림
  let s = mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 18);
  s = add(s, tap('2025-01-01', 50, 52)); s = add(s, tap('2026-01-01', 30, 52));
  let c = FU.crossing(s); assert.equal(c.cross, true); assert.equal(c.kind, 'mri-flat');
  assert.match(c.text, /2025-01-01 18 mm → 2026-01-01 18 mm/); assert.doesNotMatch(c.text, /정상|이상|악화|호전|진단|추정/);
  // ② 날짜가 맞고 MRI가 늘었는데 체크는 비슷함 → 엇갈림
  let g = mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 21);
  g = add(g, tap('2025-01-01', 50, 52)); g = add(g, tap('2026-01-01', 50, 52));
  assert.equal(FU.crossing(g).kind, 'mri-grew');
  // ③ 체크 날짜가 MRI 날짜와 다르면 같은 값이어도 엇갈림이라 하지 않고 '판단 불가'
  let d = mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 18);
  d = add(d, tap('2025-01-05', 50, 52)); d = add(d, tap('2026-02-05', 30, 52));
  c = FU.crossing(d); assert.equal(c.cross, false); assert.equal(c.undetermined, true);
  assert.match(c.text, /판단할 수 없습니다/); assert.match(c.text, /2025-01-05 → 2026-02-05/);
  // 기준점만 같고 최근 날짜가 다른 경우도 판단 불가
  let h = mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 18);
  h = add(h, tap('2025-01-01', 50, 52)); h = add(h, tap('2026-02-05', 30, 52));
  assert.equal(FU.crossing(h).undetermined, true);
  // MRI 가 1개거나, 비교 가능한 체크가 없으면 아무 안내도 없음
  same({ ...FU.crossing(mri(FU.empty(), '2026-01-01', 18)) }, { cross:false });
  same({ ...FU.crossing(mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 18)) }, { cross:false });
  const one = add(mri(mri(FU.empty(), '2025-01-01', 18), '2026-01-01', 18), tap('2026-01-01', 5, 5));
  assert.equal(FU.crossing(one).cross, false, '체크가 기준점 하나뿐이면 비교 불가');
  assert.equal(FU.graph(d).crossing.undetermined, true);
});

test('상속 키(constructor, __proto__, toString…)는 항목·약 ID로 통과하지 못한다', () => {
  const e = FU.empty();
  for(const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']){
    assert.equal(FU.addCheck(e, { type:'sym', date:'2026-01-01', items:[k] }, TODAY).ok, false, k);
    assert.equal(FU.addCheck(e, { type:'care', date:'2026-01-01', items:[k] }, TODAY).ok, false, k);
    assert.equal(FU.setMeds(e, k, null, TODAY).ok, false, k);
  }
  const s = FU.clean({ v:1, checks:[{ type:'sym', date:'2026-01-01', items:['constructor'] }, { type:'sym', date:'2026-01-02', items:['dip'] }] });
  assert.equal(s.checks.length, 1);
});

test('clean 은 오늘 이후의 촬영일·체크 날짜를 버리고 다음 MRI 예정일만 미래를 허용한다', () => {
  const raw = { v:1, next:'2099-01-01', mri:[{ date:'2026-01-01', size:10 }, { date:'2026-11-12', size:11 }, { date:'2099-01-01', size:12 }],
    checks:[tap('2026-11-10', 1, 1), tap('2026-11-11', 1, 1), tap('2099-05-05', 1, 1)] };
  const s = FU.clean(raw, '2026-11-10');
  same(s.mri.map(m => m.date), ['2026-01-01']);
  same(s.checks.map(c => c.date), ['2026-11-10']);
  assert.equal(s.next, '2099-01-01');
  assert.equal(FU.clean(raw, 'x').checks.some(c => c.date === '2099-05-05'), false, 'today 가 잘못되면 실제 오늘 기준');
});

test('약 사용 기록: 목록 밖 값·미래 날짜 거절, 사용 안 함이면 날짜를 비움, 요약·질문에는 의사에게 알리라고만 한다', () => {
  const e = FU.empty();
  for(const h of ['stop', '', null, 5, '__proto__', 'constructor']) assert.equal(FU.setMeds(e, h, null, TODAY).ok, false, String(h));
  assert.equal(FU.setMeds(e, 'now', '2026-12-01', TODAY).ok, false);
  assert.equal(FU.setMeds(e, 'now', 'abc', TODAY).ok, false);
  let s = ok(FU.setMeds(e, 'now', '2026-10-01', TODAY)); assert.equal(s.meds.date, '2026-10-01');
  s = ok(FU.setMeds(s, 'never', '2026-10-01', TODAY)); assert.equal(s.meds.date, null);
  s = ok(FU.setMeds(s, 'past', '', TODAY));
  const m = FU.summary(s, TODAY);
  assert.equal(m.hormone, 'past');
  assert.ok(m.questions.some(q => /메드록시프로게스테론/.test(q)));
  const text = JSON.stringify(m) + JSON.stringify(FU.HORMONE);
  assert.doesNotMatch(text, /끊으|중단하|복용을 멈|바꾸세요/, '약 중단 권고 금지');
});

test('요약: 응급 항목은 가장 최근 증상 기록 기준으로 표시하고, 질문은 위치·변화·다음 MRI를 반영한다', () => {
  let s = ok(FU.setLoc(FU.empty(), 'cpa'));
  s = ok(FU.setNext(s, '2027-02-01'));
  s = add(s, { type:'sym', date:'2026-10-01', items:['em3', 'hearing'] });
  let m = FU.summary(s, TODAY);
  same([...m.emergencyItems], ['갑자기 얼굴 한쪽이 처짐']); assert.equal(m.emergencyDate, '2026-10-01');
  assert.equal(m.daysToNext, 83);
  assert.ok(m.questions[0].includes('소뇌교각'));
  assert.ok(m.questions.some(q => q.includes('2027-02-01')));
  s = add(s, { type:'sym', date:'2026-11-01', items:['hearing'] });
  same([...FU.summary(s, TODAY).emergencyItems], []);
  assert.ok(FU.summary(s, TODAY).questions.length >= 3);
});

test('경과 관찰 코드에 정상/이상 판정·임상 임계치 표현이 없다', () => {
  const ui = readFileSync(new URL('../js/followup-ui.js', import.meta.url), 'utf8');
  for(const src of [SRC, ui]){
    assert.doesNotMatch(src, /비정상|정상 범위|정상입니다|이상입니다|이상 소견|악화됐|호전됐|진단합니다|처방|복용을 중단|약을 끊/);
  }
  assert.match(SRC, /의학적 기준이 아닙니다|의학적 기준 아님/);
  assert.match(ui, /좋고 나쁨을 판단하지 않습니다/);
});

test('핵심 코드는 DOM·저장소·네트워크를 쓰지 않는다', () => {
  assert.doesNotMatch(SRC, /document\.|window\.|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|eval\(|innerHTML/);
});

test('체크 주기를 앱이 정하지 않는다: 월 1회 같은 기본 주기를 제시하지 않고 의료진과 정한 간격을 안내한다', () => {
  const ui = readFileSync(new URL('../js/followup-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui + SRC, /한 달에 한 번|월 1회|매달|매주|하루에 한|기본 주기/);
  assert.match(ui, /담당 의료진과 정한 간격/);
  assert.doesNotMatch(ui + SRC, /연습 효과|훈련|학습 효과|호전|악화|진단합니다|진단됩니다/);
});

test('날짜 입력의 max 속성이 중복되지 않는다', () => {
  const ui = readFileSync(new URL('../js/followup-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /fuDateIn\([^)]*'max=/);
  const fn = /const fuDateIn[^\n]*\n/.exec(ui)[0];
  assert.equal((fn.match(/ max=/g) || []).length, 1);
});

test('간단 시야: 검사 화면 크기(fw)가 기준점과 다르면 비교에 한계가 있다고 표시하고 엇갈림 판단에서 뺀다', () => {
  const v = (date, eye, fw, ...n) => ({ ...vf(date, eye, ...n), ...(fw ? { fw } : {}) });
  assert.equal(FU.addCheck(FU.empty(), v('2026-01-01', 'R', 50, 3, 3, 3, 3), TODAY).ok, false);
  assert.equal(FU.addCheck(FU.empty(), v('2026-01-01', 'R', 99999, 3, 3, 3, 3), TODAY).ok, false);
  assert.equal(FU.addCheck(FU.empty(), { ...v('2026-01-01', 'R', 0, 3, 3, 3, 3), fw:'600' }, TODAY).ok, false);
  let s = add(FU.empty(), v('2026-01-01', 'R', 600, 3, 3, 3, 3));
  s = add(s, v('2026-02-01', 'R', 600, 3, 3, 3, 3)); assert.equal(FU.compare(s, 'vf4', 'R').limited, false);
  s = add(s, v('2026-03-01', 'R', 450, 3, 3, 1, 3));
  const c = FU.compare(s, 'vf4', 'R');
  assert.equal(c.state, 'changed'); assert.equal(c.limited, true); assert.match(c.limitNote, /600px → 450px[^]*한계/);
  assert.equal(FU.compare(add(FU.empty(), vf('2026-01-01', 'R', 3, 3, 3, 3)), 'vf4', 'R').limited, undefined, '기준점 하나뿐이면 비교 자체가 없음');
  const old = add(add(FU.empty(), vf('2026-01-01', 'R', 3, 3, 3, 3)), v('2026-02-01', 'R', 600, 3, 3, 1, 3));
  assert.equal(FU.compare(old, 'vf4', 'R').limited, false, '이전 기록에 fw 가 없으면 한계를 단정하지 않음');
  // 같은 두 날짜 체크가 있어도 화면 크기가 다른 비교는 엇갈림 판단에서 제외
  let m = ok(FU.addMri(ok(FU.addMri(FU.empty(), '2025-01-01', 18, TODAY)), '2026-01-01', 18, TODAY));
  m = add(m, v('2025-01-01', 'R', 600, 3, 3, 3, 3)); m = add(m, v('2026-01-01', 'R', 450, 3, 3, 0, 0));
  const x = FU.crossing(m); assert.equal(x.cross, false); assert.equal(x.undetermined, true);
  assert.match(FU.summary(s, TODAY).compare[0].limitNote, /한계/);
});

test('기준점 ID 조회와 요약 질문(인쇄용 5개): 약·다음 MRI·엇갈림 질문은 변화가 많아도 밀려나지 않고, 과거 응급 체크 날짜도 남는다', () => {
  let s = FU.empty();
  assert.equal(FU.baseId(s, 'tap'), null);
  s = add(s, tap('2026-02-01', 50, 52)); s = add(s, tap('2026-01-01', 50, 52));
  assert.equal(FU.compare(s, 'tap').base.date, '2026-01-01'); assert.equal(FU.baseId(s, 'tap'), s.checks[0].id);
  const del = FU.removeCheck(s, FU.baseId(s, 'tap')).state;
  assert.notEqual(FU.baseId(del, 'tap'), FU.baseId(s, 'tap'));
  let m = ok(FU.setMeds(FU.empty(), 'now', null, TODAY)); m = ok(FU.setNext(m, '2027-03-01'));
  for(const t of ['tap', 'vf4']){ /* 변화 항목을 여러 개 만든다 */ }
  m = add(m, tap('2026-01-01', 50, 52)); m = add(m, tap('2026-02-01', 20, 52));
  for(const e of ['R', 'L']){ m = add(m, vf('2026-01-01', e, 3, 3, 3, 3)); m = add(m, vf('2026-02-01', e, 0, 0, 0, 0)); }
  m = add(m, { type:'smell', date:'2026-01-01', L:2, R:2 }); m = add(m, { type:'smell', date:'2026-02-01', L:0, R:0 });
  m = add(m, { type:'hear', date:'2026-01-01', L:2, R:2 }); m = add(m, { type:'hear', date:'2026-02-01', L:0, R:0 });
  m = add(m, { type:'sym', date:'2026-01-01', items:[] }); m = add(m, { type:'sym', date:'2026-02-01', items:['vis1', 'dip'] });
  const sm = FU.summary(m, TODAY);
  assert.ok(sm.questions.length > 5);
  assert.equal(sm.printQuestions.length, 5);
  assert.ok(sm.printQuestions.some(q => /메드록시프로게스테론/.test(q)) && sm.printQuestions.some(q => /다음 MRI/.test(q)));
  assert.equal(new Set(sm.printQuestions).size, 5);
  let e = add(FU.empty(), { type:'sym', date:'2026-09-01', items:['em2'] }); e = add(e, { type:'sym', date:'2026-10-01', items:['vis1'] });
  const se = FU.summary(e, TODAY);
  assert.equal(se.emergencyItems.length, 0); same(se.emergencyDates, ['2026-09-01'], '최근 기록에 없어도 과거 응급 체크 날짜는 요약에 남는다');
});
