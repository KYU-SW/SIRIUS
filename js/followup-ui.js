'use strict';
/* ═══════════════════════════════════════════════════════════
   F. 경과 관찰 — 화면
   ───────────────────────────────────────────────────────────
   · 기록은 S.followup(메모리)에 있고, 저장은 saveVault()(계정별 AES-GCM, 이 브라우저)가 맡습니다.
     이 파일은 네트워크·브라우저 저장소를 쓰지 않습니다. 자유 입력 문자열도 받지 않습니다.
   · 로그아웃·유휴 잠금·다른 계정 로그인 때는 followupReset()이 화면·타이머·검사 중 데이터를 모두 지웁니다.
   · 판정하지 않습니다. 첫 측정(기준점)과 비교해 "비슷함 / 변화 있음"만 보여 줍니다.
   ═══════════════════════════════════════════════════════════ */
const FUS = {
  view:'home', save:'', msg:'', msgOk:false, delAsk:'', exportAsk:false, copyMsg:'',
  draft:null, careOk:false, test:null, timers:new Set(), keyOn:false, opener:null, dead:false, audio:null,
  bkSeq:0, busy:false, rid:0, pid:0, copyTok:0, locked:[], rs:null, bkMsg:'', bkOk:false,   // 백업·복원: 요청 번호, 교체 저장 중, 복호화한 미리보기(종료 시 지움), 안내문
};
const fuEl = id => document.getElementById(id);
const fuNow = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const fuToday = () => FU.localDate();
const fuState = () => (S.followup = FU.clean(S.followup));
const fuLogged = () => !!(S.acc && S.masterKey);
const FU_HAND = { L:'왼손', R:'오른손' };
const FU_EYE = { R:'오른쪽', L:'왼쪽' };

/* ── 타이머·검사 정리 ── */
function fuSetTimer(fn, ms){ const id = setTimeout(() => { FUS.timers.delete(id); fn(); }, ms); FUS.timers.add(id); return id; }
function fuClearTimers(){ for(const id of FUS.timers) clearTimeout(id); FUS.timers.clear(); }
function fuAudioStop(){
  const a = FUS.audio; FUS.audio = null;
  if(a){ try{ a.osc.stop(); }catch(e){} try{ a.ctx.close(); }catch(e){} }
}
/* 무대가 열려 있는 동안 뒤의 앱 화면은 inert(클릭·포커스·스크린리더 접근 차단)로 두고, 닫으면 복구합니다 */
function fuSetInert(on){
  for(const id of ['app']){ const el = fuEl(id); if(el){ el.inert = !!on; if(on) el.setAttribute && el.setAttribute('aria-hidden', 'true'); else el.removeAttribute && el.removeAttribute('aria-hidden'); } }
}
function fuStageClose(){
  fuClearTimers(); fuAudioStop();
  FUS.test = null;
  const st = fuEl('fuStage'); if(st) st.hidden = true;
  fuSetInert(false);
  if(FUS.keyOn){ document.removeEventListener('keydown', fuStageKey, true); FUS.keyOn = false; }
  if(FUS.opener && typeof FUS.opener.focus === 'function'){ try{ FUS.opener.focus(); }catch(e){} }
  FUS.opener = null;
}
function fuCancelTest(note){
  const had = !!FUS.test;
  fuStageClose();
  if(had){ FUS.msg = note || '검사를 중단했습니다. 이번 검사는 기록하지 않았습니다.'; FUS.msgOk = false; FUS.view = 'home'; fuRender(); }
}
document.addEventListener('visibilitychange', () => { if(document.hidden && FUS.test) fuCancelTest('화면을 벗어나 검사를 중단했습니다. 이번 검사는 기록하지 않았습니다.'); });

/* 저장 실패·저장 중·검사 중·저장하지 않은 결과가 있으면 닫기/새로고침 전에 브라우저 경고를 띄웁니다 */
function fuUnsaved(){
  if(FUS.dead || !fuLogged()) return false;
  return FUS.save === 'fail' || FUS.save === 'conflict' || FUS.save === 'unsupported' || FUS.save === 'saving' || FUS.busy || !!FUS.test || (!!FUS.draft && (FUS.view === 'tapDone' || FUS.view === 'vfDone' || FUS.view === 'rhythmDone'));
}
window.addEventListener('beforeunload', e => { if(fuUnsaved()){ e.preventDefault(); e.returnValue = ''; return ''; } });

function followupEnter(){
  FUS.dead = false; FUS.pid++; FUS.copyTok++; FUS.copyMsg = ''; fuStageClose();
  fuState();
  FUS.view = 'home'; FUS.msg = ''; FUS.delAsk = ''; FUS.exportAsk = false; FUS.draft = null; FUS.save = ''; FUS.busy = false;
  fuBkClear(); fuRender();
}
function followupReset(){
  FUS.dead = true; FUS.pid++; FUS.copyTok++; FUS.busy = false; FUS.locked = [];
  fuBkClear(); fuStageClose();
  FUS.view = 'home'; FUS.save = ''; FUS.msg = ''; FUS.delAsk = ''; FUS.exportAsk = false; FUS.copyMsg = ''; FUS.draft = null; FUS.careOk = false;
  S.followup = null;
  const r = fuEl('fuRoot'); if(r) r.innerHTML = '';
  const st = fuEl('fuStage'); if(st) st.hidden = true;
  document.documentElement.classList.remove('fu-printing');
}

/* ── 저장: saveVault 결과로 상태를 보여 주고, 실패하면 메모리 값을 유지한 채 다시 저장할 수 있게 합니다 ── */
const fuSaveKind = r => r && r.ok === true ? 'ok' : (r && r.conflict ? 'conflict' : (r && r.unsupported ? 'unsupported' : 'fail'));
/* 저장 요청 세대(pid): 가장 최근 요청의 결과만 화면 상태에 반영합니다.
   세션이 바뀌면(followupEnter/Reset) 세대도 올려, 같은 계정·같은 키 객체를 재사용해도 옛 결과가 새 세션을 덮지 못합니다. */
async function fuPersist(retry){
  if(!fuLogged()) return;
  const acc = S.acc, key = S.masterKey, pid = ++FUS.pid;
  FUS.save = 'saving'; fuRenderSave();
  let r;
  try{ r = (typeof saveVault === 'function') ? await saveVault() : { ok:false }; }catch(e){ r = { ok:false }; }
  if(FUS.dead || S.acc !== acc || S.masterKey !== key || pid !== FUS.pid) return;   // 로그아웃·계정/세션 변경·더 새 저장 — 이 결과는 버립니다
  if(r && r.cancelled){                                 // 앱의 다른 저장이 이 저장을 대신함: 결과를 모르므로 한 번 다시 저장
    if(!retry) return void fuPersist(true);
    r = { ok:false };
  }
  // 성공은 r.ok 만. 다른 탭 충돌·미지원 브라우저는 일반 저장 실패와 구분합니다
  FUS.save = fuSaveKind(r);
  fuRenderSave();
}
function fuRenderSave(){
  const el = fuEl('fuSave'); if(!el) return;
  const t = { '':'', saving:'저장 중…', ok:'✓ 암호화해 이 브라우저에 저장했습니다.',
              fail:'저장하지 못했습니다. 화면에는 남아 있지만 로그아웃하면 사라질 수 있어요.',
              conflict:'다른 탭에서 이 계정의 기록이 바뀌어, 최신 기록을 보호하려고 저장을 거절했습니다. 지금 입력한 내용은 자동으로 합쳐지지 않으며, 저장되지 않았습니다. 다시 로그인한 뒤 최신 기록을 확인하고 필요한 내용을 다시 입력해 주세요.',
              unsupported:'이 브라우저는 여러 탭의 저장 충돌을 안전하게 막는 기능(탭 잠금)을 지원하지 않아 저장하지 못했습니다. 최신 Chrome·Edge·Safari에서 열어 주세요. 지금 입력한 내용은 저장되지 않았습니다.' }[FUS.save] || '';
  el.className = 'tiny ' + (FUS.save === 'fail' || FUS.save === 'conflict' || FUS.save === 'unsupported' ? 'fu-bad' : '');
  el.innerHTML = esc(t) + (FUS.save === 'fail' ? ' <button class="btn sm" data-fu="retry">다시 저장</button>' : '');
}
function fuApply(res, okMsg){
  if(!fuLogged()){ return false; }
  if(!res.ok){ FUS.msg = res.error || '입력을 확인해 주세요.'; FUS.msgOk = false; fuRender(); return false; }
  let note = okMsg || '';
  if(res.id){                                                // 날짜가 가장 빠른 새 기록은 새 기준점이 됨
    const rec = res.state.checks.find(c => c.id === res.id);
    if(rec){
      const eye = rec.eye;
      const before = FU.baseId(S.followup, rec.type, eye), after = FU.baseId(res.state, rec.type, eye);
      if(before !== null && after === res.id) note += ' 이 기록의 날짜가 가장 빨라 새 기준점이 되었습니다. 이전 기록과의 비교 결과가 달라질 수 있습니다.';
    }
  }
  S.followup = res.state; FUS.msg = note; FUS.msgOk = true;
  fuPersist(); fuRender();
  return true;
}

