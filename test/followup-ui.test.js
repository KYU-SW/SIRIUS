import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const CORE = read('js/followup-core.js'), UI = read('js/followup-ui.js');
const TODAY_REAL = (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date());
const TOMORROW = (d => { d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(new Date());
const SYN_ACC = () => ({ id:'synthetic_user' });

/* 가짜 DOM·가짜 시계로 followup-ui.js 를 실행한다. 합성 데이터만 쓰고 네트워크·저장소 접근은 없다. */
function build({ save = async () => ({ ok:true }), file = null } = {}){
  const nodes = new Map(), docH = {}, winH = {}, q = {}, qa = {};
  const timers = new Map(); let tid = 0, clock = 1000, printed = 0, copied = [], saves = 0;
  const node = id => { if(!nodes.has(id)) nodes.set(id, { id, hidden:false, innerHTML:'', textContent:'', dataset:{}, value:'', h:{}, focus(){}, addEventListener(ev, fn){ this.h[ev] = fn; } }); return nodes.get(id); };
  const classes = new Set();
  const ctx = vm.createContext({
    document:{ getElementById:node, addEventListener(ev, fn){ docH[ev] = fn; }, removeEventListener(ev){ delete docH[ev]; }, querySelector:s => q[s] ?? null, querySelectorAll:s => qa[s] ?? [],
      documentElement:{ classList:{ add:c => classes.add(c), remove:c => classes.delete(c) } }, activeElement:null, hidden:false },
    window:{ scrollTo(){}, addEventListener(ev, fn){ winH[ev] = fn; }, print(){ printed++; } },
    navigator:{ clipboard:{ writeText:async t => { copied.push(t); } } },
    performance:{ now:() => clock },
    setTimeout:(fn, ms) => { const id = ++tid; timers.set(id, { fn, at:clock + ms }); return id; },
    clearTimeout:id => timers.delete(id),
    S:{ acc:SYN_ACC(), masterKey:{ synthetic:true }, followup:null },
    saveVault:async () => { saves++; return save(); },
    FUFile:file || undefined,
  });
  vm.runInContext('const esc = s => String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));', ctx);
  vm.runInContext(CORE + '\n' + UI, ctx);
  const ev = code => vm.runInContext(code, ctx);
  const root = node('fuRoot');
  const t = {
    ctx, ev, node, q, qa, docH, winH, classes, S:ctx.S,
    get printed(){ return printed; }, get copied(){ return copied; }, get saves(){ return saves; }, get timers(){ return timers.size; },
    html:() => root.innerHTML,
    press(action, data = {}){ root.h.click({ target:{ closest:() => ({ dataset:{ fu:action, ...data } }) } }); },
    change(id, value){ root.h.change({ target:{ id, value, hasAttribute:() => false } }); },
    advance(ms){
      const end = clock + ms;
      for(;;){
        let next = null;
        for(const [id, tm] of timers) if(tm.at <= end && (!next || tm.at < next.tm.at)) next = { id, tm };
        if(!next) break;
        timers.delete(next.id); clock = Math.max(clock, next.tm.at); next.tm.fn();
      }
      clock = end;
    },
    flush:() => new Promise(r => setImmediate(r)),
    enter(state){ ctx.S.followup = state ?? null; ev('followupEnter()'); },
    state:() => JSON.parse(JSON.stringify(ctx.S.followup)),
  };
  return t;
}
const J = x => JSON.parse(JSON.stringify(x));
const same = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const addMriViaUi = (t, date, size) => { t.node('fuMriDate').value = date; t.node('fuSize').value = size; t.press('addMri'); };

test('로그인(S.acc + S.masterKey)이 없으면 화면 조작이 아무것도 바꾸지 못한다', async () => {
  const t = build(); t.enter();
  t.S.acc = null; t.S.masterKey = null;
  addMriViaUi(t, '2026-01-01', '18'); t.press('go', { v:'summary' });
  t.change('fuLoc', 'cpa');
  assert.equal(t.saves, 0); assert.equal(t.state().mri.length, 0); assert.equal(t.state().loc, 'unknown');
  t.S.acc = SYN_ACC(); t.S.masterKey = null;
  addMriViaUi(t, '2026-01-01', '18');
  assert.equal(t.saves, 0, 'masterKey 가 없으면 저장도 하지 않는다');
});

test('followupEnter 는 저장소에서 읽은 값을 FU.clean 으로 정제하고 악성 문자열을 화면에 넣지 않는다', () => {
  const t = build();
  t.enter({ v:1, loc:'<img src=x onerror=alert(1)>', next:'<script>', mri:[{ date:'2026-01-01<b>', size:'<i>' }], checks:[{ type:'<svg onload=1>', date:'2026-01-01' }], meds:{ hormone:'<u>' } });
  const s = t.state();
  assert.equal(s.loc, 'unknown'); same(s.mri, []); same(s.checks, []);
  assert.doesNotMatch(t.html(), /<img|<script|<svg|onerror|onload/i);
  assert.match(t.html(), /내 종양 정보/);
  t.enter('문자열'); assert.equal(t.state().v, 1);
  t.enter([1, 2]); assert.equal(t.state().v, 1);
});

test('종양 정보 입력: 잘못된 값은 오류를 보이고 저장하지 않으며, 올바른 값은 저장 후 목록에 나온다', async () => {
  const t = build(); t.enter();
  addMriViaUi(t, '2026-01-01', '999'); assert.match(t.html(), /0\.1~150 mm/); assert.equal(t.saves, 0); assert.equal(t.state().mri.length, 0);
  addMriViaUi(t, TOMORROW, '10'); assert.match(t.html(), /오늘 이후/);
  addMriViaUi(t, '', '10'); assert.match(t.html(), /촬영일을 날짜로/);
  addMriViaUi(t, '2026-01-01', '18,5'); await t.flush();
  assert.equal(t.state().mri[0].size, 18.5); assert.equal(t.saves, 1);
  assert.match(t.html(), /18\.5 mm/); assert.match(t.node('fuSave').innerHTML, /암호화해 이 브라우저에 저장/);
  t.change('fuLoc', 'cpa'); assert.equal(t.state().loc, 'cpa'); assert.match(t.html(), /박자 두드리기/); assert.doesNotMatch(t.html(), /청력 기록|data-v="hear"/);
  t.change('fuLoc', 'olfactory'); assert.doesNotMatch(t.html(), /후각 기록|data-v="smell"/, '후각·청력 검사는 새로 권하지 않음');
  t.change('fuHand', 'left'); assert.equal(t.state().hand, 'left'); t.change('fuHand', 'both'); assert.equal(t.state().hand, 'left'); assert.match(t.html(), /목록에서 골라/);
  t.change('fuLoc', '<bad>'); assert.equal(t.state().loc, 'olfactory'); assert.match(t.html(), /목록에서 골라/);
  t.change('fuNext', '2027-01-01'); assert.equal(t.state().next, '2027-01-01');
  t.change('fuNext', '2027-99-99'); assert.equal(t.state().next, '2027-01-01'); assert.match(t.html(), /날짜로 입력/);
  t.change('fuNext', ''); assert.equal(t.state().next, null);
});

test('저장 실패: 화면의 값은 유지되고 [다시 저장]으로 복구하며, 성공하면 안내가 바뀐다', async () => {
  let ok = false;
  const t = build({ save:async () => ({ ok }) }); t.enter();
  addMriViaUi(t, '2026-01-01', '18'); await t.flush();
  assert.match(t.node('fuSave').innerHTML, /저장하지 못했습니다/); assert.match(t.node('fuSave').innerHTML, /다시 저장/);
  assert.equal(t.state().mri.length, 1, '실패해도 메모리 값은 그대로');
  ok = true; t.press('retry'); await t.flush();
  assert.match(t.node('fuSave').innerHTML, /저장했습니다/); assert.equal(t.saves, 2);
  const t2 = build({ save:async () => { throw new Error('boom'); } }); t2.enter();
  addMriViaUi(t2, '2026-01-01', '18'); await t2.flush();
  assert.match(t2.node('fuSave').innerHTML, /저장하지 못했습니다/);
});

test('로그아웃·다른 계정 뒤에 늦게 도착한 저장 결과는 화면에 반영하지 않는다', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const t = build({ save:() => gate }); t.enter();
  addMriViaUi(t, '2026-01-01', '18');
  t.ev('followupReset()');
  release({ ok:true }); await t.flush();
  assert.equal(t.html(), ''); assert.equal(t.ev('FUS.save'), '');
  const t2 = build({ save:() => gate.then(() => ({ ok:true })) }); t2.enter();
  addMriViaUi(t2, '2026-01-01', '18');
  t2.S.acc = { id:'other_user' };
  await t2.flush();
  assert.notEqual(t2.ev('FUS.save'), 'ok');
  const t3 = build({ save:async () => ({ ok:false, cancelled:true }) }); t3.enter();
  addMriViaUi(t3, '2026-01-01', '18'); await t3.flush();
  assert.equal(t3.ev('FUS.save'), 'fail', '계속 취소만 되면 "저장 중"에 멈추지 않고 실패로 보여 다시 저장 가능 (더 새로운 fuPersist 에 넘겨진 결과는 세대 검사로 무시)');
});

test('followupReset: 기록·화면·진행 중인 검사와 타이머·소리를 모두 지운다', () => {
  const t = build(); t.enter();
  addMriViaUi(t, '2026-01-01', '18');
  t.press('go', { v:'tapIntro' }); t.press('tapStart');
  t.node('fuStageGo').h.click(); assert.ok(t.timers > 0);
  assert.equal(t.node('fuStage').hidden, false);
  t.ev('followupReset()');
  assert.equal(t.S.followup, null); assert.equal(t.html(), ''); assert.equal(t.timers, 0);
  assert.equal(t.node('fuStage').hidden, true); assert.equal(t.ev('FUS.test'), null); assert.equal(t.ev('FUS.draft'), null);
  assert.equal(t.docH.keydown, undefined, '키 입력 리스너도 해제');
  t.press('go', { v:'summary' }); assert.equal(t.html(), '', '초기화 뒤 조작은 화면을 다시 그리지 않음');
  t.enter(); assert.match(t.html(), /내 종양 정보/); assert.equal(t.state().mri.length, 0, '다시 들어오면 이전 기록이 남아 있지 않음');
});

/* 빠르게 두드리기 한 번 전체: 손마다 [시작] → 3초 → 10초, 같은 손 2·3번째는 5초 쉬고 자동 시작. counts = [[왼손 3개], [오른손 3개]] */
function runTap(t, counts){
  for(const hand of counts){
    for(let k = 0; k < hand.length; k++){
      if(k === 0) t.node('fuStageGo').h.click(); else t.advance(5000);
      t.advance(3000);
      assert.equal(t.ev('FUS.test.phase'), 'run');
      for(let i = 0; i < hand[k]; i++){ t.advance(100); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
      t.advance(10000);
    }
  }
}
test('빠르게 두드리기: 스페이스바로 손마다 10초 × 3번(사이 5초), 평균을 기록하고 처음 2번 평균이 기준점, 줄어들 때만 변화', async () => {
  const t = build(); t.enter();
  t.press('go', { v:'tapIntro' }); assert.match(t.html(), /스페이스바/); t.press('tapStart');
  assert.equal(t.node('fuStage').hidden, false); assert.match(t.node('fuStageMsg').textContent, /왼손 1\/3번째/);
  t.node('fuStageGo').h.click(); t.advance(3000);
  assert.equal(t.node('fuTapPad').hidden, true, '화면 패드는 쓰지 않음');
  for(let i = 0; i < 7; i++){ t.advance(200); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
  assert.equal(t.node('fuStageCount').textContent, '7회');
  t.node('fuTapPad').h.pointerdown({ preventDefault(){} }); assert.equal(t.ev('FUS.test.times.length'), 7, '화면 누르기는 세지 않음');
  t.advance(10000);
  assert.equal(t.ev('FUS.test.phase'), 'rest'); assert.match(t.node('fuStageMsg').textContent, /쉬세요[^]*왼손 2\/3번째/);
  t.advance(5000 + 3000); assert.equal(t.ev('FUS.test.phase'), 'run', '쉰 뒤 자동으로 다음 회차');
  for(let i = 0; i < 9; i++){ t.advance(100); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); } t.advance(10000);
  t.advance(8000); for(let i = 0; i < 8; i++){ t.advance(100); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); } t.advance(10000);
  assert.match(t.node('fuStageMsg').textContent, /오른손 1\/3번째/);
  runTap(t, [[8, 8, 8]]);
  assert.equal(t.node('fuStage').hidden, true); assert.equal(t.timers, 0);
  assert.match(t.html(), /빠르게 두드리기 결과/); assert.match(t.html(), /좌우 차이/);
  t.press('saveTap'); await t.flush();
  const c = t.state().checks[0];
  assert.equal(c.type, 'tap'); assert.equal(c.L.n, 8); assert.equal(c.R.n, 8); same(c.trials, { L:[7, 9, 8], R:[8, 8, 8] }); assert.equal(c.input, 'space');
  assert.equal(c.date, TODAY_REAL); assert.match(t.html(), /기준점 만드는 중 1\/2/);
  t.press('go', { v:'tapIntro' }); t.press('tapStart'); runTap(t, [[8, 8, 8], [8, 8, 8]]); t.press('saveTap'); await t.flush();
  assert.match(t.html(), /기준점 완료/);
  t.press('go', { v:'tapIntro' }); t.press('tapStart'); runTap(t, [[12, 12, 12], [12, 12, 12]]); t.press('saveTap'); await t.flush();
  assert.match(t.html(), /비슷함/, '빨라진 것은 변화가 아님'); assert.doesNotMatch(t.html(), /변화 있음/);
  t.press('go', { v:'tapIntro' }); t.press('tapStart'); runTap(t, [[5, 5, 5], [8, 8, 8]]); t.press('saveTap'); await t.flush();
  assert.match(t.html(), /변화 있음/);
});
test('빠르게 두드리기: 10초에 70회를 넘으면 그 회차를 저장하지 않고 다시 한다', () => {
  const t = build(); t.enter(); t.press('tapStart');
  t.node('fuStageGo').h.click(); t.advance(3000);
  for(let i = 0; i < 71; i++){ t.advance(100); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
  t.advance(10000);
  assert.equal(t.ev('FUS.test.phase'), 'ready'); assert.match(t.node('fuStageMsg').textContent, /71회[^]*다시[^]*왼손 1\/3번째/);
  assert.equal(t.ev('FUS.test.res.L.length'), 0);
});

test('두드리기 도중 10초 밖 입력과 준비 시간 입력은 세지 않는다', () => {
  const t = build(); t.enter(); t.press('tapStart');
  t.node('fuStageGo').h.click(); t.advance(1000);
  t.ev('fuPress()');                                      // 준비 중
  assert.equal(t.ev('FUS.test.times.length'), 0);
  t.advance(2000); t.advance(300); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} });
  assert.equal(t.ev('FUS.test.times.length'), 1);
});