/* ── 공통 조각 ── */
const FU_EMERGENCY_HTML = '<div class="fu-119" role="note"><b>응급 안내</b> 갑작스러운 팔·다리 마비, 말이 어눌해짐, 얼굴 처짐, 평소와 다른 심한 두통, 갑작스러운 시력 저하가 있으면 이 앱을 쓰지 말고 <b>바로 119</b>에 연락하거나 응급실로 가세요.</div>';
function fuStatusChip(c){
  const lim = c && c.limited ? ' <span class="fu-chip" title="기준점과 검사 화면 크기가 다릅니다">화면 크기 다름 · 비교에 한계</span>' : '';
  const one = fuStatusChip1(c);
  return one + lim;
}
function fuStatusChip1(c){
  if(!c) return '<span class="fu-chip fu-none">기준점 없음</span>';
  if(c.state === 'baseline') return c.need ? `<span class="fu-chip fu-base">기준점 만드는 중 ${c.n}/2</span>` : c.n === 2 ? '<span class="fu-chip fu-base">기준점 완료 (2회 평균)</span>' : '<span class="fu-chip fu-base">기준점 기록됨</span>';
  if(c.state === 'building') return '<span class="fu-chip fu-base" title="건강인 반복 측정으로 변화 기준을 정하는 중입니다">기준 만드는 중</span>';
  if(c.state === 'same') return '<span class="fu-chip fu-same">비슷함</span>';
  return `<span class="fu-chip fu-chg">▲ 변화 있음${c.repeated ? ' · 이어짐' : ''}</span>`;
}
function fuCmp(type, eye){ const c = FU.compare(S.followup, type, eye); return c.state === 'none' ? null : c; }
/* 시야 기록(정밀 시야검사) 결과 요약. 시야 기록 모듈이 없으면(단독 테스트 등) 빈 목록 */
const fuVfExtra = () => ({ vf: (typeof VF !== 'undefined' && typeof VFS !== 'undefined' && VF.digest) ? VF.digest({ tests:VFS.tests, rules:VFS.rules }) : [] });
const FU_FIRST_EYE_KO = { left:'왼쪽으로 치우쳐 있어 <b>왼쪽 눈을 먼저</b> 검사하세요.', right:'오른쪽으로 치우쳐 있어 <b>오른쪽 눈을 먼저</b> 검사하세요.' };
function fuPreciseRow(s, optional){
  const vf = FU.cleanVf(fuVfExtra().vf);
  const chip = e => {
    const d = vf.find(x => x.eye === e);
    if(!d) return '<span class="fu-chip fu-none">기준선 없음</span>';
    if(d.state === 'none' || d.state === 'baseline') return `<span class="fu-chip fu-base">기준선 ${d.nReliable}/2</span>`;
    if(d.latest && d.latest.worse) return '<span class="fu-chip fu-chg">▲ 변화 있음</span>';
    return d.latest ? '<span class="fu-chip fu-same">비슷함</span>' : '<span class="fu-chip fu-base">기준선 완료</span>';
  };
  const first = FU_FIRST_EYE_KO[s.side] || '치우친 쪽을 모르거나 가운데이면 어느 눈부터 해도 됩니다.';
  return `<li><div><b>정밀 시야검사</b> <span class="fu-rec">${optional ? '선택' : '권장'}</span><div class="tiny">‘시야 기록’ 화면에서 한 눈씩 28~34곳의 밝기 역치를 재고 내 기준선과 비교합니다. 위치·치우친 쪽에 맞춘 검사 지도를 씁니다. ${first}</div><div class="fu-chips">${['R', 'L'].map(e => `<span class="fu-eye">${FU_EYE[e]} 눈 ${chip(e)}</span>`).join(' ')}</div></div><button class="btn sm primary" data-fu="field">시작</button></li>`;
}
const fuSel = (id, cur, opts) => `<select id="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
/** untilToday=true 이면 오늘까지만 고를 수 있습니다 (촬영일·체크 날짜). false 는 미래 날짜 가능(다음 MRI 예정일). */
const fuDateIn = (id, val, untilToday) => `<input id="${id}" type="date" value="${esc(val || '')}" min="2000-01-01" max="${untilToday ? fuToday() : '2100-12-31'}">`;

/* ── 렌더 ── */
function fuRender(){
  const root = fuEl('fuRoot'); if(!root || FUS.dead) return;
  const v = FUS.view;
  let html = '';
  if(v === 'home') html = fuHome();
  else if(v === 'tapIntro') html = fuTapIntro();
  else if(v === 'tapDone') html = fuTapDone();
  else if(v === 'vfIntro') html = fuVfIntro();
  else if(v === 'vfDone') html = fuVfDone();
  else if(v === 'sym') html = fuSymForm();
  else if(v === 'rhythmIntro') html = fuRhythmIntro();
  else if(v === 'rhythmDone') html = fuRhythmDone();
  else if(v === 'smell' || v === 'hear'){ FUS.view = 'home'; html = fuHome(); }   // 예전 화면 주소: 새 기록 없음
  else if(v === 'care') html = fuCareForm();
  else if(v === 'meds') html = fuMedsForm();
  else if(v === 'summary') html = fuSummary();
  else if(v === 'backup') html = fuBackup();
  const msg = FUS.msg ? `<div class="${FUS.msgOk ? 'okmsg' : 'err'}" role="${FUS.msgOk ? 'status' : 'alert'}">${esc(FUS.msg)}</div>` : '';
  root.innerHTML = msg + html;
  fuRenderSave(); if(v === 'backup') fuBkShow();
  if(v !== 'home') window.scrollTo({ top:0 });
}
function fuGo(view){
  if(FUS.busy) return;                                        // 교체 저장 중에는 화면을 옮기지 않음
  if(view === 'backup' && (FUS.view === 'tapDone' || FUS.view === 'vfDone' || FUS.view === 'rhythmDone') && FUS.draft){ FUS.msg = '저장하지 않은 검사 결과가 있습니다. 먼저 저장하거나 버린 뒤 백업·복원을 열어 주세요.'; FUS.msgOk = false; return fuRender(); }
  fuBkClear(); fuAudioStop(); FUS.copyTok++; FUS.view = view; FUS.msg = ''; FUS.delAsk = ''; FUS.exportAsk = false; FUS.copyMsg = ''; if(view !== 'care') FUS.careOk = false; fuRender(); }

function fuHome(){
  const s = fuState(), cfg = FU.setupFor(s.loc);
  const last = s.mri.length ? s.mri[s.mri.length - 1] : null;
  const locOpts = FU.LOCS.map(l => [l.id, l.ko]);
  const mriRows = s.mri.slice().reverse().map(m => {
    const key = 'mri:' + m.date;
    const del = FUS.delAsk === key
      ? `<span class="fu-ask">이 MRI 기록을 지울까요? <button class="btn sm danger" data-fu="delMri" data-k="${esc(m.date)}">지우기</button> <button class="btn sm" data-fu="askNo">취소</button></span>`
      : `<button class="btn sm" data-fu="askMri" data-k="${esc(m.date)}" aria-label="${esc(m.date)} MRI 기록 지우기">지우기</button>`;
    return `<tr><td>${esc(m.date)}</td><td>${m.size} mm</td><td>${del}</td></tr>`;
  }).join('');
  const core = (cfg.precise ? fuPreciseRow(s, cfg.preciseOptional) : '') + cfg.core.map(t => fuCheckRow(t, true, cfg.precise)).join('');
  const handOpts = FU.HANDS.map(x => [x.id, x.ko]);
  const sideOpts = FU.SIDES.map(x => [x.id, x.ko]);
  const extra = cfg.extra.map(t => fuCheckRow(t, false)).join('');
  const days = s.next ? Math.round(FU.dayNum(s.next) - FU.dayNum(fuToday())) : null;
  const nextNote = days === null ? '' : days >= 0 ? ` (오늘부터 ${days}일 뒤)` : ` (예정일이 ${-days}일 지났습니다. 병원에 일정을 확인해 보세요)`;
  return `${FU_EMERGENCY_HTML}
  <div class="card"><div class="card-hd"><h3>내 종양 정보</h3><span class="right" id="fuSave" role="status" aria-live="polite"></span></div><div class="card-pad">
    <p class="tiny">판독지의 내용을 보고 직접 입력합니다. 입력한 값은 계정별로 암호화해 이 브라우저에만 저장하며 서버로 보내지 않습니다.</p>
    <div class="fu-grid">
      <div class="field"><label for="fuLoc">종양 위치</label>${fuSel('fuLoc', s.loc, locOpts)}<span class="help">${esc(FU.LOCS.find(l => l.id === s.loc).hint)}. 위치를 바꾸면 아래 체크 구성이 바뀝니다.</span></div>
      <div class="field"><label for="fuSide">치우친 쪽</label>${fuSel('fuSide', s.side, sideOpts)}<span class="help">판독지 표기: <b>Rt.</b> = 오른쪽, <b>Lt.</b> = 왼쪽, <b>midline</b> = 가운데. 모르면 ‘모름’(가운데와 같은 검사 지도)을 고르세요. ${esc(FU.SIDES.find(x => x.id === s.side).hint)}.</span></div>
      <div class="field"><label for="fuHand">잘 쓰는 손</label>${fuSel('fuHand', s.hand, handOpts)}<span class="help">두드리기의 좌우 차이를 잘 쓰는 손 기준으로 계산합니다. 보통 잘 쓰는 손이 조금(약 8%) 빠릅니다.</span></div>
      <div class="field"><label for="fuNext">다음 MRI 예정일</label>${fuDateIn('fuNext', s.next)}<span class="help">${esc(s.next ? s.next + nextNote : '아직 모르면 비워 두세요.')}</span></div>
    </div>
    <h4 class="fu-h4">MRI 크기 기록 추가</h4>
    <div class="fu-grid fu-grid3">
      <div class="field"><label for="fuSize">크기 (mm)</label><input id="fuSize" type="text" inputmode="decimal" autocomplete="off" maxlength="6" placeholder="예: 18.5"><span class="help">판독지에 적힌 가장 긴 지름</span></div>
      <div class="field"><label for="fuMriDate">촬영일</label>${fuDateIn('fuMriDate', '', true)}</div>
      <div class="field fu-btnrow"><button class="btn primary" data-fu="addMri">MRI 기록 추가</button></div>
    </div>
    ${s.mri.length ? `<div class="fu-scroll"><table class="rec fu-narrow"><thead><tr><th>촬영일</th><th>크기</th><th></th></tr></thead><tbody>${mriRows}</tbody></table></div>` : '<p class="tiny">아직 입력한 MRI 기록이 없습니다.</p>'}
    ${last ? `<p class="tiny">가장 최근 입력: ${esc(last.date)} · ${last.size} mm</p>` : ''}
  </div></div>

  <div class="card"><div class="card-hd"><h3>내 위치에 맞춘 체크</h3><span class="right tiny">${esc(FU.LOCS.find(l => l.id === s.loc).ko)}</span></div><div class="card-pad">
    <p class="tiny">첫 기록(두드리기는 <b>처음 2번의 평균</b>)이 <b>기준점</b>이 됩니다. 그 뒤에는 기준점보다 나빠진 쪽으로 달라졌는지만 보여 주며 좋고 나쁨을 판단하지 않습니다. 앱은 체크 주기를 정하지 않으니 <b>담당 의료진과 정한 간격</b>으로 하세요.</p>
    <ul class="fu-list">${core}</ul>
    <details class="fu-more"><summary>그 밖에 할 수 있는 체크</summary><ul class="fu-list">${extra}</ul></details>
    <ul class="fu-list fu-list-solo"><li><div><b>약 사용 기록</b><div class="tiny">${esc(FU.HORMONE[s.meds.hormone])}${s.meds.date ? ' · ' + esc(s.meds.date) : ''}</div></div><button class="btn sm" data-fu="go" data-v="meds">기록하기</button></li></ul>
  </div></div>

  <div class="card"><div class="card-hd"><h3>MRI 크기와 체크 결과</h3><span class="right tiny">날짜별 · 단위별로 나눠 그립니다</span></div><div class="card-pad" id="fuGraph">${fuGraphHtml()}</div></div>

  <div class="card"><div class="card-hd"><h3>체크 기록</h3></div><div class="card-pad">${fuHistory()}</div></div>

  <div class="card"><div class="card-pad fu-actions">
    <button class="btn" data-fu="go" data-v="backup">백업·복원</button>
    <span class="tiny">브라우저 데이터를 지우면 기록이 사라질 수 있어, 암호화 백업 파일을 직접 보관할 수 있습니다.</span>
  </div></div>

  <div class="card"><div class="card-pad fu-actions">
    <button class="btn primary" data-fu="go" data-v="summary">진료 전 요약 보기</button>
    <span class="tiny">요약에는 의사에게 할 질문과 응급 안내가 들어 있습니다.</span>
  </div></div>`;
}
const FU_WATCH_KO = { tap:'종양 반대쪽 손', rhythm:'종양 같은 쪽 손' };
function fuWatchNote(type){
  const w = FU.watchHand(S.followup, type);
  return w ? ` 주의할 손: <b>${FU_HAND[w]}</b>(${FU_WATCH_KO[type]}).` : '';
}
function fuCheckRow(type, core, quick){
  const c = type === 'vf4' ? null : fuCmp(type);
  let chips;
  if(type === 'vf4'){ chips = ['R', 'L'].map(e => `<span class="fu-eye">${FU_EYE[e]} 눈 ${fuStatusChip(fuCmp('vf4', e))}</span>`).join(' '); }
  else chips = fuStatusChip(c);
  const desc = {
    tap:'스페이스바를 검지로 10초 동안 최대한 빠르게 누릅니다. 손마다 3번 해서 평균을 기록합니다.',
    rhythm:'스페이스바를 편한 속도로 20초 동안 같은 박자를 유지하며 누릅니다. 박자가 얼마나 일정한지 기록합니다.',
    vf4:quick ? '빠른 확인용(약 1분): 한 눈씩 위·아래·왼쪽·오른쪽 빛에 반응합니다. 정밀 시야검사를 대신하지 않습니다.'
              : '한 눈씩 가운데 점을 보며 위·아래·왼쪽·오른쪽에 나타나는 빛에 반응합니다. 정밀 시야검사가 아니며 변화 확인용입니다.',
    sym:'응급 항목과 내 위치에서 살펴볼 증상(청력·냄새 변화 포함)을 체크합니다.',
    care:'보호자가 곁에서 본 성격·행동·경련·균형의 변화를 기록합니다.',
  }[type];
  const view = { tap:'tapIntro', rhythm:'rhythmIntro', vf4:'vfIntro', sym:'sym', care:'care' }[type];
  const watch = (type === 'tap' || type === 'rhythm') ? fuWatchNote(type) : '';
  return `<li><div><b>${esc(FU.TYPE_KO[type])}</b>${core ? (type === 'vf4' && quick ? ' <span class="fu-rec">빠른 확인</span>' : ' <span class="fu-rec">권장</span>') : ''}<div class="tiny">${esc(desc)}${watch}</div><div class="fu-chips">${chips}</div></div><button class="btn sm${core ? ' primary' : ''}" data-fu="go" data-v="${view}">시작</button></li>`;
}
function fuRecLine(c){
  const hand = fuState().hand;
  if(c.type === 'tap'){
    const lr = FU.tapLR(c, hand);
    const tr = c.trials ? ` (왼손 ${c.trials.L.join('·')} / 오른손 ${c.trials.R.join('·')})` : '';
    const bad = FU.tapValid(c) ? '' : ' (10초 70회 초과: 측정 오류로 비교에서 제외)';
    return `왼손 ${c.L.n}회 · 오른손 ${c.R.n}회${tr} · 좌우 차이 ${lr === null ? '-' : lr + '%'}${bad}`;
  }
  if(c.type === 'rhythm'){
    const h = (k, nm) => `${nm} 흔들림 ${c[k].cv === null ? '-' : c[k].cv + '%'}(평균 간격 ${c[k].meanMs === null ? '-' : c[k].meanMs + 'ms'}, 실수 ${c[k].err})`;
    return `${h('L', '왼손')} · ${h('R', '오른손')}`;
  }
  if(c.type === 'vf4') return `${FU_EYE[c.eye]} 눈 · 위 ${c.seen.u}/3 · 아래 ${c.seen.d}/3 · 왼쪽 ${c.seen.l}/3 · 오른쪽 ${c.seen.r}/3 · 확인용 ${c.catch.pressed}/${c.catch.shown}회 눌림${FU.vfReliable(c) ? '' : ' (기준점 비교에서 제외)'}`;
  if(c.type === 'smell') return `왼쪽 ${FU.LEVEL3.smell[c.L]} · 오른쪽 ${FU.LEVEL3.smell[c.R]}`;
  if(c.type === 'hear') return `왼쪽 ${FU.LEVEL3.hear[c.L]} · 오른쪽 ${FU.LEVEL3.hear[c.R]}`;
  const names = c.type === 'sym' ? FU.SYM_ITEMS.reduce((m, i) => (m[i.id] = i.ko, m), {}) : FU.CARE_ITEMS.reduce((m, i) => (m[i.id] = i.ko, m), {});
  return c.items.length ? c.items.map(id => names[id]).join(' · ') : '체크한 항목 없음';
}
function fuHistory(){
  const s = fuState();
  if(!s.checks.length) return '<p class="tiny">아직 체크 기록이 없습니다. 위에서 체크를 시작하세요.</p>';
  const baseIds = new Set();
  for(const t of FU.TYPES){
    if(t === 'vf4'){ for(const e of ['R', 'L']) for(const id of FU.baseIds(s, 'vf4', e)) baseIds.add(id); }
    else for(const id of FU.baseIds(s, t)) baseIds.add(id);
  }
  const rows = s.checks.slice().reverse().map(c => {
    const key = 'chk:' + c.id;
    const em = c.type === 'sym' && FU.symEmergency(c).length ? ' <span class="fu-chip fu-chg">응급 항목 체크</span>' : '';
    const del = FUS.delAsk === key
      ? `<span class="fu-ask">${baseIds.has(c.id) ? '이 기록은 기준점입니다. 지우면 같은 종류의 다음 기록이 새 기준점이 되어 비교 결과가 달라집니다. ' : ''}지울까요? <button class="btn sm danger" data-fu="delChk" data-k="${c.id}">지우기</button> <button class="btn sm" data-fu="askNo">취소</button></span>`
      : `<button class="btn sm" data-fu="askChk" data-k="${c.id}" aria-label="${esc(c.date)} ${esc(FU.TYPE_KO[c.type])} 기록 지우기">지우기</button>`;
    return `<tr><td>${esc(c.date)}</td><td>${esc(FU.TYPE_KO[c.type])}${baseIds.has(c.id) ? ' <span class="fu-chip fu-base">기준점</span>' : ''}${em}</td><td>${esc(fuRecLine(c))}</td><td>${del}</td></tr>`;
  }).join('');
  return `<div class="fu-scroll"><table class="rec fu-hist"><thead><tr><th>날짜</th><th>체크</th><th>기록</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ── 그래프: 값 사이를 잇거나 채우지 않고 기록된 날짜에만 점을 찍습니다 ── */
const FU_MARK = [
  (x, y, c) => `<circle cx="${x}" cy="${y}" r="5" class="${c}"/>`,
  (x, y, c) => `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" class="${c}"/>`,
  (x, y, c) => `<path d="M${x} ${y - 6}L${x + 6} ${y + 5}L${x - 6} ${y + 5}Z" class="${c}"/>`,
];
const FU_GLYPH = ['●', '■', '▲'];
function fuGraphHtml(){
  const g = FU.graph(S.followup, fuVfExtra());
  if(!g.panels.length) return '<p class="tiny">MRI 크기나 체크를 기록하면 여기에 날짜별로 나타납니다.</p>';
  const W = 640, PL = 58, PR = 16, PT = 12, PB = 30, H = 150;
  const xs = d => { const n = FU.dayNum(d); return g.maxDay === g.minDay ? (PL + W - PR) / 2 : PL + (n - g.minDay) / (g.maxDay - g.minDay) * (W - PL - PR); };
  const out = [];
  for(const p of g.panels){
    const lo = p.ticks[0], hi = p.ticks[p.ticks.length - 1];
    const ys = v => PT + (H - PT - PB) * (1 - (v - lo) / ((hi - lo) || 1));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.title)} 그래프">`;
    for(const t of p.ticks) svg += `<line x1="${PL}" x2="${W - PR}" y1="${ys(t)}" y2="${ys(t)}" class="fu-grid-l"/><text x="${PL - 6}" y="${ys(t) + 4}" text-anchor="end" class="fu-tick">${t}</text>`;
    svg += `<text x="10" y="${PT + 4}" class="fu-unit">${esc(p.unit)}</text>`;
    svg += `<line x1="${PL}" x2="${PL}" y1="${PT}" y2="${H - PB}" class="fu-axis"/><line x1="${PL}" x2="${W - PR}" y1="${H - PB}" y2="${H - PB}" class="fu-axis"/>`;
    const first = g.dates[0], lastD = g.dates[g.dates.length - 1];
    svg += `<text x="${PL}" y="${H - 8}" class="fu-tick">${esc(first)}</text>`;
    if(lastD !== first) svg += `<text x="${W - PR}" y="${H - 8}" text-anchor="end" class="fu-tick">${esc(lastD)}</text>`;
    p.series.forEach((se, i) => {
      for(const q of se.pts){
        const dx = (i - (p.series.length - 1) / 2) * 6;
        svg += `<g><title>${esc(se.label)} ${esc(q.date)}: ${q.v}${esc(p.unit)}${q.unreliable ? (p.id === 'vfx' ? ' (신뢰도 낮음, 비교에서 제외)' : ' (확인용 응답이 많아 비교에서 제외)') : ''}</title>${FU_MARK[i % 3](Math.round((xs(q.date) + dx) * 10) / 10, Math.round(ys(q.v) * 10) / 10, 'fu-pt fu-s' + (i % 3) + (q.unreliable ? ' fu-hollow' : ''))}</g>`;
      }
    });
    svg += '</svg>';
    const legend = p.series.map((se, i) => `<span class="fu-lg fu-s${i % 3}t">${FU_GLYPH[i % 3]} ${esc(se.label)}</span>`).join(' ');
    const note = p.id === 'mri' ? ' · 0에서 시작하지 않음' : p.id === 'vfx' ? ' · 눈마다 지금 비교에 쓰는 지도(mapId)의 기록만 · 속 빈 점은 신뢰도 낮음' : '';
    out.push(`<figure class="fu-fig"><figcaption><b>${esc(p.title)}</b> <span class="tiny">(눈금 단위: ${esc(p.unit)}${note})</span></figcaption>${svg}<div class="tiny fu-legend">${legend}</div></figure>`);
  }
  const cr = g.crossing.cross ? `<div class="fu-cross" role="note"><b>영상과 체크가 엇갈려 보여요.</b> ${esc(g.crossing.text)}</div>`
    : g.crossing.undetermined ? `<p class="tiny" role="note">엇갈림 판단 불가: ${esc(g.crossing.text)}</p>` : '';
  return `${cr}<div class="fu-figs">${out.join('')}</div><p class="tiny">점만 찍으며 기록하지 않은 날의 값을 추정해 잇지 않습니다. 그래프는 변화 확인용이고 진단이 아닙니다.</p>`;
}