test('간단 시야 검사: 눈을 고르고 14번 진행한 뒤 결과를 기록하면 눈별 기준점이 만들어진다', async () => {
  const t = build(); t.enter();
  t.press('go', { v:'vfIntro' });
  t.q['input[name="fuEye"]:checked'] = { value:'L' };
  t.press('vfStart');
  assert.match(t.node('fuStageMsg').textContent, /오른쪽 눈을 가리고/);
  t.node('fuStageGo').h.click();
  let steps = 0;
  while(t.ev('!!FUS.test') && steps++ < 2000){
    t.advance(50);
    if(t.node('fuField').dataset.stim) t.node('fuField').h.pointerdown({ preventDefault(){} });   // 보이면 누름 (빛 없는 확인용은 누르지 않음)
  }
  assert.ok(steps < 2000);
  assert.equal(t.node('fuStage').hidden, true); assert.equal(t.timers, 0);
  assert.match(t.html(), /간단 시야 결과 · 왼쪽 눈/); assert.match(t.html(), /위[\s\S]*3 \/ 3/);
  t.press('saveVf'); await t.flush();
  const c = t.state().checks[0];
  assert.equal(c.eye, 'L'); same(c.seen, { u:3, d:3, l:3, r:3 }); same(c.catch, { shown:2, pressed:0 });
  assert.match(t.html(), /왼쪽 눈 <span class="fu-chip fu-base">기준점 기록됨/);
});

test('확인용(빛 없음)에서 계속 누르면 신뢰 낮음으로 표시되고 기준점 비교에서 빠진다', async () => {
  const t = build(); t.enter(); t.press('go', { v:'vfIntro' }); t.q['input[name="fuEye"]:checked'] = { value:'R' };
  t.press('vfStart'); t.node('fuStageGo').h.click();
  let n = 0;
  while(t.ev('!!FUS.test') && n++ < 2000){ t.advance(50); if(t.ev('FUS.test && FUS.test.open')) t.node('fuField').h.pointerdown({ preventDefault(){} }); }
  assert.match(t.html(), /눌린 횟수가 많아/);
  t.press('saveVf'); await t.flush();
  assert.match(t.html(), /기준점 비교에서 제외/); assert.match(t.html(), /기준점 없음/);
});

test('검사 중단: Esc·중단 버튼·화면 이탈이면 기록하지 않고 타이머를 모두 해제한다', () => {
  const t = build(); t.enter(); t.press('tapStart');
  t.node('fuStageGo').h.click(); t.advance(3500);
  t.docH.keydown({ key:'Escape', preventDefault(){} });
  assert.equal(t.node('fuStage').hidden, true); assert.equal(t.timers, 0); assert.equal(t.state().checks.length, 0);
  assert.match(t.html(), /기록하지 않았습니다/);
  t.press('go', { v:'vfIntro' }); t.q['input[name="fuEye"]:checked'] = { value:'R' }; t.press('vfStart'); t.node('fuStageGo').h.click(); t.advance(3000);
  t.node('fuStageCancel').h.click();
  assert.equal(t.timers, 0); assert.equal(t.ev('FUS.test'), null); assert.equal(t.state().checks.length, 0);
  t.press('tapStart'); t.node('fuStageGo').h.click(); t.advance(500);
  t.ctx.document.hidden = true; t.docH.visibilitychange();
  assert.equal(t.node('fuStage').hidden, true); assert.equal(t.timers, 0); assert.match(t.html(), /화면을 벗어나/);
  t.ctx.document.hidden = false;
});