/* ── 빠르게 두드리기 (스페이스바만 · 손마다 10초 × 3번 · 사이 5초 쉬기 · 평균 저장) ── */
const FU_KEY_ONLY = '키보드의 <b>스페이스바</b>를 <b>검지 하나</b>로 누릅니다. 화면을 누르거나 마우스를 쓰는 값은 세지 않습니다(입력 방법이 섞이면 비교할 수 없기 때문).';
/* 키보드가 없어 보이는 기기(터치 위주 휴대폰·태블릿)면 시작 전에 알림. 키보드를 연결한 태블릿도 있어 막지는 않음 */
function fuKeyboardWarn(){
  let touchOnly = false;
  try{ touchOnly = !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches); }catch(e){}
  return touchOnly ? '<p class="err" role="alert"><b>키보드가 있는 컴퓨터에서 해 주세요.</b> 이 검사는 스페이스바 입력만 셉니다. 화면을 누르면 세지 않아 다시 하게 됩니다.</p>' : '';
}
function fuHandNote(){
  return fuState().hand === 'unknown' ? '<p class="tiny">잘 쓰는 손을 고르지 않아 <b>오른손</b>을 잘 쓰는 손으로 보고 계산했습니다. 홈의 "잘 쓰는 손"에서 바꿀 수 있습니다.</p>' : '';
}
function fuTapIntro(){
  return `${FU_EMERGENCY_HTML}<div class="card"><div class="card-hd"><h3>빠르게 두드리기</h3></div><div class="card-pad">${fuKeyboardWarn()}
    <ol class="fu-steps"><li>편하게 앉아 키보드가 있는 기기를 책상에 두세요.</li><li>${FU_KEY_ONLY}</li><li>왼손 → 오른손 순서로, 손마다 <b>10초씩 3번</b> 최대한 빠르게 누릅니다. 사이에 5초 쉽니다.</li><li>3번의 평균과 좌우 차이가 기록됩니다. 10초에 ${FU.TAP_MAX}회를 넘으면 측정 오류로 보고 그 회차를 다시 합니다.</li></ol>
    <p class="tiny">같은 기기·같은 자세로 하면 기준점과 비교하기 쉽습니다. 처음 2번 기록의 평균이 기준점이 됩니다.${fuWatchNote('tap')} 검사 도중 화면을 벗어나면 이번 검사는 기록하지 않고 중단합니다.</p>
    <div class="fu-actions"><button class="btn primary" data-fu="tapStart">시작</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div></div></div>`;
}
function fuStageOpen(title){
  const st = fuEl('fuStage'); if(!st) return;
  FUS.opener = document.activeElement || null;
  fuEl('fuStageTitle').textContent = title;
  st.hidden = false;
  fuSetInert(true);
  if(!FUS.keyOn){ document.addEventListener('keydown', fuStageKey, true); FUS.keyOn = true; }
}
function fuStageSet({ msg = '', count = '', go = '', pad = false, field = false } = {}){
  fuEl('fuStageMsg').textContent = msg;
  fuEl('fuStageCount').textContent = count;
  const b = fuEl('fuStageGo'); b.hidden = !go; b.textContent = go;
  fuEl('fuTapPad').hidden = !pad; fuEl('fuField').hidden = !field;
  if(go){ try{ b.focus(); }catch(e){} }
}
function fuStageKey(e){
  if(!FUS.test) return;
  if(e.key === 'Escape'){ e.preventDefault(); fuCancelTest(); return; }
  if(e.key === 'Tab'){                                   // 포커스가 무대 밖으로 나가지 않게 순환
    const f = ['fuStageGo', 'fuTapPad', 'fuStageCancel'].map(fuEl).filter(x => x && !x.hidden);
    e.preventDefault();
    if(!f.length) return;
    const i = f.indexOf(document.activeElement);
    const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
    try{ f[n].focus(); }catch(err){}
    return;
  }
  if(e.key === ' ' || e.code === 'Space'){
    const t = FUS.test;
    if(t.phase === 'run' || t.phase === 'trial'){ e.preventDefault(); if(!e.repeat) fuPress(true); }   // 누르고 있는 키 반복은 세지 않음
  }
}
/** fromKey: 스페이스바에서 왔는지. 두드리기·박자 두드리기는 스페이스바만 셉니다. 간단 시야는 화면 누르기도 받습니다. */
function fuPress(fromKey){
  const t = FUS.test; if(!t) return;
  if((t.kind === 'tap' || t.kind === 'rhythm') && t.phase === 'run'){
    if(!fromKey) return;
    const dt = fuNow() - t.t0;
    if(dt >= 0 && dt <= t.dur){ t.times.push(dt); fuEl('fuStageCount').textContent = `${t.times.length}회`; }
  } else if(t.kind === 'vf4' && t.phase === 'trial' && t.open){
    t.pressed = true;
  }
}
function fuTapStart(){
  FUS.test = { kind:'tap', hand:'L', trial:0, res:{ L:[], R:[] }, phase:'ready', times:[], t0:0, dur:FU.TAP_MS, note:'' };
  fuStageOpen('빠르게 두드리기');
  fuTapReady();
}
const fuTapLabel = t => `${FU_HAND[t.hand]} ${t.trial + 1}/${FU.TAP_TRIALS}번째`;
function fuTapReady(){
  const t = FUS.test; if(!t) return;
  t.phase = 'ready'; t.times = [];
  fuStageSet({ msg:`${t.note}${fuTapLabel(t)}: 검지를 스페이스바에 올리세요. 시작을 누르면 3초 뒤 10초가 시작됩니다.`, go:'시작' });
  t.note = '';
}
function fuTapCountdown(){
  const t = FUS.test; if(!t) return;
  t.phase = 'count';
  fuStageSet({ msg:`${fuTapLabel(t)} — 곧 시작합니다`, count:'3' });
  fuSetTimer(() => fuStageSet({ msg:`${fuTapLabel(t)} — 곧 시작합니다`, count:'2' }), 1000);
  fuSetTimer(() => fuStageSet({ msg:`${fuTapLabel(t)} — 곧 시작합니다`, count:'1' }), 2000);
  fuSetTimer(fuTapRun, 3000);
}
function fuTapRun(){
  const t = FUS.test; if(!t) return;
  t.phase = 'run'; t.t0 = fuNow(); t.times = [];
  fuStageSet({ msg:`${fuTapLabel(t)}: 스페이스바를 최대한 빠르게! (10초)`, count:'0회' });
  fuSetTimer(fuTapEnd, FU.TAP_MS);
}
function fuTapEnd(){
  const t = FUS.test; if(!t) return;
  t.phase = 'between';
  const m = FU.tapMetrics(t.times);
  if(m.over){                                               // 70회 초과: 측정 오류 → 같은 회차를 다시
    t.note = `10초에 ${m.n}회가 눌려 측정 오류로 보고 이 회차를 다시 합니다. 검지 하나로만 눌러 주세요. `;
    return fuTapReady();
  }
  if(m.under){                                              // 5회 미만: 스페이스바를 거의 누르지 않음(키보드 없음 등) → 같은 회차를 다시
    t.note = `10초에 ${m.n}회만 눌려 이 회차를 다시 합니다. 화면이 아니라 키보드의 스페이스바를 눌러 주세요. `;
    return fuTapReady();
  }
  t.res[t.hand].push(m.n);
  if(t.trial < FU.TAP_TRIALS - 1){                           // 같은 손 다음 회차: 5초 쉬고 자동으로 준비
    t.trial++; t.phase = 'rest';
    const sec = Math.round(FU.TAP_REST_MS / 1000);
    for(let i = 0; i < sec; i++) fuSetTimer(() => fuStageSet({ msg:`쉬세요. 다음은 ${fuTapLabel(t)}입니다.`, count:`${sec - i}` }), i * 1000);
    fuSetTimer(fuTapCountdown, FU.TAP_REST_MS);
    return;
  }
  if(t.hand === 'L'){ t.hand = 'R'; t.trial = 0; fuTapReady(); return; }
  FUS.draft = FU.tapRecord(t.res.L, t.res.R);
  fuStageClose(); FUS.view = 'tapDone'; fuRender();
}
function fuTapDone(){
  const d = FUS.draft; if(!d || d.type !== 'tap') return '<div class="card"><div class="card-pad">기록할 결과가 없습니다. <button class="btn" data-fu="go" data-v="home">돌아가기</button></div></div>';
  const lr = FU.tapLR(d, fuState().hand);
  return `<div class="card"><div class="card-hd"><h3>빠르게 두드리기 결과</h3></div><div class="card-pad">
    <div class="fu-scroll"><table class="rec"><thead><tr><th></th><th>1번</th><th>2번</th><th>3번</th><th>평균 (10초)</th></tr></thead><tbody>
      ${['L', 'R'].map(k => `<tr><td>${FU_HAND[k]}</td>${[0, 1, 2].map(i => `<td>${d.trials && d.trials[k][i] !== undefined ? d.trials[k][i] + '회' : '-'}</td>`).join('')}<td><b>${d[k].n}회</b></td></tr>`).join('')}</tbody></table></div>
    <p>좌우 차이(잘 쓰는 손 기준): <b>${lr === null ? '-' : lr + '%'}</b></p>${fuHandNote()}
    <p class="tiny">숫자만으로 의미를 판단하지 않습니다. 처음 2번 기록의 평균이 기준점이 되고, 이후 기록은 기준점보다 줄었는지만 비교합니다. 방해가 있었다면 다시 하세요.</p>
    <div class="fu-actions"><button class="btn primary" data-fu="saveTap">이 결과 기록하기</button><button class="btn" data-fu="tapStart">다시 하기</button><button class="btn ghost" data-fu="discard">기록하지 않고 닫기</button></div></div></div>`;
}

/* ── 박자 두드리기 (스페이스바만 · 연습 10초(저장 안 함) → 왼손 20초 → 오른손 20초) ──
   흔들림(cv)이 측정값이므로 "규칙적으로 누르라"는 경고를 하지 않습니다. 실수(두 번 눌림·멈춤·너무 적음)만 다시 하게 합니다. */
function fuRhythmIntro(){
  return `${FU_EMERGENCY_HTML}<div class="card"><div class="card-hd"><h3>박자 두드리기</h3></div><div class="card-pad">${fuKeyboardWarn()}
    <ol class="fu-steps"><li>${FU_KEY_ONLY}</li><li><b>편한 속도로, 같은 박자를 유지하며</b> 누르세요. 빨리 누르는 검사가 아닙니다.</li><li>먼저 10초 연습(기록하지 않음), 그다음 왼손 20초 → 오른손 20초입니다.</li><li>누르는 간격이 얼마나 일정한지(흔들림 %)가 기록됩니다. 두 번 눌림·멈춤이 많으면 다시 하게 됩니다.</li></ol>
    <p class="tiny">처음 2번 기록의 평균이 기준점이 됩니다.${fuWatchNote('rhythm')} 변화 기준은 건강한 사람의 반복 측정으로 정하는 중이라, 그 전까지는 숫자만 기록하고 "기준 만드는 중"으로 보여 줍니다.</p>
    <div class="fu-actions"><button class="btn primary" data-fu="rhythmStart">시작</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div></div></div>`;
}
const FU_RHY_STEPS = ['P', 'L', 'R'];
const fuRhyLabel = st => st === 'P' ? '연습(기록하지 않음)' : FU_HAND[st];
function fuRhythmStart(){
  FUS.test = { kind:'rhythm', step:0, res:{}, phase:'ready', times:[], t0:0, dur:FU.RHY.practiceMs };
  fuStageOpen('박자 두드리기');
  fuRhythmReady();
}
function fuRhythmReady(){
  const t = FUS.test; if(!t) return;
  const st = FU_RHY_STEPS[t.step];
  t.phase = 'ready'; t.times = []; t.dur = st === 'P' ? FU.RHY.practiceMs : FU.RHY.ms;
  fuStageSet({ msg:`${fuRhyLabel(st)}: 검지를 스페이스바에 올리세요. 시작을 누르면 3초 뒤 ${t.dur / 1000}초 동안 편한 박자로 누릅니다.`, go:'시작' });
}
function fuRhythmCountdown(){
  const t = FUS.test; if(!t) return;
  const lb = fuRhyLabel(FU_RHY_STEPS[t.step]);
  t.phase = 'count';
  fuStageSet({ msg:`${lb} — 곧 시작합니다`, count:'3' });
  fuSetTimer(() => fuStageSet({ msg:`${lb} — 곧 시작합니다`, count:'2' }), 1000);
  fuSetTimer(() => fuStageSet({ msg:`${lb} — 곧 시작합니다`, count:'1' }), 2000);
  fuSetTimer(fuRhythmRun, 3000);
}
function fuRhythmRun(){
  const t = FUS.test; if(!t) return;
  t.phase = 'run'; t.t0 = fuNow(); t.times = [];
  fuStageSet({ msg:`${fuRhyLabel(FU_RHY_STEPS[t.step])}: 편한 속도로 같은 박자를 유지하며 누르세요. (${t.dur / 1000}초)`, count:'0회' });
  fuSetTimer(fuRhythmEnd, t.dur);
}
function fuRhythmEnd(){
  const t = FUS.test; if(!t) return;
  t.phase = 'between';
  const st = FU_RHY_STEPS[t.step];
  if(st !== 'P') t.res[st] = FU.rhythmMetrics(t.times, FU.RHY.ms);
  if(t.step < FU_RHY_STEPS.length - 1){ t.step++; return fuRhythmReady(); }
  FUS.draft = { type:'rhythm', L:t.res.L, R:t.res.R, input:'space' };
  fuStageClose(); FUS.view = 'rhythmDone'; fuRender();
}
function fuRhythmDone(){
  const d = FUS.draft; if(!d || d.type !== 'rhythm') return '<div class="card"><div class="card-pad">기록할 결과가 없습니다. <button class="btn" data-fu="go" data-v="home">돌아가기</button></div></div>';
  const ok = FU.rhythmValid(d);
  const why = k => d[k].valid ? '' : `${FU_HAND[k]}: 두 번 눌림·멈춤이 많거나 누른 횟수가 적어(실수 ${d[k].err}회) 결과를 쓰기 어렵습니다.`;
  const row = k => `<tr><td>${FU_HAND[k]}</td><td>${d[k].cv === null ? '-' : d[k].cv + '%'}</td><td>${d[k].meanMs === null ? '-' : d[k].meanMs + 'ms'}</td><td>${d[k].err}회</td><td>${d[k].valid ? '사용 가능' : '다시 필요'}</td></tr>`;
  return `<div class="card"><div class="card-hd"><h3>박자 두드리기 결과</h3></div><div class="card-pad">
    <div class="fu-scroll"><table class="rec"><thead><tr><th></th><th>흔들림 (낮을수록 일정)</th><th>평균 간격</th><th>실수</th><th></th></tr></thead><tbody>${row('L')}${row('R')}</tbody></table></div>
    ${ok ? '' : `<p class="err" role="alert">${esc([why('L'), why('R')].filter(Boolean).join(' '))} 다시 해 주세요.</p>`}
    <p class="tiny">흔들림 = 누르는 간격의 표준편차 ÷ 평균 간격 × 100. 처음 5개 간격과 실수(0.15초보다 짧은 간격, 보통 간격의 2배보다 긴 멈춤)는 뺐습니다. 숫자만으로 의미를 판단하지 않습니다.</p>
    <div class="fu-actions">${ok ? '<button class="btn primary" data-fu="saveRhythm">이 결과 기록하기</button>' : ''}<button class="btn${ok ? '' : ' primary'}" data-fu="rhythmStart">다시 하기</button><button class="btn ghost" data-fu="discard">기록하지 않고 닫기</button></div></div></div>`;
}