test('기록·MRI 삭제는 확인 단계를 거친다', async () => {
  const t = build(); t.enter();
  addMriViaUi(t, '2026-01-01', '18');
  t.press('go', { v:'sym' }); t.node('fuDate').value = '2026-01-02'; t.qa['#fuRoot [data-sym]'] = [{ checked:true, getAttribute:() => 'vis1' }];
  t.press('saveSym'); await t.flush();
  assert.equal(t.state().checks.length, 1);
  t.press('askChk', { k:'1' }); assert.match(t.html(), /지울까요/); assert.equal(t.state().checks.length, 1, '확인 전에는 지워지지 않음');
  t.press('askNo'); assert.doesNotMatch(t.html(), /지울까요/); assert.equal(t.state().checks.length, 1);
  t.press('askChk', { k:'1' }); t.press('delChk', { k:'1' }); assert.equal(t.state().checks.length, 0); assert.match(t.html(), /지웠습니다/);
  t.press('askMri', { k:'2026-01-01' }); assert.match(t.html(), /MRI 기록을 지울까요/); assert.equal(t.state().mri.length, 1);
  t.press('delMri', { k:'2026-01-01' }); assert.equal(t.state().mri.length, 0);
  t.press('delChk', { k:'999' }); assert.equal(t.saves >= 3, true);
});

test('증상 기록: 응급 항목을 체크하면 119 안내가 나오고, 보호자 확인 전에는 균형 항목을 쓸 수 없다', async () => {
  const t = build(); t.enter();
  t.change('fuLoc', 'parasagittal'); t.press('go', { v:'sym' });
  assert.match(t.html(), /id="fuEmBanner" role="alert" hidden/); assert.match(t.html(), /119/);
  assert.match(t.html(), /data-sym="balance" disabled/); assert.match(t.html(), /보호자가 지금 옆에 있습니다/);
  t.qa['#fuRoot [data-sym]'] = [{ checked:true, getAttribute:() => 'em1', hasAttribute:() => true }];
  t.node('fuEmBanner').hidden = true;
  t.root = t.node('fuRoot'); t.root.h.change({ target:{ id:'', hasAttribute:a => a === 'data-sym' } });
  assert.equal(t.node('fuEmBanner').hidden, false, '응급 항목 체크 즉시 배너');
  t.node('fuDate').value = TODAY_REAL; t.press('saveSym'); await t.flush();
  assert.match(t.html(), /응급 항목을 체크하셨으니[^<]*119/); same(t.state().checks[0].items, ['em1']);
  t.press('go', { v:'summary' }); assert.match(t.html(), /응급 항목을 체크한 기록이 있습니다/);
});

test('후각·청력 검사 화면은 없고(예전 기록은 읽음), 보호자·약 기록 입력 검증과 저장', async () => {
  const t = build(); t.enter({ v:1, checks:[{ type:'smell', date:'2026-01-01', L:2, R:1 }, { type:'hear', date:'2026-01-01', L:2, R:2 }] });
  assert.equal(t.state().checks.length, 2, '예전 후각·청력 기록은 그대로 불러옴'); assert.match(t.html(), /후각 기록\(예전 기록\)/);
  t.press('go', { v:'smell' }); assert.match(t.html(), /내 종양 정보/, '예전 화면 주소는 홈으로'); assert.doesNotMatch(t.html(), /fusmellL/);
  t.press('go', { v:'hear' }); assert.doesNotMatch(t.html(), /소리를 아주 작게|data-s="L"/);
  t.press('saveLevel', { kind:'smell' }); assert.equal(t.state().checks.length, 2);
  t.press('go', { v:'care' }); t.node('fuDate').value = '2026-02-01'; t.qa['#fuRoot [data-care]'] = [{ checked:true, getAttribute:() => 'seiz' }];
  t.press('saveCare'); await t.flush(); same(t.state().checks.at(-1).items, ['seiz']);
  t.press('go', { v:'meds' }); assert.match(t.html(), /약 사용을 바꾸라는 안내는 하지 않습니다/);
  t.q['input[name="fuHormone"]:checked'] = { value:'stop' }; t.press('saveMeds'); assert.match(t.html(), /목록에서 골라/);
  t.q['input[name="fuHormone"]:checked'] = { value:'past' }; t.node('fuMedDate').value = '2025-05-01'; t.press('saveMeds'); await t.flush();
  same(t.state().meds, { hormone:'past', date:'2025-05-01' });
  assert.match(t.html(), /지금 사용|예전에 사용한 적 있음/);
});

test('진료 요약: 인쇄용은 한 페이지 분량(최근 MRI 3개·기준점/최근·질문·안전 안내)이고 내보내기 전에 확인한다', async () => {
  const t = build(); t.enter(); t.change('fuLoc', 'sellar');
  for(const [d, v] of [['2024-01-01', '15'], ['2024-07-01', '16'], ['2025-01-01', '17'], ['2025-07-01', '18'], ['2026-01-01', '19']]) addMriViaUi(t, d, v);
  t.press('go', { v:'sym' }); t.node('fuDate').value = '2026-02-01'; t.qa['#fuRoot [data-sym]'] = []; t.press('saveSym'); await t.flush();
  t.press('go', { v:'summary' });
  const html = t.html();
  const compact = /<div id="fuPrintCompact"[\s\S]*?<p class="fu-safe">[\s\S]*?<\/p><\/div>/.exec(html)[0];
  assert.match(compact, /2025-01-01 17 mm · 2025-07-01 18 mm · 2026-01-01 19 mm/); assert.doesNotMatch(compact, /2024-01-01|2024-07-01/);
  assert.ok((compact.match(/<li>/g) || []).length <= 5); assert.match(compact, /119/); assert.match(compact, /진단이 아닌 자가 기록/);
  assert.doesNotMatch(compact, /<svg/, '인쇄용에는 그래프를 넣지 않음');
  assert.match(html, /<svg/, '화면 요약에는 전체 그래프가 있음'); assert.match(html, /2024-01-01/, '화면에는 전체 MRI 기록이 남음');
  assert.equal(t.printed, 0);
  t.press('exportAsk'); assert.match(t.html(), /내보내기 확인/); assert.match(t.html(), /건강 정보가 들어 있습니다/); assert.equal(t.printed, 0);
  t.press('askNo'); assert.doesNotMatch(t.html(), /내보내기 확인/);
  t.press('exportAsk'); t.press('exportCopy'); await t.flush();
  assert.equal(t.copied.length, 1); assert.match(t.copied[0], /진단이 아닌 자가 기록/); assert.match(t.copied[0], /119/); assert.match(t.html(), /복사했습니다/);
  t.press('exportAsk'); t.press('exportPrint');
  assert.equal(t.printed, 1); assert.ok(t.classes.has('fu-printing'));
  t.winH.afterprint?.();
});

test('그래프 SVG: 단위별 패널, 기록한 날짜에만 점, 점끼리 잇는 선이 없다', () => {
  const t = build(); t.enter();
  addMriViaUi(t, '2025-01-01', '18'); addMriViaUi(t, '2026-01-01', '18.5');
  const html = t.html();
  assert.match(html, /MRI 종양 크기[\s\S]*눈금 단위: mm/);
  assert.equal((html.match(/<circle /g) || []).length, 2);
  assert.doesNotMatch(html, /<polyline|<path d="M[^"]*L[^"]*"[^>]*fu-line/);
  assert.match(html, /기록하지 않은 날의 값을 추정해 잇지 않습니다/);
});