/* ── 간단 시야 (한 눈씩 · 4방향) ── */
function fuVfIntro(){
  const eyes = ['R', 'L'].map(e => { const c = fuCmp('vf4', e); return `<label class="fu-radio"><input type="radio" name="fuEye" value="${e}"${(FUS.draft && FUS.draft.eye === e) || (!FUS.draft && e === 'R') ? ' checked' : ''}> ${FU_EYE[e]} 눈 ${fuStatusChip(c)}</label>`; }).join('');
  return `${FU_EMERGENCY_HTML}<div class="card"><div class="card-hd"><h3>간단 시야 체크</h3></div><div class="card-pad">
    <ol class="fu-steps"><li>검사할 눈의 반대쪽 눈을 손바닥으로 가리세요. 안경·렌즈는 평소대로 씁니다.</li><li>화면에서 40~50 cm 떨어져 앉고, <b>가운데 점만 계속</b> 바라보세요.</li><li>위·아래·왼쪽·오른쪽 가장자리에 작은 빛이 잠깐 켜집니다. <b>보이면 바로 스페이스바나 화면을 누르세요.</b></li><li>빛이 없는데도 누를 수 있는 확인용 순서가 2번 섞여 있습니다. 한 눈에 약 1분 걸립니다.</li><li>기기, 창 크기, 확대 비율, 화면과의 거리를 바꾸면 이전 기록과 비교하기 어렵습니다. 같은 조건으로 하세요.</li></ol>
    <p class="tiny">정밀 시야검사가 아닙니다. 기기·밝기·거리에 따라 값이 달라질 수 있어 같은 조건으로 하고 <b>나의 첫 측정과만</b> 비교합니다. 눈을 옮기며 빛을 찾지 마세요.</p>
    <fieldset class="fu-fs"><legend>검사할 눈</legend>${eyes}</fieldset>
    <div class="fu-actions"><button class="btn primary" data-fu="vfStart">시작</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div></div></div>`;
}
function fuVfStart(){
  const sel = document.querySelector('input[name="fuEye"]:checked');
  const eye = sel && sel.value === 'L' ? 'L' : 'R';
  FUS.draft = { type:'vf4', eye };
  FUS.test = { kind:'vf4', eye, plan:FU.vfPlan(), i:0, results:[], phase:'ready', open:false, pressed:false };
  fuStageOpen(`간단 시야 · ${FU_EYE[eye]} 눈`);
  fuStageSet({ msg:`${eye === 'R' ? '왼쪽' : '오른쪽'} 눈을 가리고 가운데 점을 보세요. 준비되면 시작을 누르세요.`, go:'시작', field:true });
  fuEl('fuField').dataset.stim = '';
  fuVfMeasure();                                    // 검사 화면 크기 기록(기기·창 크기가 바뀌면 비교에 한계)
}
/* 검사 화면 기하(자극 칸 너비·배율·창 너비) — 검사 도중 바뀌면 같은 측정에 다른 조건이 섞이므로 중단합니다 */
function fuVfGeom(){
  let w = null; try{ const r = fuEl('fuField').getBoundingClientRect().width; if(r > 0) w = r; }catch(e){}
  return { w, dpr:window.devicePixelRatio || null, iw:window.innerWidth || null };
}
function fuVfMeasure(){
  const t = FUS.test; if(!t) return;
  t.geo = fuVfGeom(); delete t.fw;
  if(t.geo.w){ const w = Math.round(t.geo.w / 50) * 50; if(w >= 100 && w <= 3000) t.fw = w; }
}
function fuOnResize(){
  const t = FUS.test; if(!t || t.kind !== 'vf4') return;
  if(t.phase === 'ready'){ fuVfMeasure(); return; }          // 시작 전: 새 크기로 다시 잼
  const a = t.geo || {}, b = fuVfGeom();
  const moved = (x, y) => x != null && y != null && Math.abs(x - y) >= 8;
  const changed = a.w != null && b.w != null ? moved(a.w, b.w) : moved(a.iw, b.iw);
  if(changed || (a.dpr != null && b.dpr != null && a.dpr !== b.dpr))
    fuCancelTest('화면 크기나 배율이 바뀌어 시야 검사를 중단했습니다. 이번 검사는 기록하지 않았습니다. 같은 조건에서 처음부터 다시 시작해 주세요.');
}
window.addEventListener('resize', fuOnResize);
window.addEventListener('orientationchange', fuOnResize);
function fuVfNext(){
  const t = FUS.test; if(!t) return;
  if(t.i >= t.plan.length){ fuVfFinish(); return; }
  t.phase = 'trial'; t.open = false; t.pressed = false;
  const tr = t.plan[t.i];
  fuStageSet({ msg:`가운데 점을 보세요. 빛이 보이면 누르세요. (${t.i + 1}/${t.plan.length})`, field:true });
  fuSetTimer(() => {
    if(!FUS.test) return;
    t.open = true;
    if(tr.dir) fuEl('fuField').dataset.stim = tr.dir;
    fuSetTimer(() => { const f = fuEl('fuField'); if(f) f.dataset.stim = ''; }, 300);
    fuSetTimer(() => {
      if(FUS.test !== t) return;                                  // 중단된 검사의 늦은 콜백은 무시
      t.open = false; t.results.push({ dir:tr.dir, pressed:t.pressed }); t.i++;
      fuVfNext();
    }, 1500);
  }, tr.wait);
}
function fuVfFinish(){
  const t = FUS.test; if(!t) return;
  const sc = FU.vfScore(t.results);
  FUS.draft = { type:'vf4', eye:t.eye, seen:sc.seen, catch:sc.catch };
  if(t.fw) FUS.draft.fw = t.fw;
  fuStageClose(); FUS.view = 'vfDone'; fuRender();
}
function fuVfDone(){
  const d = FUS.draft; if(!d || d.type !== 'vf4' || !d.seen) return '<div class="card"><div class="card-pad">기록할 결과가 없습니다. <button class="btn" data-fu="go" data-v="home">돌아가기</button></div></div>';
  const rel = FU.vfReliable(d);
  return `<div class="card"><div class="card-hd"><h3>간단 시야 결과 · ${FU_EYE[d.eye]} 눈</h3></div><div class="card-pad">
    <div class="fu-scroll"><table class="rec fu-narrow"><thead><tr><th>방향</th><th>보인 횟수</th></tr></thead><tbody>${FU.DIRS.map(k => `<tr><td>${FU.DIR_KO[k]}</td><td>${d.seen[k]} / 3</td></tr>`).join('')}</tbody></table></div>
    <p>확인용(빛 없음) ${d.catch.shown}번 중 <b>${d.catch.pressed}번</b> 눌렀습니다.${rel ? '' : ' 눌린 횟수가 많아 이 결과는 기준점 비교에서 제외됩니다. 다시 해 보세요.'}</p>
    <p class="tiny">숫자만으로 의미를 판단하지 않습니다. 첫 측정이 기준점이 되고, 이후 기록과 차이만 비교합니다.</p>
    <div class="fu-actions"><button class="btn primary" data-fu="saveVf">이 결과 기록하기</button><button class="btn" data-fu="go" data-v="vfIntro">다시 하기</button><button class="btn ghost" data-fu="discard">기록하지 않고 닫기</button></div></div></div>`;
}