test('경과 관찰 화면 코드: 네트워크·저장소·인라인 핸들러·eval 없음, 동적 문자열은 esc 를 거친다', () => {
  assert.doesNotMatch(UI, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|eval\(|new Function|document\.write|insertAdjacentHTML|\son[a-z]+=["']/);
  assert.doesNotMatch(UI, /\bhttps?:\/\//);
  const inner = UI.match(/\.innerHTML\s*=/g) || [];
  assert.ok(inner.length <= 6, 'innerHTML 대입이 늘어나면 esc 검토 필요(현재 6: 지우기 2·저장상태·본문·백업안내·미리보기): ' + inner.length);
});

test('앱 연결: 로그인 필수 가드, 로그인 뒤 홈은 경과 관찰, 영상 보기 보존, 로그아웃 초기화', () => {
  const shell = read('js/shell.js'), app = read('js/app.js'), html = read('index.html');
  assert.doesNotMatch(shell + app, /GUEST_OK|requireLogin|enterGuest/);
  assert.match(shell, /function go\(page\)\{\s*\n\s*if\(!S\.acc \|\| !S\.masterKey\)\{ showAuth\(\); show\('login'\); return; \}/);
  assert.match(app, /function enterApp\(\)\{\s*\n\s*if\(!S\.acc \|\| !S\.masterKey\)/);
  assert.match(app, /followupEnter\(\)[\s\S]*go\('followup'\)/);
  assert.match(app, /function logout\(\)[\s\S]*S\.followup = null[\s\S]*followupReset\(\)/);
  assert.match(app, /mode === 'local' \? '기기 전용 로그인'/);
  assert.match(html, /data-go="followup"[\s\S]*경과 관찰/); assert.match(html, /data-go="analyze"[\s\S]*영상 보기/);
  assert.match(html, /data-go="field"/); assert.match(html, /data-page="analyze"/); assert.match(html, /data-page="result"/); assert.match(html, /data-page="history"/);
  assert.match(html, /data-page="followup"[^>]*hidden>[\s\S]*id="fuRoot"/);
  const order = ['js/vf-ui.js', 'js/followup-core.js', 'js/followup-ui.js', 'js/auth-ui.js', 'js/shell.js', 'js/app.js'].map(f => html.indexOf(`<script src="${f}">`));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), '스크립트 순서');
  assert.match(html, /이메일은 수집하지 않습니다/); assert.doesNotMatch(html, /이메일 인증을 마쳐야 가입이 완료됩니다/);
  assert.match(html, /id="suEmail"/); assert.match(html, /id="suSend"/, 'auth-ui 가 참조하는 ID 는 유지');
});

test('검사 무대: 열려 있는 동안 앱 화면은 inert, Tab 은 무대 안에서만 돌고, 닫거나 초기화하면 복구된다', () => {
  const t = build(); t.enter();
  const app = t.node('app');
  t.press('tapStart');
  assert.equal(app.inert, true); assert.equal(t.node('fuStage').hidden, false);
  const f = { go:t.node('fuStageGo'), pad:t.node('fuTapPad'), cancel:t.node('fuStageCancel') };
  const seq = [];
  for(const el of Object.values(f)) el.focus = () => { t.ctx.document.activeElement = el; seq.push(el.id); };
  const tab = shift => t.docH.keydown({ key:'Tab', shiftKey:shift, preventDefault(){ seq.prevented = (seq.prevented || 0) + 1; } });
  t.ctx.document.activeElement = f.go;                    // 시작(Go) 버튼만 보이는 준비 단계: go → cancel → go
  f.go.hidden = false; f.pad.hidden = true;
  tab(false); tab(false); tab(true);
  assert.deepEqual(seq.slice(), ['fuStageCancel', 'fuStageGo', 'fuStageCancel']);
  assert.equal(seq.prevented, 3, 'Tab 의 기본 동작(무대 밖으로 이동)은 항상 막는다');
  t.node('fuStageGo').h.click(); t.advance(3000);          // 두드리기 단계: 패드가 포커스 순서에 들어옴
  f.go.hidden = true; f.pad.hidden = false; t.ctx.document.activeElement = f.cancel; seq.length = 0;
  tab(false); assert.deepEqual(seq.slice(), ['fuTapPad']);
  t.docH.keydown({ key:'Escape', preventDefault(){} });
  assert.equal(app.inert, false); assert.equal(t.node('fuStage').hidden, true);
  t.press('tapStart'); assert.equal(app.inert, true);
  t.ev('followupReset()'); assert.equal(app.inert, false, '초기화해도 inert 가 남지 않는다'); assert.equal(t.docH.keydown, undefined);
});

test('저장 실패·미저장 결과·검사 중에는 닫기/새로고침 경고가 뜨고, 아무것도 없으면 뜨지 않는다', async () => {
  let ok = false;
  const t = build({ save:async () => ({ ok }) }); t.enter();
  const warn = () => { let p = 0; const e = { preventDefault(){ p++; } }; const r = t.winH.beforeunload && t.winH.beforeunload(e); return { p, r }; };
  assert.ok(t.winH.beforeunload, 'beforeunload 핸들러가 등록되어 있어야 함');
  assert.equal(warn().p, 0);
  addMriViaUi(t, '2026-01-01', '18'); await t.flush();                 // 저장 실패
  assert.equal(warn().p, 1);
  ok = true; t.press('retry'); await t.flush(); assert.equal(warn().p, 0, '저장되면 경고 없음');
  t.press('tapStart'); assert.equal(warn().p, 1, '검사 중'); t.docH.keydown({ key:'Escape', preventDefault(){} });
  assert.equal(warn().p, 0);
  t.ev("FUS.draft = { type:'tap', L:{ n:5, cv:null }, R:{ n:5, cv:null } }; FUS.view = 'tapDone'"); assert.equal(warn().p, 1, '저장하지 않은 두드리기 결과');
  t.ev("FUS.draft = null; FUS.view = 'home'"); assert.equal(warn().p, 0);
  t.S.acc = null; t.ev("FUS.save = 'fail'"); assert.equal(warn().p, 0, '로그아웃 뒤에는 경고하지 않음');
});

test('기준점이 바뀌는 삭제·소급 입력은 확인 문구와 결과 안내로 알려 준다', async () => {
  const t = build(); t.enter();
  const sym = async (d, items = []) => { t.press('go', { v:'sym' }); t.node('fuDate').value = d; t.qa['#fuRoot [data-sym]'] = items.map(i => ({ checked:true, getAttribute:() => i })); t.press('saveSym'); await t.flush(); };
  await sym('2026-02-01'); await sym('2026-03-01', ['vis1']);
  t.press('askChk', { k:'1' }); assert.match(t.html(), /기준점입니다[^]*다음 기록이 새 기준점/);
  t.press('askNo'); t.press('askChk', { k:'2' }); assert.doesNotMatch(t.html(), /다음 기록이 새 기준점/, '기준점이 아닌 기록은 일반 확인');
  t.press('askNo'); t.press('askChk', { k:'1' }); t.press('delChk', { k:'1' });
  assert.match(t.html(), /기준점이 2026-03-01 기록으로 바뀌어 비교 결과가 달라졌습니다/);
  await sym('2026-01-01');                                          // 소급 입력 → 더 빠른 날짜가 새 기준점
  assert.match(t.html(), /가장 빨라 새 기준점이 되었습니다/);
  await sym('2026-04-01'); assert.doesNotMatch(t.html(), /새 기준점이 되었습니다/);
});

test('간단 시야 기록에는 검사 화면 크기가 들어가고, 기준점과 다르면 화면에 비교 한계가 표시된다', async () => {
  const t = build(); t.enter();
  const run = async w => {
    t.press('go', { v:'vfIntro' }); t.q['input[name="fuEye"]:checked'] = { value:'R' };
    t.node('fuField').getBoundingClientRect = () => ({ width:w });
    t.press('vfStart'); t.node('fuStageGo').h.click();
    let n = 0; while(t.ev('!!FUS.test') && n++ < 2000){ t.advance(50); if(t.node('fuField').dataset.stim) t.node('fuField').h.pointerdown({ preventDefault(){} }); }
    t.press('saveVf'); await t.flush();
  };
  await run(612); assert.equal(t.state().checks[0].fw, 600);
  await run(612); assert.doesNotMatch(t.html(), /비교에 한계/);
  await run(480); assert.equal(t.state().checks[2].fw, 500); assert.match(t.html(), /화면 크기 다름 · 비교에 한계/);
  t.press('go', { v:'summary' }); assert.match(t.html(), /600px → 500px[^]*비교에 한계가 있습니다/);
});

test('인쇄용 요약: 질문 5개 안에 약·다음 MRI 질문이 남고, 과거 응급 체크 날짜가 표시된다', async () => {
  const t = build(); t.enter();
  t.press('go', { v:'meds' }); t.q['input[name="fuHormone"]:checked'] = { value:'now' }; t.node('fuMedDate').value = ''; t.press('saveMeds');
  t.change('fuNext', '2027-03-01');
  const symrec = async (d, items) => { t.press('go', { v:'sym' }); t.node('fuDate').value = d; t.qa['#fuRoot [data-sym]'] = items.map(i => ({ checked:true, getAttribute:() => i })); t.press('saveSym'); await t.flush(); };
  await symrec('2026-01-01', ['em2']); await symrec('2026-02-01', ['vis1']);
  for(const e of ['R', 'L']) for(const [d, n] of [['2026-01-01', 3], ['2026-02-01', 0]]){
    t.ev(`S.followup = FU.addCheck(S.followup, { type:'vf4', date:'${d}', eye:'${e}', seen:{ u:${n}, d:${n}, l:${n}, r:${n} }, catch:{ shown:2, pressed:0 } }, '${TODAY_REAL}').state`);
  }
  t.press('go', { v:'care' }); t.node('fuDate').value = '2026-01-01'; t.qa['#fuRoot [data-care]'] = []; t.press('saveCare'); await t.flush();
  t.press('go', { v:'care' }); t.node('fuDate').value = '2026-02-01'; t.qa['#fuRoot [data-care]'] = [{ checked:true, getAttribute:() => 'seiz' }]; t.press('saveCare'); await t.flush();
  t.press('go', { v:'summary' });
  const compact = /<div id="fuPrintCompact"[^]*?<p class="fu-safe">/.exec(t.html())[0];
  assert.ok((compact.match(/<li>/g) || []).length <= 5);
  assert.match(compact, /메드록시프로게스테론 주사 등\) <b>지금 사용/); assert.match(compact, /<li>[^<]*메드록시프로게스테론/); assert.match(compact, /<li>[^<]*다음 MRI/);
  assert.match(compact, /과거에 응급 항목을 체크한 날짜: 2026-01-01/);
});

test('저장 결과 구분: 다른 탭 충돌·미지원은 일반 실패와 다른 안내, 재저장 버튼 없음, 닫기 경고, 성공은 ok===true만', async () => {
  let res = { ok:true };
  const t = build({ save:async () => res }); t.enter();
  const warn = () => { let p = 0; t.winH.beforeunload({ preventDefault(){ p++; } }); return p; };
  const saveTxt = () => t.node('fuSave').innerHTML;
  res = { ok:false, conflict:true };
  addMriViaUi(t, '2026-01-01', '18'); await t.flush();
  assert.match(saveTxt(), /다른 탭[^]*거절[^]*자동으로 합쳐지지 않[^]*다시 로그인/);
  assert.doesNotMatch(saveTxt(), /data-fu="retry"/, '충돌에는 다시 저장 버튼을 주지 않음');
  assert.equal(warn(), 1, '충돌도 닫기 경고');
  res = { ok:false, unsupported:true };
  t.ev("fuPersist()"); await t.flush();
  assert.match(saveTxt(), /탭 잠금[^]*최신 Chrome/);
  assert.doesNotMatch(saveTxt(), /브라우저 저장 공간/);
  assert.equal(warn(), 1, '미지원도 닫기 경고');
  res = { ok:false };
  t.ev("fuPersist()"); await t.flush();
  assert.match(saveTxt(), /저장하지 못했습니다[^]*data-fu="retry"/, '일반 실패는 재시도 가능');
  res = { ok:'yes' };
  t.ev("fuPersist()"); await t.flush();
  assert.doesNotMatch(saveTxt(), /✓/, 'ok 가 true 가 아니면 성공으로 보지 않음');
  res = { ok:true };
  t.ev("fuPersist()"); await t.flush();
  assert.match(saveTxt(), /✓/); assert.equal(warn(), 0);
});

/* ── 암호화 백업·복원 (FUFile 은 가짜. 실제 암호화는 Codex 의 FUFile 테스트가 검증) ── */
const mkFile = (o = {}) => {
  const f = { downloads:[], encs:[], decs:[],
    MAX_BYTES:2 * 1024 * 1024, FAIL:'비밀번호가 맞지 않거나 올바른 SIRIUS 경과관찰 백업이 아닙니다.',
    passProblem:p => (typeof p === 'string' && p.length >= 12) ? '' : '백업 비밀번호는 12자 이상으로 정해 주세요.',
    encrypt:o.encrypt || (async (st, pass) => { f.encs.push(pass); return 'CIPHER'; }),
    decrypt:o.decrypt || (async (text, pass) => { f.decs.push(pass); return JSON.parse(text); }),
    fileName:() => 'x.sirius-followup', download:(tx, nm) => f.downloads.push([tx, nm]) };
  return f;
};
const BK = { v:1, loc:'cpa', next:'', mri:[{ date:'2026-01-01', size:20 }], checks:[], meds:{ hormone:'unknown', date:'' }, nid:1 };
const pickFile = (t, text, size) => { t.node('fuRsFile').files = [{ size:size ?? text.length, text:async () => text }]; t.change('fuRsFile', 'x'); };
const gotoBackup = t => t.press('go', { v:'backup' });

test('백업 내보내기: 12자 미만·확인 불일치는 거절, 통과하면 사용자 클릭 뒤에만 암호화해 내려받고 비밀번호를 지운다', async () => {
  const f = mkFile(), t = build({ file:f }); t.enter(); gotoBackup(t);
  assert.match(t.html(), /백업 비밀번호[^]*암호화 파일 내려받기/);
  t.node('fuBkPass').value = 'short'; t.node('fuBkPass2').value = 'short'; t.press('bkExport'); await t.flush();
  assert.match(t.node('fuBkStatus').innerHTML, /12자/); assert.equal(f.encs.length, 0);
  t.node('fuBkPass').value = 'long-enough-pass'; t.node('fuBkPass2').value = 'different-pass-x'; t.press('bkExport'); await t.flush();
  assert.match(t.node('fuBkStatus').innerHTML, /일치하지 않/); assert.equal(f.encs.length, 0);
  assert.equal(f.downloads.length, 0, '클릭 없이/실패 시 다운로드 없음');
  t.node('fuBkPass2').value = 'long-enough-pass'; t.press('bkExport'); await t.flush();
  assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0][1], 'x.sirius-followup');
  assert.equal(t.node('fuBkPass').value, ''); assert.equal(t.node('fuBkPass2').value, '');
  assert.equal(t.saves, 0, '내보내기는 저장소를 건드리지 않음');
});

test('내보내기 중 로그아웃·계정변경·화면 이동이 있으면 다운로드하지 않는다', async () => {
  for(const kind of ['logout', 'acc', 'nav']){
    let release; const gate = new Promise(r => { release = r; });
    const f = mkFile({ encrypt:async () => { await gate; return 'CIPHER'; } }), t = build({ file:f }); t.enter(); gotoBackup(t);
    t.node('fuBkPass').value = t.node('fuBkPass2').value = 'long-enough-pass'; t.press('bkExport');
    if(kind === 'logout') t.ev('followupReset()'); else if(kind === 'acc') t.S.acc = { id:'other' }; else t.press('go', { v:'home' });
    release(); await t.flush(); await t.flush();
    assert.equal(f.downloads.length, 0, kind);
  }
});

test('복원: 크기 초과·비밀번호 없음·잘못된 파일은 미리보기가 없고 기존 기록이 그대로다', async () => {
  const f = mkFile({ decrypt:async () => { throw new Error('x'); } }), t = build({ file:f }); t.enter({ ...BK, mri:[{ date:'2026-05-01', size:9 }] }); gotoBackup(t);
  t.press('bkRead'); await t.flush(); assert.match(t.node('fuBkStatus').innerHTML, /파일을 먼저/);
  pickFile(t, '{}', f.MAX_BYTES + 1); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  assert.match(t.node('fuBkStatus').innerHTML, /너무 큽니다/); assert.equal(f.decs.length, 0, '큰 파일은 읽지도 않음');
  pickFile(t, '{}'); t.node('fuRsPass').value = ''; t.press('bkRead'); await t.flush(); assert.match(t.node('fuBkStatus').innerHTML, /비밀번호를 입력/);
  t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  assert.match(t.node('fuBkStatus').innerHTML, /맞지 않거나/); assert.equal(t.node('fuRsPreview').innerHTML, '');
  assert.equal(t.state().mri[0].size, 9); assert.equal(t.saves, 0);
});

test('복원: 미리보기(위치·개수) 확인 → 명시적 확인란 없이는 교체 불가 → 교체 후 saveVault 와 로그에 비밀번호 없음', async () => {
  const f = mkFile(), t = build({ file:f }); t.enter({ ...BK, loc:'sellar', mri:[{ date:'2026-05-01', size:9 }] }); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  const pv = t.node('fuRsPreview').innerHTML;
  assert.match(pv, /MRI 기록 1건/); assert.match(pv, /체크 기록 0건/); assert.match(pv, /교체되면 지금 기록\(MRI 1건/);
  assert.match(t.html(), /다른 사람의 백업 파일을 섞지 마세요[^]*먼저 위에서 백업/);
  assert.equal(t.node('fuRsPass').value, '', '복호화 뒤 비밀번호 칸을 지움');
  assert.equal(t.state().loc, 'sellar', '미리보기만으로는 교체되지 않음'); assert.equal(t.saves, 0);
  t.press('bkReplace'); await t.flush(); assert.equal(t.state().loc, 'sellar'); assert.match(t.node('fuBkStatus').innerHTML, /확인란/); assert.equal(t.saves, 0);
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  assert.equal(t.state().loc, 'cpa'); assert.equal(t.state().mri[0].size, 20); assert.equal(t.saves, 1);
  assert.match(t.html(), /백업으로 기록을 교체하고 저장/); assert.equal(t.ev('FUS.rs'), null);
  assert.doesNotMatch(t.html() + JSON.stringify(t.state()), /pw-pw-pw/);
});

test('복원 저장 실패: 기존 기록 보존, 미리보기 유지, 같은 화면에서 재시도 성공', async () => {
  let ok = false; const f = mkFile(), t = build({ file:f, save:async () => ({ ok }) });
  t.enter({ ...BK, loc:'sellar', mri:[{ date:'2026-05-01', size:9 }] }); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  assert.equal(t.state().loc, 'sellar'); assert.equal(t.state().mri[0].size, 9, '실패하면 메모리 기록 그대로');
  assert.match(t.node('fuBkStatus').innerHTML, /교체하지 않았습니다[^]*다시 시도/); assert.match(t.node('fuRsPreview').innerHTML, /교체하기/);
  assert.equal(t.ev('fuUnsaved()'), false, '교체 실패 뒤 메모리=저장본이므로 닫기 경고 불필요');
  ok = true; t.press('bkReplace'); await t.flush();
  assert.equal(t.state().loc, 'cpa'); assert.equal(t.saves, 2);
});

test('복원 저장이 conflict 면 기존 기록 보존 + 충돌 안내 + 닫기 경고', async () => {
  const f = mkFile(), t = build({ file:f, save:async () => ({ ok:false, conflict:true }) }); t.enter({ ...BK, loc:'sellar' }); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  assert.equal(t.state().loc, 'sellar'); assert.match(t.node('fuBkStatus').innerHTML, /다른 탭[^]*그대로/);
  let p = 0; t.winH.beforeunload({ preventDefault(){ p++; } }); assert.equal(p, 1);
});

test('저장 중·저장 실패·미저장 검사 결과가 있으면 복원 진입 전에 막는다', async () => {
  const f = mkFile(), t = build({ file:f }); t.enter(BK); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw';
  for(const st of ['saving', 'fail', 'conflict', 'unsupported']){
    t.ev(`FUS.save = '${st}'`); t.press('bkRead'); await t.flush();
    assert.match(t.node('fuBkStatus').innerHTML, /저장|충돌|제한/, st); assert.equal(f.decs.length, 0, st); assert.equal(t.node('fuRsPreview').innerHTML, '');
  }
  t.ev("FUS.save = 'ok'; FUS.view = 'tapDone'; FUS.draft = { type:'tap', L:{ n:5, cv:null }, R:{ n:5, cv:null } }"); t.press('go', { v:'backup' });
  assert.equal(t.ev('FUS.view'), 'tapDone', '미저장 결과가 있으면 백업 화면으로 가지 않음'); assert.match(t.html(), /저장하지 않은 검사 결과/);
});

test('복호화 중 로그아웃·계정변경·화면이동·새 파일 선택이면 오래된 결과를 버리고 교체도 못 한다', async () => {
  for(const kind of ['logout', 'acc', 'nav', 'newfile']){
    let release; const gate = new Promise(r => { release = r; });
    const f = mkFile({ decrypt:async text => { await gate; return JSON.parse(text); } }), t = build({ file:f }); t.enter({ ...BK, loc:'sellar' }); gotoBackup(t);
    pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead');
    await t.flush();
    if(kind === 'logout') t.ev('followupReset()'); else if(kind === 'acc') t.S.acc = { id:'other' }; else if(kind === 'nav') t.press('go', { v:'home' }); else pickFile(t, '{"v":9}');
    release(); await t.flush(); await t.flush();
    assert.equal(t.ev('FUS.rs'), null, kind); assert.equal(t.saves, 0, kind);
    if(kind === 'newfile'){ assert.equal(t.node('fuRsPreview').innerHTML, ''); t.press('bkReplace'); await t.flush(); assert.equal(t.saves, 0); }
  }
});

test('교체 저장 중 로그아웃이면 결과를 버리고 화면 이동·중복 교체는 막으며 닫기 경고가 뜬다', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = mkFile(), t = build({ file:f, save:async () => { await gate; return { ok:true }; } }); t.enter({ ...BK, loc:'sellar' }); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  assert.ok(t.ev('FUS.busy')); let p = 0; t.winH.beforeunload({ preventDefault(){ p++; } }); assert.equal(p, 1);
  t.press('go', { v:'home' }); assert.equal(t.ev('FUS.view'), 'backup', '교체 저장 중에는 화면 이동 불가');
  t.press('bkReplace'); await t.flush(); assert.equal(t.saves, 1, '중복 교체 없음');
  t.ev('followupReset()'); release(); await t.flush(); await t.flush();
  assert.equal(t.ev('FUS.view'), 'home'); assert.equal(t.S.followup, null); assert.equal(t.ev('FUS.busy'), false);
});

test('백업 화면에서 나가거나 취소하면 비밀번호·복호화 미리보기를 지운다', async () => {
  const f = mkFile(), t = build({ file:f }); t.enter(BK); gotoBackup(t);
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.node('fuBkPass').value = 'x'; t.press('bkRead'); await t.flush();
  assert.ok(t.ev('FUS.rs')); t.press('bkCancel'); assert.equal(t.ev('FUS.rs'), null); assert.equal(t.node('fuRsPreview').innerHTML, '');
  t.press('bkRead'); await t.flush(); t.press('go', { v:'home' });
  assert.equal(t.ev('FUS.rs'), null); assert.equal(t.node('fuBkPass').value, '');
  assert.doesNotMatch(readFileSync(new URL('../js/followup-ui.js', import.meta.url), 'utf8').split('FUFile').slice(1).join(' '), /console\./, '백업 코드에 로깅 없음');
});

test('followupLeave: 사이드바 이동 시 백업 화면 정리(내보내기·복호화 결과 폐기), 교체 저장 중이면 거절', async () => {
  // 1) 암호화 도중 사이드바 이동 → 다운로드 없음, 비밀번호 비움, 홈으로
  let release; const gate = new Promise(r => { release = r; });
  const f = mkFile({ encrypt:async () => { await gate; return 'CIPHER'; } }), t = build({ file:f }); t.enter(BK); gotoBackup(t);
  t.node('fuBkPass').value = t.node('fuBkPass2').value = 'long-enough-pass'; t.press('bkExport');
  assert.equal(t.ev('followupLeave()'), true); assert.equal(t.ev('FUS.view'), 'home');
  release(); await t.flush(); await t.flush();
  assert.equal(f.downloads.length, 0); assert.equal(t.node('fuBkPass').value, '');
  // 2) 복호화 도중 이동 → 미리보기·교체 불가
  let rel2; const gate2 = new Promise(r => { rel2 = r; });
  const f2 = mkFile({ decrypt:async tx => { await gate2; return JSON.parse(tx); } }), t2 = build({ file:f2 }); t2.enter({ ...BK, loc:'sellar' }); gotoBackup(t2);
  pickFile(t2, JSON.stringify(BK)); t2.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t2.press('bkRead'); await t2.flush();
  t2.ev('followupLeave()'); rel2(); await t2.flush(); await t2.flush();
  assert.equal(t2.ev('FUS.rs'), null); assert.equal(t2.saves, 0); assert.equal(t2.state().loc, 'sellar');
  // 3) 백업 화면이 아니면 아무 일 없이 허용
  assert.equal(t2.ev('followupLeave()'), true);
});

test('교체 저장 중: 이동 거절, 취소·새 파일 선택·입력 무시, 화면 조작 잠금, 끝나면 잠금 해제·로그아웃은 항상 허용', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = mkFile(), t = build({ file:f, save:async () => { await gate; return { ok:false }; } }); t.enter({ ...BK, loc:'sellar' }); gotoBackup(t);
  const btn = { disabled:false }, inp = { disabled:false };
  t.qa['#fuRoot button, #fuRoot input, #fuRoot select, #fuRoot textarea'] = [btn, inp];
  pickFile(t, JSON.stringify(BK)); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  assert.equal(btn.disabled, true); assert.equal(inp.disabled, true);
  assert.equal(t.ev('followupLeave()'), false); assert.match(t.node('fuBkStatus').innerHTML, /교체해 저장하는 중|끝난 뒤/);
  const rs = t.ev('FUS.rs'), seq = t.ev('FUS.bkSeq');
  t.press('bkCancel'); pickFile(t, '{"v":9}'); t.change('fuLoc', 'convexity'); t.press('addMri');
  assert.equal(t.ev('FUS.rs') !== null, true, '취소 무시'); assert.equal(t.ev('FUS.bkSeq'), seq); assert.equal(t.state().loc, 'cpa', '저장 중에는 교체 대상 그대로, 다른 입력 무시'); assert.ok(rs);
  release(); await t.flush(); await t.flush();
  assert.equal(btn.disabled, false); assert.equal(inp.disabled, false);
  assert.equal(t.state().loc, 'sellar'); assert.equal(t.ev('followupLeave()'), true);
  // 로그아웃은 저장 중에도 허용
  let rel3; const g3 = new Promise(r => { rel3 = r; });
  const t3 = build({ file:mkFile(), save:async () => { await g3; return { ok:true }; } }); t3.enter(BK); gotoBackup(t3);
  pickFile(t3, JSON.stringify({ ...BK, loc:'cpa' })); t3.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t3.press('bkRead'); await t3.flush();
  t3.node('fuRsOk').checked = true; t3.press('bkReplace'); await t3.flush();
  t3.ev('followupReset()'); assert.equal(t3.ev('FUS.busy'), false); assert.equal(t3.S.followup, null);
  rel3(); await t3.flush(); await t3.flush(); assert.equal(t3.S.followup, null, '옛 저장 결과가 로그아웃 뒤 상태를 되살리지 않음');
});

test('shell.go 훅: followup 이 아닌 페이지로 갈 때 followupLeave() 가 false 면 이동하지 않는다', () => {
  assert.match(read('js/shell.js'), /page !== 'followup' && typeof followupLeave === 'function' && followupLeave\(\) === false\) return/);
});

test('세션 A 의 늦은 교체 저장 결과가 세션 B 의 교체 중 상태(busy·잠금)를 풀지 못한다', async () => {
  const rels = [], pend = [0, 1].map(() => new Promise(r => rels.push(r))); let n = 0;
  const t = build({ file:mkFile(), save:async () => { await pend[n++]; return { ok:true }; } });
  const el = { disabled:false, pre:false }, off = { disabled:true };
  t.qa['#fuRoot button, #fuRoot input, #fuRoot select, #fuRoot textarea'] = [el, off];
  const startReplace = async loc => {
    gotoBackup(t); pickFile(t, JSON.stringify({ ...BK, loc })); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.press('bkRead'); await t.flush();
    t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();
  };
  t.enter(BK); await startReplace('sellar');                       // 세션 A: 교체 저장 대기
  t.ev('followupReset()');                                         // A 로그아웃
  t.S.acc = { id:'user_b' }; t.S.masterKey = { synthetic:'b' }; t.enter(BK); // B 로그인
  await startReplace('olfactory');                                 // 세션 B: 교체 저장 대기
  assert.ok(t.ev('FUS.busy')); assert.equal(el.disabled, true);
  rels[0]();                                                       // A 의 늦은 콜백
  await t.flush(); await t.flush();
  assert.ok(t.ev('FUS.busy'), 'B 의 busy 가 유지되어야 함'); assert.equal(el.disabled, true, 'B 의 잠금 유지');
  assert.equal(t.ev('followupLeave()'), false); t.press('go', { v:'home' }); assert.equal(t.ev('FUS.view'), 'backup');
  assert.equal(t.state().loc, 'olfactory', 'A 의 결과가 B 기록을 바꾸지 않음');
  rels[1](); await t.flush(); await t.flush();
  assert.ok(!t.ev('FUS.busy')); assert.equal(off.disabled, true, '원래 비활성이던 항목은 그대로');
});