/* ── 증상·보호자·약 (후각·청력은 증상 기록의 항목으로만 남김) ── */
function fuSymForm(){
  const cfg = FU.setupFor(fuState().loc);
  const box = i => `<label class="fu-check${i.em ? ' fu-em' : ''}"><input type="checkbox" data-sym="${i.id}"${i.needsCare && !FUS.careOk ? ' disabled' : ''}> <span>${esc(i.ko)}</span></label>`;
  const rest = cfg.sym.filter(i => !i.em);
  const careBox = rest.some(i => i.needsCare) ? `<label class="fu-check fu-careok"><input type="checkbox" id="fuCareOk"${FUS.careOk ? ' checked' : ''}> <span><b>보호자가 지금 옆에 있습니다</b> (균형 항목은 보호자가 있을 때만 확인하세요)</span></label>` : '';
  return `<div class="card"><div class="card-hd"><h3>증상 기록</h3></div><div class="card-pad">
    <div id="fuEmBanner" role="alert" hidden>${FU_EMERGENCY_HTML}<p><b>응급 항목을 체크했습니다. 기록보다 먼저 119에 연락하거나 응급실로 가세요.</b></p></div>
    <fieldset class="fu-fs fu-fs-em"><legend>지금 있는 응급 증상 (해당하면 체크)</legend>${FU.EMERGENCY.map(box).join('')}</fieldset>
    <fieldset class="fu-fs"><legend>최근 느낀 것</legend>${careBox}${rest.map(box).join('')}</fieldset>
    <div class="field"><label for="fuDate">날짜</label>${fuDateIn('fuDate', fuToday(), true)}</div>
    <div class="fu-actions"><button class="btn primary" data-fu="saveSym">기록하기</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div>
    <p class="tiny">체크한 항목이 없어도 “없음”으로 기록됩니다. 이 기록은 진단이 아니며 진료 때 보여 드리는 자료입니다.</p></div></div>`;
}
function fuCareForm(){
  const cfg = FU.setupFor(fuState().loc);
  return `<div class="card"><div class="card-hd"><h3>보호자 관찰 기록</h3></div><div class="card-pad">
    <p class="tiny">본인이 알아채기 어려운 변화를 곁에서 본 사람이 기록합니다. 보고 느낀 것만 체크하세요.</p>
    ${cfg.careFocus.length ? `<p class="tiny"><b>${esc(FU.LOCS.find(l => l.id === cfg.loc).ko)}</b> 위치에서는 표시된 항목을 특히 살펴보세요. 카메라나 사진으로 재지 않고, 곁에서 눈으로 본 것만 체크합니다.</p>` : ''}
    <fieldset class="fu-fs"><legend>최근 본 것</legend>${cfg.care.map(i => `<label class="fu-check"><input type="checkbox" data-care="${i.id}"> <span>${cfg.careFocus.includes(i.id) ? '★ ' : ''}${esc(i.ko)}</span></label>`).join('')}</fieldset>
    <p class="tiny">얼굴이 <b>갑자기</b> 처지거나 말이 어눌해지면 여기에 기록하지 말고 바로 119에 연락하세요.</p>
    <div class="field"><label for="fuDate">날짜</label>${fuDateIn('fuDate', fuToday(), true)}</div>
    <div class="fu-actions"><button class="btn primary" data-fu="saveCare">기록하기</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div>
    <p class="tiny">경련이 있었거나 갑자기 달라진 모습이 있으면 기록보다 먼저 병원에 연락하세요. 응급이면 119입니다.</p></div></div>`;
}
function fuMedsForm(){
  const m = fuState().meds;
  return `<div class="card"><div class="card-hd"><h3>약 사용 기록</h3></div><div class="card-pad">
    <p>피임 주사제(<b>메드록시프로게스테론</b>, 예: 데포 계열)는 2024~2025년에 수막종 위험 경고가 추가되었습니다. 이 앱은 사용 여부를 기록해 진료 요약에 넣을 뿐이며, <b>약 사용을 바꾸라는 안내는 하지 않습니다. 담당 의사에게 꼭 알리세요.</b></p>
    <fieldset class="fu-fs"><legend>사용 여부</legend>${Object.entries(FU.HORMONE).map(([k, t]) => `<label class="fu-radio"><input type="radio" name="fuHormone" value="${k}"${k === m.hormone ? ' checked' : ''}> ${esc(t)}</label>`).join('')}</fieldset>
    <div class="field"><label for="fuMedDate">마지막으로 맞은(복용한) 날 (모르면 비워 두세요)</label>${fuDateIn('fuMedDate', m.date, true)}</div>
    <div class="fu-actions"><button class="btn primary" data-fu="saveMeds">기록하기</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div></div></div>`;
}