test('간단 시야 도중 화면 크기·배율·방향이 바뀌면 기록 없이 중단하고 타이머·늦은 콜백을 정리한다 (시작 전 변경은 다시 측정)', async () => {
  const t = build(); t.enter();
  let width = 600; t.ctx.window.devicePixelRatio = 2; t.ctx.window.innerWidth = 1000;
  t.node('fuField').getBoundingClientRect = () => ({ width });
  const start = () => { t.press('go', { v:'vfIntro' }); t.q['input[name="fuEye"]:checked'] = { value:'R' }; t.press('vfStart'); };
  // 시작 전 변경: 중단하지 않고 새 크기를 다시 잼
  start(); width = 480; t.winH.resize(); assert.ok(t.ev('!!FUS.test')); assert.equal(t.ev('FUS.test.fw'), 500);
  // 도중 폭 변경
  t.node('fuStageGo').h.click(); t.advance(2200); assert.ok(t.ev('!!FUS.test'));
  width = 600; t.winH.resize();
  assert.equal(t.ev('FUS.test'), null); assert.equal(t.ev('FUS.draft && FUS.draft.type'), 'vf4', 'draft 객체는 남아도');
  assert.equal(t.ev('FUS.view'), 'home'); assert.equal(t.timers, 0, '타이머 정리'); assert.equal(t.node('fuStage').hidden, true);
  assert.match(t.html(), /화면 크기나 배율이 바뀌어[^]*기록하지 않았습니다[^]*처음부터 다시/);
  t.advance(5000); await t.flush(); assert.equal(t.state().checks.length, 0, '기록 없음');
  assert.equal(t.ev('fuUnsaved()'), false, '중단된 검사는 닫기 경고도 없음');
  // 배율(dpr)만 바뀌어도 중단, 높이만(주소창) 바뀌면 유지
  start(); t.node('fuStageGo').h.click(); t.advance(2200);
  t.ctx.window.innerWidth = 1000; t.winH.resize(); assert.ok(t.ev('!!FUS.test'), '폭·배율이 같으면 유지');
  t.ctx.window.devicePixelRatio = 3; t.winH.orientationchange(); assert.equal(t.ev('FUS.test'), null);
  // 같은 조건이면 끝까지 진행해 fw 가 기록됨(회귀)
  t.ctx.window.devicePixelRatio = 2; width = 600; start(); t.node('fuStageGo').h.click();
  let n = 0; while(t.ev('!!FUS.test') && n++ < 2000){ t.advance(50); if(t.node('fuField').dataset.stim) t.node('fuField').h.pointerdown({ preventDefault(){} }); }
  t.press('saveVf'); await t.flush(); assert.equal(t.state().checks[0].fw, 600);
});