/* ── 진료 전 요약 ── */
/* 요약 표의 비교 칸 문구 (고정 문구 + 숫자) */
function fuCmpWord(c){
  if(c.state === 'baseline') return c.need ? `기준점 만드는 중 (${c.n}/2)` : '기준점만 있음';
  if(c.state === 'building') return '기준 만드는 중 (변화 기준을 건강인 측정으로 정하는 중)';
  if(c.state === 'same') return '비슷함';
  return '변화 있음';
}
function fuSummaryText(m){
  const L = [];
  L.push('SIRIUS 경과 관찰 요약 (진단이 아닌 자가 기록)');
  L.push(`종양 위치: ${m.locKo} · 치우친 쪽: ${m.sideKo} · 잘 쓰는 손: ${m.handKo}`);
  L.push(`다음 MRI 예정일: ${m.next || '미정'}`);
  if(m.mri.length){ L.push('MRI 크기 기록:'); for(const x of m.mri) L.push(`- ${x.date} ${x.size} mm`); }
  if(m.vfLines.length){ L.push('정밀 시야검사(앱 점수, 내 기준선과 비교):'); for(const x of m.vfLines) L.push(`- ${x}`); }
  L.push(`약 사용 기록(메드록시프로게스테론 주사 등): ${m.hormoneKo}${m.hormoneDate ? ' (' + m.hormoneDate + ')' : ''}`);
  if(m.compare.length){
    L.push('첫 측정(기준점)과의 비교:');
    for(const c of m.compare) L.push(`- ${c.name}${c.watchKo ? ` (주의할 손: ${c.watchKo})` : ''}: ${fuCmpWord(c)}${c.state === 'changed' ? ' — ' + c.reasons.join(', ') : ''}${c.notes.length ? ' · 참고: ' + c.notes.join(', ') : ''}`);
  }
  if(m.crossing.cross || m.crossing.undetermined) L.push(`참고: ${m.crossing.text}`);
  if(m.emergencyItems.length) L.push(`응급 항목 체크(${m.emergencyDate}): ${m.emergencyItems.join(', ')}`);
  if(m.emergencyDates.length) L.push(`과거에 응급 항목을 체크한 날짜: ${m.emergencyDates.join(', ')}`);
  for(const c of m.compare) if(c.limited) L.push(`참고(${c.name}): ${c.limitNote}`);
  L.push('의사에게 할 질문:'); m.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  L.push('응급: 갑작스러운 마비·말 어눌함·얼굴 처짐·심한 두통·급격한 시력 저하는 119.');
  return L.join('\n');
}
/* 인쇄·PDF용 한 페이지 요약: 최근 MRI 3개 · 기능은 기준점과 최근 · 질문 · 안전 안내만. 전체 자료는 화면에 둡니다. */
function fuPrintCompact(m){
  const mri = m.mriRecent.length ? m.mriRecent.map(x => `${esc(x.date)} ${x.size} mm`).join(' · ') : '입력한 기록 없음';
  const cmp = m.compare.length ? `<table class="rec"><thead><tr><th>체크</th><th>기준점</th><th>최근</th><th>비교</th></tr></thead><tbody>${m.compare.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.base)}</td><td>${esc(c.latest)}</td><td>${esc(fuCmpWord(c))}${c.state === 'changed' ? ': ' + esc(c.reasons.slice(0, 2).join(' · ')) : ''}${c.watchKo ? ' (주의할 손: ' + esc(c.watchKo) + ')' : ''}${c.limited ? ' (화면 크기가 달라 비교에 한계)' : ''}</td></tr>`).join('')}</tbody></table>` : '<p>체크 기록 없음</p>';
  const note = (m.crossing.cross || m.crossing.undetermined) ? `<p>${m.crossing.cross ? '' : '엇갈림 판단 불가: '}${esc(m.crossing.text)}</p>` : '';
  const em = (m.emergencyItems.length ? `<p><b>응급 항목 체크(${esc(m.emergencyDate)}):</b> ${esc(m.emergencyItems.join(' · '))}</p>` : '')
    + (m.emergencyDates.length ? `<p>과거에 응급 항목을 체크한 날짜: ${esc(m.emergencyDates.join(', '))}</p>` : '');
  return `<div id="fuPrintCompact" class="fu-print-only"><h3>SIRIUS 경과 관찰 요약 <small>${esc(fuToday())} · 진단이 아닌 자가 기록</small></h3>
    <p>종양 위치 <b>${esc(m.locKo)}</b> · 치우친 쪽 <b>${esc(m.sideKo)}</b> · 잘 쓰는 손 <b>${esc(m.handKo)}</b> · 다음 MRI <b>${esc(m.next || '미정')}</b> · 약 사용 기록(메드록시프로게스테론 주사 등) <b>${esc(m.hormoneKo)}</b>${(m.hormone === 'now' || m.hormone === 'past') ? ' — 의사에게 알려 주세요' : ''}</p>
    <p>최근 MRI 크기 기록: ${mri}</p>${m.vfLines.length ? `<p><b>정밀 시야(앱 점수)</b><br>${m.vfLines.map(esc).join('<br>')}</p>` : ''}${cmp}${note}${em}
    <p><b>의사에게 할 질문</b></p><ol>${m.printQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>
    <p class="fu-safe">응급: 갑작스러운 마비·말 어눌함·얼굴 처짐·평소와 다른 심한 두통·갑작스러운 시력 저하는 바로 119. 이 요약은 집에서 한 간단한 자가 기록이며 진단이나 의학적 판단이 아닙니다. 비교는 앱 화면 표시용 기준이며 의학적 기준이 아닙니다.</p></div>`;
}
function fuSummary(){
  const m = FU.summary(S.followup, fuToday(), fuVfExtra());
  const vfx = m.vfLines.length ? `<h4 class="fu-h4">정밀 시야검사 (앱 점수 · 내 기준선과 비교)</h4><ul class="fu-q">${m.vfLines.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="tiny">평균·귀쪽−코쪽(좌우 짝)·집중 구역 변화와 검사 지도(mapId)를 함께 적었습니다. 같은 지도의 기록끼리만 비교합니다.</p>` : '';
  const mri = m.mri.length ? `<div class="fu-scroll"><table class="rec fu-narrow"><thead><tr><th>촬영일</th><th>크기</th></tr></thead><tbody>${m.mri.map(x => `<tr><td>${esc(x.date)}</td><td>${x.size} mm</td></tr>`).join('')}</tbody></table></div>` : '<p>입력한 MRI 기록 없음</p>';
  const cmp = m.compare.length ? `<div class="fu-scroll"><table class="rec"><thead><tr><th>체크</th><th>기준점</th><th>최근</th><th>비교</th></tr></thead><tbody>${m.compare.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.base)}</td><td>${esc(c.latest)}</td><td>${c.state === 'changed' ? '▲ 변화 있음' + (c.repeated ? ' (이어짐)' : '') + '<br><span class="tiny">' + esc(c.reasons.join(' · ')) + '</span>' : esc(fuCmpWord(c))}${c.watchKo ? '<br><span class="tiny">주의할 손: ' + esc(c.watchKo) + '</span>' : ''}${c.notes.length ? '<br><span class="tiny">참고: ' + esc(c.notes.join(' · ')) + '</span>' : ''}${c.limited ? '<br><span class="tiny">' + esc(c.limitNote) + '</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p>체크 기록 없음</p>';
  const em = m.emergencyItems.length ? `<div class="fu-119"><b>응급 항목을 체크한 기록이 있습니다 (${esc(m.emergencyDate)}).</b> ${esc(m.emergencyItems.join(' · '))}</div>` : '';
  const ask = FUS.exportAsk
    ? `<div class="fu-confirm" role="alertdialog" aria-label="내보내기 확인"><p><b>이 요약에는 건강 정보가 들어 있습니다.</b> 인쇄·PDF·복사하면 이 앱 밖(종이, 파일, 클립보드)에 남습니다. 어디에 두는지 확인하고 진행하세요.</p><button class="btn primary" data-fu="exportPrint">인쇄 / PDF로 저장</button> <button class="btn" data-fu="exportCopy">글로 복사</button> <button class="btn ghost" data-fu="askNo">취소</button></div>`
    : '<div class="fu-actions"><button class="btn primary" data-fu="exportAsk">인쇄 · PDF · 복사…</button><button class="btn ghost" data-fu="go" data-v="home">돌아가기</button></div>';
  return `${fuPrintCompact(m)}<div class="card fu-screen"><div class="card-hd"><h3>진료 전 요약</h3><span class="right tiny">${esc(fuToday())} 기준 · 진단이 아닌 자가 기록</span></div><div class="card-pad">
    ${FU_EMERGENCY_HTML}${em}
    <h4 class="fu-h4">종양 정보</h4><p>위치: <b>${esc(m.locKo)}</b> · 치우친 쪽: <b>${esc(m.sideKo)}</b> · 잘 쓰는 손: <b>${esc(m.handKo)}</b> · 다음 MRI 예정일: <b>${esc(m.next || '미정')}</b></p>${mri}${vfx}
    <h4 class="fu-h4">약 사용 기록</h4><p>메드록시프로게스테론 주사 등: ${esc(m.hormoneKo)}${m.hormoneDate ? ' · ' + esc(m.hormoneDate) : ''}${(m.hormone === 'now' || m.hormone === 'past') ? '<br><b>의사에게 꼭 알리세요.</b>' : ''}</p>
    <h4 class="fu-h4">첫 측정(기준점)과의 비교</h4>${cmp}${m.crossing.cross ? `<div class="fu-cross" role="note">${esc(m.crossing.text)}</div>` : ''}
    <h4 class="fu-h4">MRI 크기와 체크 그래프</h4>${fuGraphHtml()}
    <h4 class="fu-h4">의사에게 할 질문</h4><ol class="fu-q">${m.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>
    <p class="tiny">이 요약은 환자가 집에서 한 간단한 자가 기록이며 진단이나 의학적 판단이 아닙니다. 비교 기준은 앱 화면 표시용이며 의학적 기준이 아닙니다.</p>
  </div></div><div class="card fu-screen"><div class="card-pad">${ask}${FUS.copyMsg ? `<p class="tiny" role="status">${esc(FUS.copyMsg)}</p>` : ''}</div></div>`;
}
async function fuExportCopy(){
  const text = fuSummaryText(FU.summary(S.followup, fuToday(), fuVfExtra()));
  const acc = S.acc, key = S.masterKey, tok = ++FUS.copyTok;
  let ok = false;
  try{ if(navigator.clipboard && navigator.clipboard.writeText){ await navigator.clipboard.writeText(text); ok = true; } }catch(e){}
  // 이미 한 복사는 되돌릴 수 없지만, 그 사이 로그아웃·재로그인·화면 이동이 있었다면 늦은 안내는 화면에 반영하지 않습니다
  if(FUS.dead || S.acc !== acc || S.masterKey !== key || tok !== FUS.copyTok || FUS.view !== 'summary') return;
  FUS.exportAsk = false; FUS.copyMsg = ok ? '요약을 복사했습니다. 붙여 넣은 곳의 보관 위치를 확인하세요.' : '복사하지 못했습니다. 인쇄 기능을 쓰거나 화면의 내용을 직접 옮겨 적어 주세요.';
  fuRender();
}
function fuExportPrint(){
  const root = document.documentElement;
  FUS.exportAsk = false; fuRender();
  root.classList.add('fu-printing');
  window.addEventListener('afterprint', () => root.classList.remove('fu-printing'), { once:true });
  window.print();
}


/* ── 암호화 백업·복원 (.sirius-followup) ──
   · 사용자가 누른 버튼으로만 동작합니다. 파일은 이 기기에서만 만들고 읽으며 서버로 보내지 않습니다.
   · 비밀번호·복호화 미리보기는 끝나면 지우고, 로그에 남기지 않습니다.
   · 암·복호화/파일 읽기 중에 로그아웃·계정 변경·화면 이동·새 파일 선택이 있으면 그 결과는 버립니다. */
function fuBkTok(){ return { n:++FUS.bkSeq, acc:S.acc, key:S.masterKey }; }
const fuBkLive = k => !FUS.dead && fuLogged() && k.n === FUS.bkSeq && S.acc === k.acc && S.masterKey === k.key && FUS.view === 'backup';
function fuBkClear(){
  FUS.bkSeq++; FUS.rs = null; FUS.bkMsg = ''; FUS.bkOk = false;
  for(const id of ['fuBkPass', 'fuBkPass2', 'fuRsPass']){ const e = fuEl(id); if(e) e.value = ''; }
  const f = fuEl('fuRsFile'); if(f){ try{ f.value = ''; }catch(e){} }
}
function fuLock(on){                                          // 교체 저장 중 화면 조작을 잠시 막음
  const els = document.querySelectorAll('#fuRoot button, #fuRoot input, #fuRoot select, #fuRoot textarea');
  if(on){ FUS.locked = []; for(const e of els) if(!e.disabled){ e.disabled = true; FUS.locked.push(e); } }   // 원래 비활성이던 항목은 기억해 두지 않음
  else { for(const e of (FUS.locked || [])) e.disabled = false; FUS.locked = []; }
}
/* 사이드바 등 앱 쪽 이동(shell.go)이 부르는 훅: false 를 돌려주면 이동을 거절합니다 */
function followupLeave(){
  if(FUS.busy){ fuBkSay('기록을 교체해 저장하는 중입니다. 끝난 뒤 이동해 주세요.', false); return false; }
  if(FUS.view === 'backup'){ fuBkClear(); FUS.view = 'home'; fuRender(); }
  return true;
}
function fuBkSay(msg, ok){
  FUS.bkMsg = msg || ''; FUS.bkOk = !!ok;
  const el = fuEl('fuBkStatus');
  if(el){ el.className = 'tiny ' + (ok ? '' : 'fu-bad'); el.innerHTML = esc(FUS.bkMsg); }
}
function fuBkBlock(){            // 교체 전에 막아야 하는 상태. 문장을 돌려주고, 없으면 ''
  if(FUS.busy) return '저장 중입니다. 끝난 뒤 다시 시도해 주세요.';
  if(FUS.save === 'saving') return '저장 중입니다. 저장이 끝난 뒤 다시 시도해 주세요.';
  if(FUS.save === 'fail') return '지금 기록이 아직 저장되지 않았습니다. 먼저 "다시 저장"으로 저장하거나 요약을 따로 보관한 뒤 복원해 주세요.';
  if(FUS.save === 'conflict' || FUS.save === 'unsupported') return '저장 충돌 또는 브라우저 제한으로 지금 기록이 저장되지 않은 상태입니다. 다시 로그인한 뒤 복원해 주세요.';
  return '';
}
function fuBackup(){
  const s = fuState();
  return `${FU_EMERGENCY_HTML}
  <div class="card"><div class="card-hd"><h3>백업·복원</h3><span class="right" id="fuSave" role="status" aria-live="polite"></span></div><div class="card-pad">
    <p class="tiny">경과 관찰 기록(위치·MRI 크기·체크 결과)을 <b>암호화한 파일</b>로 보관합니다. 이 기기에서만 만들고 서버로 보내지 않으며, 원본 영상과 아이디·이름·이메일은 들어 있지 않습니다. 브라우저 데이터를 지우면 이 브라우저의 기록이 사라질 수 있습니다.</p>
    <div id="fuBkStatus" class="tiny" role="status" aria-live="polite"></div>
  </div></div>
  <div class="card"><div class="card-hd"><h3>백업 파일 만들기</h3><span class="right tiny">MRI ${s.mri.length}건 · 체크 ${s.checks.length}건</span></div><div class="card-pad">
    <div class="fu-grid">
      <div class="field"><label for="fuBkPass">백업 비밀번호</label><input id="fuBkPass" type="password" autocomplete="new-password" maxlength="256"><span class="help">12자 이상. 잊으면 복원할 수 없습니다. 계정 비밀번호와 다르게 정하는 것을 권합니다.</span></div>
      <div class="field"><label for="fuBkPass2">비밀번호 확인</label><input id="fuBkPass2" type="password" autocomplete="new-password" maxlength="256"></div>
    </div>
    <button class="btn primary" data-fu="bkExport">암호화 파일 내려받기</button>
    <p class="tiny">파일은 직접 보관하세요(공용 컴퓨터·공유 폴더에는 두지 않기).</p>
  </div></div>
  <div class="card"><div class="card-hd"><h3>백업 파일에서 복원</h3></div><div class="card-pad">
    <div class="err" role="note">복원하면 <b>지금 계정의 경과 관찰 기록이 백업 내용으로 교체</b>됩니다. 자동으로 합치지 않습니다. 다른 사람의 백업 파일을 섞지 마세요. 교체 전에 지금 기록을 먼저 위에서 백업해 두기를 권합니다.</div>
    <div class="fu-grid">
      <div class="field"><label for="fuRsFile">백업 파일 (.sirius-followup)</label><input id="fuRsFile" type="file" accept=".sirius-followup"></div>
      <div class="field"><label for="fuRsPass">백업 비밀번호</label><input id="fuRsPass" type="password" autocomplete="off" maxlength="256"></div>
    </div>
    <button class="btn" data-fu="bkRead">내용 미리 보기</button>
    <div id="fuRsPreview"></div>
  </div></div>
  <div class="card"><div class="card-pad"><button class="btn" data-fu="go" data-v="home">돌아가기</button></div></div>`;
}
function fuBkShow(){                                          // 다시 그린 뒤 안내문·미리보기 복원
  const el = fuEl('fuBkStatus'); if(el && FUS.bkMsg) fuBkSay(FUS.bkMsg, FUS.bkOk);
  fuBkPreview();
}
function fuBkPreview(){
  const el = fuEl('fuRsPreview'); if(!el) return;
  const r = FUS.rs;
  if(!r){ el.innerHTML = ''; return; }
  const cur = fuState(), st = r.state, loc = FU.LOCS.find(l => l.id === st.loc);
  const last = st.mri.length ? st.mri[st.mri.length - 1] : null;
  el.innerHTML = `<div class="fu-ask">
    <p><b>미리 보기</b> · 종양 위치 ${esc(loc ? loc.ko : '')} · MRI 기록 ${st.mri.length}건${last ? ` (최근 ${esc(last.date)} · ${last.size} mm)` : ''} · 체크 기록 ${st.checks.length}건</p>
    <p class="tiny">교체되면 지금 기록(MRI ${cur.mri.length}건 · 체크 ${cur.checks.length}건)은 사라집니다.</p>
    <label class="fu-chk"><input type="checkbox" id="fuRsOk"> 이 백업이 내 기록인지 확인했고, 지금 기록을 교체합니다.</label>
    <div><button class="btn danger" data-fu="bkReplace">교체하기</button> <button class="btn" data-fu="bkCancel">취소</button></div></div>`;
}
async function fuBkExport(){
  if(FUS.busy) return;
  const a = fuVal('fuBkPass'), b = fuVal('fuBkPass2');
  const prob = FUFile.passProblem(a); if(prob) return fuBkSay(prob, false);
  if(a !== b) return fuBkSay('비밀번호 확인이 일치하지 않습니다.', false);
  const k = fuBkTok(); fuBkSay('암호화하는 중…', true);
  let text;
  try{ text = await FUFile.encrypt(FU.clean(S.followup), a); }
  catch(e){ if(fuBkLive(k)) fuBkSay(e && e.message ? e.message : '암호화하지 못했습니다.', false); return; }
  if(!fuBkLive(k)) return;                                    // 그 사이 로그아웃·이동 — 내려받지 않음
  for(const id of ['fuBkPass', 'fuBkPass2']){ const e = fuEl(id); if(e) e.value = ''; }
  try{ FUFile.download(text, FUFile.fileName()); }catch(e){ return fuBkSay('파일을 내려받지 못했습니다.', false); }
  text = null;
  fuBkSay('암호화 백업 파일을 내려받았습니다. 비밀번호와 함께 직접 보관하세요.', true);
}
async function fuBkRead(){
  if(FUS.busy) return;
  const blk = fuBkBlock(); if(blk) return fuBkSay(blk, false);
  const inp = fuEl('fuRsFile'), file = inp && inp.files && inp.files[0];
  if(!file) return fuBkSay('백업 파일을 먼저 선택해 주세요.', false);
  if(!(file.size >= 0) || file.size > FUFile.MAX_BYTES) return fuBkSay('백업 파일이 너무 큽니다(최대 2MB). 올바른 백업 파일인지 확인해 주세요.', false);
  const pass = fuVal('fuRsPass'); if(!pass) return fuBkSay('백업 비밀번호를 입력해 주세요.', false);
  FUS.rs = null; fuBkPreview();
  const k = fuBkTok(); fuBkSay('파일을 확인하는 중…', true);
  try{
    const text = await file.text();
    if(!fuBkLive(k)) return;
    const st = await FUFile.decrypt(text, pass);
    if(!fuBkLive(k)) return;
    const e = fuEl('fuRsPass'); if(e) e.value = '';
    FUS.rs = { state:st, tok:k }; fuBkSay('', true); fuBkPreview();
  }catch(e){ if(fuBkLive(k)) fuBkSay(FUFile.FAIL, false); }
}
async function fuBkReplace(){
  if(FUS.busy || !FUS.rs) return;
  const blk = fuBkBlock(); if(blk) return fuBkSay(blk, false);
  const ok = fuEl('fuRsOk'); if(!ok || !ok.checked) return fuBkSay('교체하려면 확인란에 체크해 주세요.', false);
  const k = FUS.rs.tok;
  if(!fuBkLive(k)) return fuBkClear();
  const prev = S.followup, acc = S.acc, key = S.masterKey;
  S.followup = FU.clean(FUS.rs.state);
  const rid = ++FUS.rid; FUS.pid++; FUS.busy = rid; FUS.save = 'saving'; fuLock(true); fuRenderSave(); fuBkSay('교체해 저장하는 중…', true);
  let r;
  try{ r = (typeof saveVault === 'function') ? await saveVault() : { ok:false }; }catch(e){ r = { ok:false }; }
  // 현재 세션의 이 교체 요청일 때만 상태를 풀고 반영 (A 의 늦은 콜백이 B 의 busy 를 풀지 못하게)
  if(FUS.dead || S.acc !== acc || S.masterKey !== key || FUS.busy !== rid) return;
  FUS.busy = false; fuLock(false);
  if(fuSaveKind(r) === 'ok'){
    FUS.save = 'ok'; fuBkClear(); FUS.view = 'home'; FUS.msg = '백업으로 기록을 교체하고 저장했습니다.'; FUS.msgOk = true; return fuRender();
  }
  S.followup = prev;                                              // 실패: 기존 기록 그대로, 미리보기는 남겨 재시도 가능
  const kind = fuSaveKind(r);
  FUS.save = (kind === 'conflict' || kind === 'unsupported') ? kind : '';
  fuRenderSave();
  fuBkSay(kind === 'conflict' ? '다른 탭에서 기록이 바뀌어 교체를 거절했습니다. 기존 기록은 그대로입니다. 다시 로그인한 뒤 시도해 주세요.'
        : kind === 'unsupported' ? '이 브라우저는 안전한 저장(탭 잠금)을 지원하지 않아 교체하지 못했습니다. 기존 기록은 그대로입니다.'
        : '저장하지 못해 교체하지 않았습니다. 기존 기록은 그대로입니다. 같은 화면에서 다시 시도할 수 있습니다.', false);
}

/* ── 이벤트 ── */
function fuVal(id){ const e = fuEl(id); return e ? e.value : ''; }
function fuChecked(attr){ return [...document.querySelectorAll(`#fuRoot [${attr}]`)].filter(x => x.checked).map(x => x.getAttribute(attr)); }
function fuOnClick(e){
  if(FUS.busy) return;                                          // 교체 저장 중에는 모든 조작 무시
  const b = e.target.closest ? e.target.closest('[data-fu]') : null;
  if(!b || !fuLogged()) return;
  const a = b.dataset.fu, today = fuToday();
  if(a === 'go') return fuGo(b.dataset.v);
  if(a === 'retry') return fuPersist();
  if(a === 'askNo'){ FUS.delAsk = ''; FUS.exportAsk = false; return fuRender(); }
  if(a === 'askMri'){ FUS.delAsk = 'mri:' + b.dataset.k; return fuRender(); }
  if(a === 'askChk'){ FUS.delAsk = 'chk:' + b.dataset.k; return fuRender(); }
  if(a === 'delMri'){ FUS.delAsk = ''; return void fuApply(FU.removeMri(S.followup, b.dataset.k), 'MRI 기록을 지웠습니다.'); }
  if(a === 'delChk'){
    FUS.delAsk = '';
    const id = +b.dataset.k, rec = fuState().checks.find(c => c.id === id);
    const r = FU.removeCheck(S.followup, id);
    let note = '체크 기록을 지웠습니다.';
    if(rec && r.ok && FU.baseId(S.followup, rec.type, rec.eye) === id){
      const nb = FU.compare(r.state, rec.type, rec.eye).base;
      note += nb ? ` 기준점이 ${nb.date} 기록으로 바뀌어 비교 결과가 달라졌습니다.` : ' 기준점이 없어졌습니다. 다음에 기록하는 체크가 새 기준점이 됩니다.';
    }
    return void fuApply(r, note);
  }
  if(a === 'addMri'){
    const r = FU.addMri(S.followup, fuVal('fuMriDate'), fuVal('fuSize'), today);
    return void fuApply(r, r.ok ? (r.replaced ? '같은 날짜의 기록을 새 크기로 바꿨습니다.' : 'MRI 기록을 추가했습니다.') : '');
  }
  if(a === 'field'){                                             // 정밀 시야검사: 위치·치우친 쪽을 넘겨 시야 기록 검사 준비로 이동
    const s = fuState();
    if(typeof vfOpenFromFollowup === 'function') vfOpenFromFollowup({ loc:s.loc, side:s.side });
    return;
  }
  if(a === 'tapStart') return fuTapStart();
  if(a === 'vfStart') return fuVfStart();
  if(a === 'saveTap'){ const d = FUS.draft; if(!d || d.type !== 'tap') return; const r = FU.addCheck(S.followup, Object.assign({}, d, { date:today }), today); if(fuApply(r, '빠르게 두드리기 기록을 저장했습니다.')){ FUS.draft = null; FUS.view = 'home'; fuRender(); } return; }
  if(a === 'rhythmStart') return fuRhythmStart();
  if(a === 'saveRhythm'){ const d = FUS.draft; if(!d || d.type !== 'rhythm') return; const r = FU.addCheck(S.followup, Object.assign({}, d, { date:today }), today); if(fuApply(r, '박자 두드리기 기록을 저장했습니다.')){ FUS.draft = null; FUS.view = 'home'; fuRender(); } return; }
  if(a === 'saveVf'){ const d = FUS.draft; if(!d || d.type !== 'vf4') return; const r = FU.addCheck(S.followup, { type:'vf4', date:today, eye:d.eye, seen:d.seen, catch:d.catch, fw:d.fw }, today); if(fuApply(r, '간단 시야 기록을 저장했습니다.')){ FUS.draft = null; FUS.view = 'home'; fuRender(); } return; }
  if(a === 'discard'){ FUS.draft = null; return fuGo('home'); }
  if(a === 'saveSym'){
    const items = fuChecked('data-sym');
    const r = FU.addCheck(S.followup, { type:'sym', date:fuVal('fuDate'), items }, today);
    const em = items.some(id => FU.EMERGENCY.some(x => x.id === id));
    if(fuApply(r, em ? '기록했습니다. 응급 항목을 체크하셨으니 기록보다 먼저 119나 응급실에 연락하세요.' : '기록했습니다.')){ FUS.view = 'home'; fuRender(); }
    return;
  }
  if(a === 'saveCare'){ const r = FU.addCheck(S.followup, { type:'care', date:fuVal('fuDate'), items:fuChecked('data-care') }, today); if(fuApply(r, '기록했습니다.')){ FUS.view = 'home'; fuRender(); } return; }
  if(a === 'saveMeds'){
    const sel = document.querySelector('input[name="fuHormone"]:checked');
    const r = FU.setMeds(S.followup, sel ? sel.value : '', fuVal('fuMedDate'), today);
    if(fuApply(r, '기록했습니다.')){ FUS.view = 'home'; fuRender(); } return;
  }
  if(a === 'exportAsk'){ FUS.exportAsk = true; return fuRender(); }
  if(a === 'bkExport') return void fuBkExport();
  if(a === 'bkRead') return void fuBkRead();
  if(a === 'bkReplace') return void fuBkReplace();
  if(a === 'bkCancel'){ FUS.rs = null; FUS.bkSeq++; fuBkSay('', true); return fuBkPreview(); }
  if(a === 'exportPrint') return fuExportPrint();
  if(a === 'exportCopy') return void fuExportCopy();
}
function fuOnChange(e){
  const t = e.target; if(!t || !fuLogged() || FUS.busy) return;
  if(t.id === 'fuRsFile'){ FUS.rs = null; FUS.bkSeq++; fuBkPreview(); const e = fuEl('fuRsPass'); if(e) e.value = ''; return fuBkSay('', true); }   // 새 파일 선택 — 이전 결과 무효
  if(t.id === 'fuLoc') return void fuApply(FU.setLoc(S.followup, t.value), '종양 위치를 바꿨습니다. 아래 체크 구성이 바뀝니다.');
  if(t.id === 'fuSide') return void fuApply(FU.setSide(S.followup, t.value), '치우친 쪽을 바꿨습니다. 정밀 시야검사 지도가 바뀌면 새 기준선을 만듭니다.');
  if(t.id === 'fuHand') return void fuApply(FU.setHand(S.followup, t.value), '잘 쓰는 손을 저장했습니다. 좌우 차이를 이 손 기준으로 계산합니다.');
  if(t.id === 'fuNext') return void fuApply(FU.setNext(S.followup, t.value), t.value ? '다음 MRI 예정일을 저장했습니다.' : '다음 MRI 예정일을 지웠습니다.');
  if(t.id === 'fuCareOk'){ FUS.careOk = !!t.checked; const keep = fuChecked('data-sym'); fuRender(); document.querySelectorAll('#fuRoot [data-sym]').forEach(x => { if(keep.includes(x.getAttribute('data-sym'))) x.checked = true; }); const ck = fuEl('fuCareOk'); if(ck) ck.focus(); return; }
  if(t.hasAttribute && t.hasAttribute('data-sym')){
    const any = fuChecked('data-sym').some(id => FU.EMERGENCY.some(x => x.id === id));
    const bn = fuEl('fuEmBanner'); if(bn) bn.hidden = !any;
  }
}
(function fuWire(){
  const root = fuEl('fuRoot'); if(!root) return;
  root.addEventListener('click', fuOnClick);
  root.addEventListener('change', fuOnChange);
  const st = fuEl('fuStage'); if(!st) return;
  fuEl('fuStageGo').addEventListener('click', () => {
    const t = FUS.test; if(!t) return;
    if(t.kind === 'tap') fuTapCountdown(); else if(t.kind === 'rhythm') fuRhythmCountdown(); else { fuEl('fuStageGo').hidden = true; fuVfNext(); }
  });
  fuEl('fuStageCancel').addEventListener('click', () => fuCancelTest());
  const onPointer = e => { e.preventDefault(); if(e.button > 0 || e.isPrimary === false) return; fuPress(false); };   // 우클릭·보조 버튼·두 번째 접점은 세지 않음
  fuEl('fuTapPad').addEventListener('pointerdown', onPointer);   // 두드리기는 스페이스바만 세므로 여기 입력은 무시됨
  fuEl('fuField').addEventListener('pointerdown', onPointer);    // 간단 시야는 화면 누르기도 받음
})();