test('청신경(cpa) 위치: 보호자 관찰의 얼굴 움직임 항목이 맨 앞에 오고, 기록·질문·인쇄에 반영되며 갑작스러운 얼굴 처짐은 응급 항목으로 따로 남는다', async () => {
  const t = build(); t.enter(); t.change('fuLoc', 'cpa'); await t.flush();
  t.press('go', { v:'care' });
  const h = t.html();
  assert.ok(h.indexOf('data-care="facemv"') < h.indexOf('data-care="pers"'), 'facemv 가 앞');
  assert.match(h, /★ 웃거나 눈을 감을 때 얼굴 양쪽의 움직임이 전과 다르게 보임/); assert.match(h, /눈으로 본 것만[^]*갑자기[^]*119/);
  assert.doesNotMatch(h, /카메라로 측정|점수/);
  t.qa['#fuRoot [data-care]'] = [{ checked:true, getAttribute:() => 'facemv' }]; t.node('fuDate').value = '2026-03-01'; t.press('saveCare'); await t.flush();
  const cs = t.state().checks.filter(c => c.type === 'care'); assert.deepEqual(J(cs[0].items), ['facemv']);
  t.press('go', { v:'summary' });
  assert.match(t.html(), /얼굴 양쪽의 움직임이 전과 다르게 보인다고 기록했습니다\(2026-03-01\)/);
  assert.ok(t.ev("FU.summary(S.followup, '2026-11-11').printQuestions").some(q => /얼굴 양쪽/.test(q)), '인쇄 질문에도 남음');
  assert.ok(t.ev("FU.EMERGENCY.some(i => i.id === 'em3' && /갑자기 얼굴 한쪽이 처짐/.test(i.ko))"), '급작스러운 얼굴 처짐 119 항목 유지');
  // 다른 위치: 별표 없음, 기존(facemv 없는) 기록은 그대로 호환
  const t2 = build(); t2.enter({ v:1, loc:'convexity', next:'', mri:[], checks:[{ id:1, type:'care', date:'2026-01-01', items:['pers', 'bal'] }], meds:{ hormone:'unknown', date:'' }, nid:2 });
  assert.equal(t2.state().checks.length, 1); t2.press('go', { v:'care' }); assert.doesNotMatch(t2.html(), /★/);
  assert.doesNotMatch(t2.ev("FU.summary(S.followup, '2026-11-11').questions.join('|')"), /얼굴 양쪽/);
});

test('fuPersist: 같은 계정 재로그인 뒤 옛 세션의 늦은 저장 결과가 새 세션의 저장 상태를 덮지 못한다 (계정·키 객체를 재사용해도)', async () => {
  const rel = [], gate = () => new Promise(r => rel.push(r)); const res = [];
  const t = build({ save:async () => { const g = gate(); await g; return res.shift(); } });
  const acc = t.S.acc, key = t.S.masterKey;
  t.enter(); addMriViaUi(t, '2026-01-01', '18'); await t.flush();          // 세션 1: 저장 대기(rel[0])
  t.ev('followupReset()');                                               // 로그아웃
  t.S.acc = acc; t.S.masterKey = key;                                    // 같은 계정·같은 키 객체로 재로그인
  t.enter(); addMriViaUi(t, '2026-02-01', '19'); await t.flush();          // 세션 2: 저장 대기(rel[1])
  assert.equal(t.ev('FUS.save'), 'saving');
  res.push({ ok:true }, { ok:false }); rel[0]();                           // 옛 세션이 성공으로 늦게 끝남
  await t.flush(); await t.flush();
  assert.equal(t.ev('FUS.save'), 'saving', '옛 결과는 새 세션 상태를 바꾸지 않음');
  rel[1](); await t.flush(); await t.flush();
  assert.equal(t.ev('FUS.save'), 'fail', '새 세션 자신의 결과만 반영');
});

test('fuPersist: 연속 입력에서 더 새 저장이 먼저 끝나도 늦게 끝난 옛 저장이 상태를 덮지 않는다', async () => {
  const rel = [], res = [];
  const t = build({ save:async () => { await new Promise(r => rel.push(r)); return res.shift(); } });
  t.enter(); addMriViaUi(t, '2026-01-01', '18'); await t.flush(); addMriViaUi(t, '2026-02-01', '19'); await t.flush();
  res.push({ ok:true }, { ok:false });                                     // 새 저장(rel[1])은 성공, 옛 저장(rel[0])은 실패로 늦게 도착
  rel[1](); await t.flush(); await t.flush(); assert.equal(t.ev('FUS.save'), 'ok');
  rel[0](); await t.flush(); await t.flush(); assert.equal(t.ev('FUS.save'), 'ok', '옛 실패가 최신 성공을 덮지 않음');
  assert.equal(t.ev('fuUnsaved()'), false);
});

test('fuPersist: 다른 저장이 이 저장을 대신했다는 취소 결과가 최신 저장이면 "저장 중"에 멈추지 않고 한 번 다시 저장한다', async () => {
  const out = [{ cancelled:true, ok:false }, { ok:true }];
  const t = build({ save:async () => out.shift() }); t.enter();
  addMriViaUi(t, '2026-01-01', '18'); await t.flush(); await t.flush();
  assert.equal(t.saves, 2); assert.equal(t.ev('FUS.save'), 'ok');
  const out2 = [{ cancelled:true, ok:false }, { cancelled:true, ok:false }, { ok:true }];
  const t2 = build({ save:async () => out2.shift() }); t2.enter(); addMriViaUi(t2, '2026-01-01', '18'); await t2.flush(); await t2.flush(); await t2.flush();
  assert.equal(t2.saves, 2, '재시도는 한 번만'); assert.equal(t2.ev('FUS.save'), 'fail', '계속 취소되면 실패로 보여 다시 저장 가능');
});

test('백업 교체 저장은 더 먼저 시작한 일반 저장의 늦은 결과에 덮이지 않는다', async () => {
  const rel = [], res = [];
  const t = build({ file:mkFile(), save:async () => { await new Promise(r => rel.push(r)); return res.shift(); } });
  t.enter(BK); addMriViaUi(t, '2026-03-01', '18'); await t.flush();         // 일반 저장 대기(rel[0])
  gotoBackup(t); pickFile(t, JSON.stringify({ ...BK, loc:'sellar' })); t.node('fuRsPass').value = 'pw-pw-pw-pw-pw'; t.ev("FUS.save = ''"); t.press('bkRead'); await t.flush();
  t.node('fuRsOk').checked = true; t.press('bkReplace'); await t.flush();    // 교체 저장 대기(rel[1])
  res.push({ ok:false }, { ok:true }); rel[0](); await t.flush(); await t.flush();
  assert.equal(t.ev('FUS.save'), 'saving', '옛 일반 저장 결과 무시');
  rel[1](); await t.flush(); await t.flush(); assert.equal(t.ev('FUS.save'), 'ok');
});

test('두드리기는 스페이스바만 세고(화면·마우스·키 반복 무시), 시야 응답은 주 입력(왼쪽 버튼·첫 접점)만 센다', () => {
  const t = build(); t.enter(); t.press('go', { v:'tapIntro' }); t.press('tapStart'); t.node('fuStageGo').h.click(); t.advance(3100);
  assert.equal(t.ev('FUS.test.phase'), 'run');
  const down = (o = {}) => t.node('fuTapPad').h.pointerdown({ preventDefault(){}, ...o });
  const n = () => t.ev('FUS.test.times.length');
  t.advance(100); down(); down({ button:0, isPrimary:true, pointerType:'touch' }); assert.equal(n(), 0, '화면·마우스 입력은 세지 않음(입력 방법 통일)');
  t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); assert.equal(n(), 1, '스페이스바는 셈');
  t.docH.keydown({ key:' ', code:'Space', repeat:true, preventDefault(){} }); assert.equal(n(), 1, '키 반복 무시');
  t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); assert.equal(n(), 2);
  // 시야 응답
  t.ev('fuCancelTest()'); t.node('fuField').getBoundingClientRect = () => ({ width:600 });
  t.press('go', { v:'vfIntro' }); t.q['input[name="fuEye"]:checked'] = { value:'R' }; t.press('vfStart'); t.node('fuStageGo').h.click();
  let g = 0; while(!t.ev('FUS.test.open') && g++ < 400) t.advance(50);
  assert.ok(t.ev('FUS.test.open'));
  t.node('fuField').h.pointerdown({ preventDefault(){}, button:2 }); assert.equal(t.ev('FUS.test.pressed'), false, '우클릭은 응답 아님');
  t.node('fuField').h.pointerdown({ preventDefault(){}, button:0, isPrimary:false }); assert.equal(t.ev('FUS.test.pressed'), false, '보조 접점은 응답 아님');
  t.node('fuField').h.pointerdown({ preventDefault(){}, button:0, isPrimary:true }); assert.equal(t.ev('FUS.test.pressed'), true);
});

test('요약 복사: 클립보드 await 뒤 로그아웃·재로그인·다른 화면에서는 늦은 UI 반영(안내·화면)을 하지 않는다', async () => {
  const mk = () => { const o = {}; o.p = new Promise(r => { o.r = r; }); return o; };
  for(const kind of ['logout-relogin', 'nav']){
    const g = mk(), t = build(); t.enter(); t.ctx.navigator.clipboard.writeText = async () => { await g.p; };
    t.press('go', { v:'summary' }); t.press('exportAsk'); t.press('exportCopy');
    if(kind === 'nav') t.press('go', { v:'home' });
    else { t.ev('followupReset()'); t.enter(); t.press('go', { v:'summary' }); }
    g.r(); await t.flush(); await t.flush();
    assert.equal(t.ev('FUS.copyMsg'), '', kind + ': 늦은 복사 안내가 현재 화면에 남지 않음');
    if(kind === 'nav'){ t.press('go', { v:'summary' }); assert.doesNotMatch(t.html(), /복사했습니다/); }
    else assert.doesNotMatch(t.html(), /복사했습니다|복사하지 못했습니다/);
  }
  const g2 = mk(), t2 = build(); t2.enter(); t2.ctx.navigator.clipboard.writeText = async () => { await g2.p; };   // 정상 흐름은 유지
  t2.press('go', { v:'summary' }); t2.press('exportAsk'); t2.press('exportCopy'); g2.r(); await t2.flush(); await t2.flush();
  assert.match(t2.html(), /요약을 복사했습니다/);
});

/* 박자 두드리기: 연습 → 왼손 → 오른손. ivs = 각 손의 간격 목록(ms) */
function runRhythm(t, ivL, ivR, practice = 5){
  t.node('fuStageGo').h.click(); t.advance(3000);
  for(let i = 0; i < practice; i++){ t.advance(400); t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
  t.advance(10000);
  for(const ivs of [ivL, ivR]){
    t.node('fuStageGo').h.click(); t.advance(3000);
    let used = 0;
    t.docH.keydown({ key:' ', code:'Space', preventDefault(){} });
    for(const d of ivs){ t.advance(d); used += d; t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
    t.advance(20000 - used + 1);
  }
}
test('박자 두드리기: 연습(기록 안 함) → 왼손 20초 → 오른손 20초, 흔들림을 기록하고 기준값 전에는 "기준 만드는 중"', async () => {
  const t = build(); t.enter();
  t.change('fuLoc', 'cpa'); t.change('fuSide', 'right');
  assert.match(t.html(), /박자 두드리기/); assert.match(t.html(), /주의할 손: <b>오른손<\/b>\(종양 같은 쪽 손\)/);
  t.press('go', { v:'rhythmIntro' }); assert.match(t.html(), /편한 속도로, 같은 박자/); assert.doesNotMatch(t.html(), /규칙적으로 눌러/);
  t.press('rhythmStart'); assert.match(t.node('fuStageMsg').textContent, /연습\(기록하지 않음\)/);
  const steady = Array(30).fill(500), wob = Array.from({ length:30 }, (_, i) => i % 2 ? 430 : 570);
  runRhythm(t, steady, wob);
  assert.equal(t.node('fuStage').hidden, true); assert.match(t.html(), /박자 두드리기 결과/);
  const d = t.ev('FUS.draft'); assert.equal(d.L.cv, 0); assert.ok(d.R.cv > 10); assert.equal(d.L.valid, true);
  t.press('saveRhythm'); await t.flush();
  assert.equal(t.state().checks[0].type, 'rhythm'); assert.equal(t.state().checks[0].input, 'space');
  for(let k = 0; k < 2; k++){ t.press('go', { v:'rhythmIntro' }); t.press('rhythmStart'); runRhythm(t, steady, steady); t.press('saveRhythm'); await t.flush(); }
  assert.match(t.html(), /기준 만드는 중/);
  t.press('go', { v:'summary' }); assert.match(t.html(), /박자 두드리기/); assert.match(t.html(), /주의할 손: 오른손/);
});
test('박자 두드리기: 두 번 눌림·멈춤이 많으면 저장 버튼 없이 다시 하게 하고, 마우스·화면 입력은 세지 않는다', async () => {
  const t = build(); t.enter(); t.press('rhythmStart');
  const messy = [...Array(5).fill(500), ...Array(15).fill(500), 80, 1500, 80, 1500, 80, 1500];
  t.node('fuStageGo').h.click(); t.advance(3000); t.advance(10000);
  t.node('fuStageGo').h.click(); t.advance(3000);
  t.node('fuTapPad').h.pointerdown({ preventDefault(){} }); assert.equal(t.ev('FUS.test.times.length'), 0);
  t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); let used = 0;
  for(const d of messy){ t.advance(d); used += d; t.docH.keydown({ key:' ', code:'Space', preventDefault(){} }); }
  t.advance(20000 - used + 1);
  t.node('fuStageGo').h.click(); t.advance(3000); t.advance(20001);
  assert.match(t.html(), /다시 해 주세요/); assert.doesNotMatch(t.html(), /data-fu="saveRhythm"/);
  t.press('saveRhythm'); await t.flush(); assert.equal(t.state().checks.length, 0);
  let p = 0; t.winH.beforeunload({ preventDefault(){ p++; } }); assert.equal(p, 1, '저장하지 않은 결과가 있으면 닫기 경고');
});

test('빠르게 두드리기: 키보드 없이 화면만 누르면(5회 미만) 그 회차를 다시 하고 0회가 저장되지 않는다', () => {
  const t = build(); t.enter(); t.press('tapStart');
  t.node('fuStageGo').h.click(); t.advance(3000);
  for(let i = 0; i < 20; i++){ t.advance(100); t.node('fuTapPad').h.pointerdown({ preventDefault(){} }); }
  t.advance(10000);
  assert.equal(t.ev('FUS.test.phase'), 'ready'); assert.match(t.node('fuStageMsg').textContent, /0회만 눌려[^]*스페이스바[^]*왼손 1\/3번째/);
  assert.equal(t.ev('FUS.test.res.L.length'), 0);
});
test('잘 쓰는 손이 "모름"이면 결과에 오른손 기준으로 계산했다고 알린다', () => {
  const t = build(); t.enter();
  t.ev("FUS.draft = FU.tapRecord([48, 50, 49], [54, 53, 55]); FUS.view = 'tapDone'; fuRender()");
  assert.match(t.html(), /오른손<\/b>을 잘 쓰는 손으로 보고 계산/);
  t.ev("S.followup = FU.setHand(S.followup, 'left').state; fuRender()");
  assert.doesNotMatch(t.html(), /잘 쓰는 손으로 보고 계산/);
});
