'use strict';
/* ═══════════════════════════════════════════════════════════
   V. 시야 기록 — 화면
   ───────────────────────────────────────────────────────────
   · 기록은 VFS(메모리)에 있고, 바뀔 때마다 S.vf 로 옮겨 saveVault()(계정별 AES-GCM, 이 브라우저)가 자동 저장합니다.
     암호화 파일 내보내기·불러오기는 백업용으로 남깁니다. 나가기·유휴 잠금이면 화면과 메모리 값을 지웁니다.
     (이 파일은 네트워크·브라우저 저장소를 직접 쓰지 않습니다)
   · 검사 지도는 경과 관찰의 종양 위치(loc)·치우친 쪽(side)으로 정합니다(vf-map.js). 기록마다 mapId·점 목록을 저장합니다.
   · 화면에 쓰는 문장은 고정 문구와 숫자뿐이며, 자유 입력은 받지 않습니다. 숫자는 '앱 점수'로 표시합니다.
   ═══════════════════════════════════════════════════════════ */
const VFS = { tests:[], symptoms:[], rules:{ ...VF.RULES_DEFAULT }, dirty:false, view:'home',
              eye:'R', cardMoved:false, delAsk:-1, last:-1, replaceAsk:false, mode:'',
              ctx:{ loc:'unknown', side:'unknown', from:false }, save:'' };
let vfFileSeq = 0, vfSaveSeq = 0;
const VF_VIEWS = { home:'vfHome', setup:'vfSetup', result:'vfResult', symptom:'vfSymptom', summary:'vfSummary' };
const vfToday = () => VFFile.localDate();
const vfEl = id => document.getElementById(id);
const VU = VF.UNIT;                         // '앱 점수'

function vfShow(view){
  if(view !== VFS.view && VFS.mode) vfCloseFile();
  VFS.view = view;
  for(const [k, id] of Object.entries(VF_VIEWS)) vfEl(id).hidden = k !== view;
  if(view === 'home') vfRenderHome();
  if(view === 'setup') vfRenderSetup();
  if(view === 'symptom') vfRenderSymptom();
  if(view === 'summary') vfRenderSummary();
  window.scrollTo({ top:0 });
}
/* 경과 관찰에 입력한 위치·치우친 쪽 (없으면 모름) */
function vfCtxFromFollowup(){
  const f = S.followup && typeof S.followup === 'object' ? S.followup : {};
  const loc = typeof f.loc === 'string' ? f.loc : 'unknown';
  const side = VFMap.SIDES.includes(f.side) ? f.side : 'unknown';
  return { loc, side, from:false };
}
function vfEnter(){
  VFS.ctx = vfCtxFromFollowup();
  if(VFS.view === 'home') vfRenderHome();
  else if(VFS.view === 'setup') vfRenderSetup();
}
/* 경과 관찰의 ‘정밀 시야검사’ 버튼: 위치·치우친 쪽을 넘겨 검사 준비 화면을 엽니다. 치우친 쪽 눈을 먼저 고릅니다. */
function vfOpenFromFollowup({ loc, side } = {}){
  if(!S.acc || !S.masterKey) return;
  if(typeof go === 'function') go('field');
  VFS.ctx = { loc: typeof loc === 'string' ? loc : 'unknown', side: VFMap.SIDES.includes(side) ? side : 'unknown', from:true };
  VFS.eye = VFMap.firstEye(VFS.ctx.side) || VFS.eye || 'R';
  vfShow('setup');
}
const vfMapNow = () => VFMap.buildMap({ eye:VFS.eye, loc:VFS.ctx.loc, side:VFS.ctx.side });

/* ── 자동 저장: S.vf 로 옮긴 뒤 saveVault(). 가장 최근 요청의 결과만 반영합니다 ── */
const vfSnapshot = () => VF.exportable({ tests:VFS.tests, symptoms:VFS.symptoms, rules:VFS.rules });
async function vfPersist(retry){
  if(!S.acc || !S.masterKey) return;
  const acc = S.acc, key = S.masterKey, seq = ++vfSaveSeq;
  S.vf = vfSnapshot();
  VFS.dirty = true; VFS.save = 'saving'; vfRenderSaveState();
  let r;
  try{ r = (typeof saveVault === 'function') ? await saveVault() : { ok:false }; }catch(e){ r = { ok:false }; }
  if(S.acc !== acc || S.masterKey !== key || seq !== vfSaveSeq) return;     // 로그아웃·계정 변경·더 새 저장 — 버림
  if(r && r.cancelled){                                // 다른 저장(경과 관찰 등)이 이 저장을 대신함: 한 번 다시 저장
    if(!retry) return void vfPersist(true);
    r = { ok:false };
  }
  VFS.save = r && r.ok === true ? 'ok' : (r && r.conflict ? 'conflict' : (r && r.unsupported ? 'unsupported' : 'fail'));
  VFS.dirty = VFS.save !== 'ok';
  vfRenderSaveState();
}
function vfRenderSaveState(){
  const el = vfEl('vfDirty'); if(!el) return;
  const t = { saving:'저장 중…', ok:'✓ 암호화해 이 브라우저에 저장했습니다', fail:'저장하지 못했습니다. 백업 파일로 내보내 두세요.',
              conflict:'다른 탭에서 기록이 바뀌어 저장하지 않았습니다. 다시 로그인해 확인하세요.', unsupported:'이 브라우저에서는 안전하게 저장할 수 없습니다.' }[VFS.save];
  el.textContent = t || (VFS.dirty ? '저장하지 않은 변경이 있습니다' : '');
}
/* 로그인 직후: 계정 금고에서 읽은 S.vf 를 검증해 화면 상태로 옮깁니다 */
function vfLoadSession(){
  let st = null;
  try{ st = S.vf ? VF.cleanState(S.vf) : null; }catch(e){ st = null; }
  VFS.tests = st ? st.tests : []; VFS.symptoms = st ? st.symptoms : []; VFS.rules = st ? st.rules : { ...VF.RULES_DEFAULT };
  S.vf = st ? vfSnapshot() : null;
  VFS.dirty = false; VFS.save = ''; VFS.delAsk = -1; VFS.last = -1;
  VFS.ctx = vfCtxFromFollowup();
  vfShow('home');
}

/* ── 홈: 상태·경과·기록·기준값 ───────────────────────────── */
const LV_CLASS = ['vf-lv0', 'vf-lv1', 'vf-lv2', 'vf-lv3', 'vf-lv4'];
const LV_MARK = ['✓ 안정', '◔ 확인', '▲ 연락', '▲▲ 오늘 연락', '■ 응급'];
function vfAssess(){ return VF.assess({ tests:VFS.tests, symptoms:VFS.symptoms, rules:VFS.rules }, VF.dayNum(vfToday())); }

function vfEyeLine(e){
  const nm = VF.EYE_KO[e.eye];
  if(!e.nAll) return `<li><b>${nm}</b> · 아직 검사가 없습니다. (기준선 0/2)</li>`;
  const other = e.otherMap ? ` 다른 지도 기록 ${e.otherMap}회는 비교에서 뺐습니다.` : '';
  const map = ` <span class="tiny">[지도 ${esc(e.mapId)}]</span>`;
  if(e.state === 'baseline') return `<li><b>${nm}</b>${map} · ${e.otherMap ? '지도가 바뀌어 새 기준선' : '기준선'} 측정 중 (신뢰할 수 있는 검사 ${e.nReliable}/2). 같은 조건에서 ${e.need}번 더 하세요.${e.excluded ? ` 신뢰도 낮은 검사 ${e.excluded}회는 제외했습니다.` : ''}${other}</li>`;
  const L = e.latest;
  if(!L) return `<li><b>${nm}</b>${map} · 기준선 완료 (평균 ${e.baseline.ms}, 중심 ${e.baseline.central} ${VU}). 이제부터 변화를 비교합니다.${other}</li>`;
  const st = { stable:'기준선과 비슷', recheck:'나빠진 결과 1회 — 재검 필요', confirmed:'나빠진 결과 반복' }[e.state] || '';
  return `<li><b>${nm}</b>${map} · ${st} · 최근 ${esc(L.date)} 평균 ${VF.fmt(L.dMs)}, 중심 ${VF.fmt(L.dCentral)}, 귀쪽−코쪽 ${VF.fmt(L.dTN)}${L.dFocus != null ? `, 집중 구역 ${VF.fmt(L.dFocus)}` : ''} (${VU})`
       + `${L.reasons.includes('focus') ? ' · <b>임시 변화 사유: 집중 점 ' + L.nFocusWorse + '개 6점 이상 하락</b>' : ''}`
       + `${e.pattern !== 'none' ? ' · ' + VF.PATTERN_KO[e.pattern] : ''}${e.trend && e.trend.declining ? ' · 서서히 낮아지는 추세' : ''}</li>`;
}
function vfRenderStatus(){
  const a = vfAssess(), lv = a.level;
  const extra = a.bitemporal ? '<li>두 눈 모두 귀쪽(바깥쪽) 시야가 나빠지는 양상이 함께 보입니다.</li>' : '';
  const first = !VFS.tests.length
    ? '<p class="tiny">처음에는 눈마다 <b>기준선 검사 2번</b>(하루 이틀 간격, 같은 조건)이 필요합니다. 그 뒤부터 “내 기준선과 얼마나 달라졌는지”를 봅니다. 검사 간격은 담당 의료진과 정하세요. 너무 자주 하면 피로·학습 효과로 결과가 흔들립니다.</p>' : '';
  const cls = a.pending ? 'vf-lvp' : LV_CLASS[lv], mark = a.pending ? '… 비교 전' : LV_MARK[lv];
  vfEl('vfStatus').innerHTML =
    `<div class="vf-level ${cls}"><span class="vf-lvmark">${mark}</span><div><b>${esc(a.info.label)}</b><br>${esc(a.info.action)}</div></div>`
    + `<ul class="vf-eyes">${vfEyeLine(a.R)}${vfEyeLine(a.L)}${extra}</ul>${first}`;
  vfRenderSaveState();
}

/* 경과 그래프: 눈마다 지금 지도 구간의 중심 10° 평균(실선·●)과 전체 평균(점선), 기준선(회색 점선), 나빠진 검사는 ▲ */
function vfChart(eye){
  const seg = VF.segmentOf(eye, VFS.tests).seg;
  const rel = seg.filter(t => t.reliable);
  if(!rel.length) return `<div class="vf-chart empty"><b>${VF.EYE_KO[eye]}</b><span class="tiny">신뢰할 수 있는 검사가 아직 없습니다.</span></div>`;
  const W = 330, H = 130, L = 30, R = 8, T = 10, B = 22;
  const n = rel.length, x = i => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - Math.min(30, Math.max(0, v)) / 30);
  const sts = rel.map(t => VF.statsOf(t)), ms = sts.map(s => s.ms), ce = sts.map(s => s.central);
  const an = VF.analyzeEye(eye, VFS.tests, VFS.rules);
  const worsePos = new Set((an.follow || []).filter(f => f.worse).map(f => f.pos));   // 날짜가 아니라 순서로 표시
  const line = (arr, dash) => `<polyline fill="none" stroke="currentColor" stroke-width="2" ${dash ? 'stroke-dasharray="5 4" opacity=".6"' : ''} points="${arr.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ')}"/>`;
  const base = an.baseline ? `<line x1="${L}" x2="${W - R}" y1="${y(an.baseline.central).toFixed(1)}" y2="${y(an.baseline.central).toFixed(1)}" stroke="currentColor" opacity=".35" stroke-dasharray="2 3"/>` : '';
  const dots = rel.map((t, i) => worsePos.has(i)
    ? `<path d="M${x(i).toFixed(1)} ${(y(ce[i]) - 6).toFixed(1)} l6 11 h-12z" fill="var(--bad)" stroke="currentColor" stroke-width="1"/>`
    : `<circle cx="${x(i).toFixed(1)}" cy="${y(ce[i]).toFixed(1)}" r="3.5" fill="currentColor"/>`).join('');
  const grid = [0, 10, 20, 30].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" opacity=".12"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${v}</text>`).join('');
  const label = `${VF.EYE_KO[eye]} 경과(지도 ${an.mapId}): 검사 ${n}회, 최근 중심 평균 ${VF.r1(ce[n - 1])}, 전체 평균 ${VF.r1(ms[n - 1])} ${VU}`;
  return `<div class="vf-chart"><b>${VF.EYE_KO[eye]}</b> <span class="tiny">지도 ${esc(an.mapId)}</span><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${base}${line(ms, true)}${line(ce, false)}${dots}`
       + `<text x="${L}" y="${H - 5}" font-size="10" fill="currentColor" opacity=".6">${esc(rel[0].date)}</text><text x="${W - R}" y="${H - 5}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${esc(rel[n - 1].date)}</text></svg>`
       + `<span class="tiny">실선●=중심 10° 평균 · 점선=전체 평균 · 회색 점선=내 기준선 · ▲=기준선보다 나빠진 검사 (${VU}가 클수록 잘 보임)</span></div>`;
}
function vfRenderTrend(){ vfEl('vfTrend').innerHTML = `<div class="vf-charts">${vfChart('R')}${vfChart('L')}</div>`; }

function vfRenderHistory(){
  if(!VFS.tests.length){ vfEl('vfHistory').innerHTML = '<p class="tiny" style="margin:0">아직 기록이 없습니다. ‘검사 시작’을 누르거나 백업 파일을 불러오세요.</p>'; return; }
  const rows = VFS.tests.map((t, i) => {
    const s = VF.statsOf(t);
    const unseen = t.un.length ? ` · 안 보인 점 ${t.un.length}` : '';
    const del = VFS.delAsk === i ? `<button class="btn sm danger" data-vfdel="${i}">정말 삭제</button>` : `<button class="btn sm ghost" data-vfdel="${i}">삭제</button>`;
    return `<tr><td class="mono">${esc(t.date)}</td><td>${VF.EYE_KO[t.eye]}</td><td class="mono tiny">${esc(t.mapId || VF.LEGACY)}</td><td class="mono">${VF.r1(s.ms)}</td><td class="mono">${VF.r1(s.central)}</td>`
         + `<td>${t.reliable ? '신뢰 가능' : '<b>신뢰도 낮음</b> (판정 제외)'}${unseen}</td><td><button class="btn sm ghost" data-vfopen="${i}">보기</button> ${del}</td></tr>`;
  }).reverse().join('');
  vfEl('vfHistory').innerHTML = `<div style="overflow-x:auto"><table class="rec"><thead><tr><th>날짜</th><th>눈</th><th>지도</th><th>평균(${VU})</th><th>중심(${VU})</th><th>신뢰도</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
const RULE_LABEL = {
  pointDrop:`한 점이 나빠졌다고 보는 최소 하락(${VU})`, clusterMin:'붙어 있는 나빠진 점의 최소 개수', centralDrop:`중심 10° 평균 하락(${VU})`,
  tnDrop:`귀쪽−코쪽 차이 하락(${VU}, 좌우 짝)`, urgentCentralDrop:`‘큰 변화’로 보는 중심 하락(${VU})`, urgentCluster:'‘큰 변화’로 보는 붙은 점 개수',
  focusDrop:`(임시) 집중 점 하락(${VU})`, focusMin:'(임시) 하락한 집중 점의 최소 개수'
};
function vfRenderRules(){
  vfEl('vfRules').innerHTML = Object.keys(RULE_LABEL).map(k =>
    `<label class="vf-rule"><span>${esc(RULE_LABEL[k])}</span><input type="number" data-vfrule="${k}" value="${VFS.rules[k]}" step="1" inputmode="decimal"></label>`).join('');
}
function vfRenderHome(){ vfRenderStatus(); vfRenderTrend(); vfRenderHistory(); vfRenderRules(); }

/* ── 검사 준비 ───────────────────────────────────────────── */
function vfCal(){ const w = +vfEl('vfCardW').value; return { cardPx:w, ppm:VF.pxPerMmFromCard(w) }; }
function vfDistMm(){ const v = +vfEl('vfDist').value; return Number.isFinite(v) ? Math.min(60, Math.max(20, Math.round(v))) * 10 : 330; }
/* 검사 지도 미리보기: ● 기본 점 · ◆ 집중 구역 · ○ 집중 구역의 반대쪽 짝 · 점선 = 맹점 */
function vfMapPreviewSvg(map){
  const S2 = 7, PX = 22, PY = 14, W = 42 * S2 + PX * 2, H = 18 * S2 + PY * 2 + 16;
  const X = x => PX + (x + 21) * S2, Y = y => PY + (9 - y) * S2;
  const dots = map.points.map(p => p.zone
    ? `<rect x="${X(p.x) - 4.5}" y="${Y(p.y) - 4.5}" width="9" height="9" transform="rotate(45 ${X(p.x)} ${Y(p.y)})" fill="var(--brand)"/>`
    : p.role === 'focus' ? `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="none" stroke="var(--brand)" stroke-width="1.6"/>`
    : `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3.2" fill="currentColor" opacity=".7"/>`).join('');
  const b = map.blind;
  const bs = `<circle cx="${X(b.x)}" cy="${Y(b.y)}" r="${b.r * S2}" fill="none" stroke="currentColor" stroke-dasharray="3 3" opacity=".45"/><text x="${X(b.x)}" y="${Y(b.y) + 3}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".7">맹점</text>`;
  const fx = `<g stroke="currentColor" stroke-width="1.4"><line x1="${X(0) - 5}" x2="${X(0) + 5}" y1="${Y(0)}" y2="${Y(0)}"/><line x1="${X(0)}" x2="${X(0)}" y1="${Y(0) - 5}" y2="${Y(0) + 5}"/></g>`;
  const tl = map.eye === 'R' ? ['코쪽', '귀쪽'] : ['귀쪽', '코쪽'];
  const labels = `<text x="${PX}" y="${H - 4}" font-size="10" fill="currentColor" opacity=".7">← ${tl[0]}</text><text x="${W - PX}" y="${H - 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".7">${tl[1]} →</text>`;
  return `<svg class="vf-map vf-map-sm" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(VF.EYE_KO[map.eye] + ' 검사 지도 ' + map.mapId + ', ' + map.n + '점')}">${bs}${fx}${dots}${labels}</svg>`;
}
/* 이번 검사가 기준선 몇 번째인지, 지도가 바뀌었는지 */
function vfBaselineNote(map){
  const seg = VF.segmentOf(map.eye, VFS.tests);
  if(!seg.all.length) return `첫 기준선을 만듭니다 (1/2).`;
  if(seg.mapId !== map.mapId) return `검사 지도가 바뀌었습니다 (${seg.mapId} → ${map.mapId}). 새 기준선을 만듭니다 (1/2). 이전 지도 기록은 목록에 남지만 비교에는 쓰지 않습니다.`;
  const k = seg.seg.filter(t => t.reliable).length;
  return k < 2 ? `기준선 측정 중입니다. 이번 검사가 ${k + 1}/2번째 기준선이 됩니다.` : `같은 지도(${map.mapId})의 내 기준선과 비교합니다.`;
}
function vfRenderMapPreview(){
  const box = vfEl('vfMapPreview'); if(!box) return;
  const map = vfMapNow(), c = VFS.ctx;
  const locKo = typeof FU !== 'undefined' && FU.LOCS ? (FU.LOCS.find(l => l.id === c.loc) || { ko:'모름' }).ko : c.loc;
  const sideKo = typeof FU !== 'undefined' && FU.SIDES ? (FU.SIDES.find(s => s.id === c.side) || { ko:'모름' }).ko : c.side;
  const fe = VFMap.firstEye(c.side);
  const first = fe ? `<p class="tiny"><b>${fe === 'L' ? '왼쪽' : '오른쪽'}으로 치우쳐 있어 ${VF.EYE_KO[fe]}을 먼저 검사하세요.</b>${VFS.eye !== fe ? ' (지금은 다른 눈이 선택되어 있습니다)' : ''}</p>` : '';
  box.innerHTML = `<div class="vf-preview">${vfMapPreviewSvg(map)}<div>`
    + `<p><b>${esc(map.desc)}</b></p>`
    + `<p class="tiny">지도 <span class="mono">${esc(map.mapId)}</span> · ${map.n}점 · 기준: 종양 위치 ${esc(locKo)} · 치우친 쪽 ${esc(sideKo)}${c.from ? ' (경과 관찰에서 넘겨받음)' : ' (경과 관찰에 입력한 값)'}</p>`
    + `<p class="tiny vf-note" role="status">${esc(vfBaselineNote(map))}</p>${first}`
    + `<p class="tiny">● 기본 점 · ◆ 집중 구역 · ○ 집중 구역의 반대쪽 짝. 제안값(임상 검증 전): 집중점 3쌍 · 가장 바깥 21° 유지 · 치우친 쪽 모름은 가운데와 같은 지도.</p>`
    + `</div></div>`;
}
function vfRenderSetup(){
  const { cardPx } = vfCal();
  const rect = vfEl('vfCardRect'); rect.style.width = cardPx + 'px'; rect.style.height = Math.round(cardPx * 53.98 / VF.CARD_MM) + 'px';
  const fit = VF.fitCheck({ w:window.innerWidth, h:window.innerHeight, distMm:vfDistMm(), ppm:vfCal().ppm });
  const msg = vfEl('vfFit');
  msg.className = 'help ' + (fit.ok ? 'ok' : 'no');
  msg.textContent = fit.ok ? '이 거리에서 모든 검사 위치가 화면에 들어옵니다.'
    : `이 화면에서는 가장 바깥 위치가 들어오지 않습니다. 거리를 ${Math.max(0, Math.floor(fit.maxDistMm / 10))}cm 이하로 줄이거나 더 큰 화면(브라우저 전체 화면)을 쓰세요.`;
  const checked = [...document.querySelectorAll('[data-vfchk]')].every(c => c.checked);
  const dist = +vfEl('vfDist').value;
  vfEl('vfStart').disabled = !(fit.ok && checked && VFS.cardMoved && dist >= 20 && dist <= 60);
  document.querySelectorAll('#vfEye button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.eye === VFS.eye)));
  vfRenderMapPreview();
}

/* ── 검사 무대 ───────────────────────────────────────────── */
let vfRun = null;
const vfGray = l => `rgb(${l},${l},${l})`;

function vfPaint(stim){
  const r = vfRun; if(!r) return;
  const g = r.g, { w, h } = r.size, cx = w / 2, cy = h / 2;
  g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  g.fillStyle = vfGray(VF.BG_LEVEL); g.fillRect(0, 0, w, h);
  const fr = Math.max(3, VF.sizePx(0.7, r.distMm, r.ppm) / 2);
  g.fillStyle = vfGray(200); g.beginPath(); g.arc(cx, cy, fr, 0, Math.PI * 2); g.fill();
  if(stim){
    const p = VF.toPx(stim, r.distMm, r.ppm, cx, cy);
    const rad = Math.max(1.5, VF.sizePx(VF.STIM.sizeDeg, r.distMm, r.ppm) / 2);
    g.fillStyle = vfGray(VF.dbToLevel(stim.db)); g.beginPath(); g.arc(p.px, p.py, rad, 0, Math.PI * 2); g.fill();
  }
}
function vfClearTimers(){ if(vfRun){ vfRun.timers.forEach(clearTimeout); vfRun.timers = []; } }
function vfHud(){
  if(!vfRun) return;
  const p = vfRun.T.progress();
  vfEl('vfProg').textContent = `${p.done}/${p.total} 위치`;
}
function vfSizeCanvas(r){
  const w = window.innerWidth, h = window.innerHeight, cv2 = vfEl('vfCanvas');
  cv2.width = Math.round(w * r.dpr); cv2.height = Math.round(h * r.dpr); cv2.style.width = w + 'px'; cv2.style.height = h + 'px';
  r.g = cv2.getContext('2d'); r.size = { w, h };
}
function vfStartStage(){
  const cal = vfCal(), distMm = vfDistMm();
  const fit = VF.fitCheck({ w:window.innerWidth, h:window.innerHeight, distMm, ppm:cal.ppm });
  if(!fit.ok){ vfRenderSetup(); return; }
  const stage = vfEl('vfStage');
  stage.hidden = false;
  const map = vfMapNow();
  vfRun = { T:VF.createTest({ eye:VFS.eye, map }), eye:VFS.eye, map, distMm, ppm:cal.ppm, g:null, dpr:Math.min(2, window.devicePixelRatio || 1), size:{ w:0, h:0 },
            timers:[], trial:null, onset:0, responded:false, stray:0, paused:false, started:false, t0:0 };
  vfSizeCanvas(vfRun);
  vfPaint(null); vfHud();
  vfEl('vfIntro').hidden = false; vfEl('vfPauseBox').hidden = true;
  try{ if(stage.requestFullscreen) stage.requestFullscreen().catch(() => {}); }catch(e){}
  window.addEventListener('keydown', vfKey, true);
  stage.addEventListener('pointerdown', vfPointer);
  window.addEventListener('resize', vfOnLayout);
  document.addEventListener('visibilitychange', vfOnLayout);
  document.addEventListener('fullscreenchange', vfOnFullscreen);
  vfEl('vfBegin').focus();
}
function vfNext(){
  const r = vfRun; if(!r || r.paused) return;
  const tr = r.T.next();
  if(!tr) return vfFinish();
  r.trial = tr; r.responded = false; r.onset = 0;
  r.timers.push(setTimeout(() => vfPresent(tr), 600 + Math.random() * 800));
}
function vfPresent(tr){
  const r = vfRun; if(!r || r.paused || r.trial !== tr) return;
  requestAnimationFrame(() => {
    if(!vfRun || vfRun.trial !== tr || vfRun.paused) return;
    if(tr.kind !== 'fp') vfPaint(tr);
    vfRun.onset = performance.now();
    vfRun.timers.push(setTimeout(() => vfPaint(null), VF.STIM.durMs));
    vfRun.timers.push(setTimeout(() => vfClose(tr), VF.STIM.windowMs));
  });
}
function vfClose(tr){
  const r = vfRun; if(!r || r.trial !== tr) return;
  const seen = r.responded; r.trial = null; r.onset = 0;
  r.T.answer(seen); vfHud(); vfNext();
}
function vfRespond(){
  const r = vfRun; if(!r || !r.started || r.paused) return;
  const dt = r.onset ? performance.now() - r.onset : -1;
  if(r.trial && dt >= VF.STIM.minRtMs && dt <= VF.STIM.windowMs){ r.responded = true; }
  else r.stray++;
}
function vfKey(e){
  if(!vfRun) return;
  if(e.key === 'Escape'){ e.preventDefault(); if(vfRun.started) vfPause(); else { vfAbort(); vfShow('setup'); } return; }
  if(e.key === ' ' || e.code === 'Space'){
    if(e.target && e.target.tagName === 'BUTTON') return;      // 버튼 조작은 그대로
    e.preventDefault(); vfRespond();
  }
}
function vfPointer(e){ if(e.target.closest('button')) return; vfRespond(); }
function vfPause(){
  const r = vfRun; if(!r || r.paused) return;
  r.paused = true; vfClearTimers();
  if(r.trial){ r.T.discard(); r.trial = null; }
  vfPaint(null);
  vfEl('vfPauseBox').hidden = false; vfEl('vfResume').focus();
}
function vfOnLayout(){ if(vfRun && vfRun.started && (document.hidden || window.innerWidth !== vfRun.size.w || window.innerHeight !== vfRun.size.h)) vfPause(); }
function vfOnFullscreen(){ if(vfRun && vfRun.started && !document.fullscreenElement) vfPause(); }
function vfBegin(){
  const r = vfRun; if(!r) return;
  vfSizeCanvas(r);                           // 전체 화면 전환으로 크기가 바뀌었을 수 있습니다
  if(!VF.fitCheck({ w:r.size.w, h:r.size.h, distMm:r.distMm, ppm:r.ppm }).ok){ vfAbort(); vfShow('setup'); return; }
  r.started = true; r.t0 = Date.now(); r.paused = false;
  vfEl('vfIntro').hidden = true; vfPaint(null); vfHud();
  r.timers.push(setTimeout(vfNext, 800));
}
function vfResume(){
  const r = vfRun; if(!r) return;
  const w = window.innerWidth, h = window.innerHeight;
  if(w !== r.size.w || h !== r.size.h){
    vfSizeCanvas(r);
    if(!VF.fitCheck({ w, h, distMm:r.distMm, ppm:r.ppm }).ok){ vfAbort(); vfShow('setup'); return; }
  }
  r.paused = false; vfEl('vfPauseBox').hidden = true; vfPaint(null);
  r.timers.push(setTimeout(vfNext, 700));
}
function vfTeardown(){
  const stage = vfEl('vfStage');
  if(!vfRun){ stage.hidden = true; return; }           // 검사 중이 아니면 해제할 것이 없습니다
  vfClearTimers();
  window.removeEventListener('keydown', vfKey, true);
  window.removeEventListener('resize', vfOnLayout);
  document.removeEventListener('visibilitychange', vfOnLayout);
  document.removeEventListener('fullscreenchange', vfOnFullscreen);
  stage.removeEventListener('pointerdown', vfPointer);
  stage.hidden = true;
  const cv2 = vfEl('vfCanvas'); cv2.width = 1; cv2.height = 1;      // 캔버스 픽셀 버퍼 해제
  try{ if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); }catch(e){}
  vfRun = null;
}
function vfAbort(){ vfTeardown(); }
function vfFinish(){
  const r = vfRun; if(!r) return;
  const res = r.T.result(), stray = r.stray, secs = Math.round((Date.now() - r.t0) / 1000), distCm = Math.round(r.distMm / 10);
  vfTeardown();
  const rel = { ...res.rel, st:Math.min(5000, stray), tr:Math.min(5000, res.rel.tr) };   // stray(빛 없이 누름)도 신뢰도에 반영
  const rec = { date:vfToday(), eye:res.eye, mapId:res.mapId, pts:res.pts, th:res.th, un:res.un, rel, reliable:VF.isReliable(rel), dist:distCm };
  VFS.tests.push(rec); VFS.last = VFS.tests.length - 1;
  vfShow('result'); vfRenderResult(VFS.last, { stray, secs });
  vfPersist();                                                   // 암호화해 계정 금고에 자동 저장
}

/* ── 격자 그림 (표시값: 앱 점수, 나빠진 점은 ▼ 와 굵은 테두리, 집중 구역은 ◆ 표시) ─── */
function vfMapSvg(eye, th, worseIdx, pts){
  const g = pts || VF.grid(eye), S = 11, PX = 34, PY = 22, W = 42 * S + PX * 2, H = 18 * S + PY * 2 + 14;
  const X = x => PX + (x + 21) * S, Y = y => PY + (9 - y) * S + 7;
  const wset = new Set(worseIdx || []), b = VF.blindCenter(eye);
  const small = g.some(p => p.role === 'focus');                     // 집중 점은 6° 간격 안에 들어가 칸을 줄입니다
  const cw = small ? 22 : 28, ch = small ? 18 : 22;
  const cells = g.map((p, i) => {
    const v = th[i], light = 20 + Math.round(60 * v / 30);
    const hit = wset.has(i);
    const stroke = hit ? 'var(--bad)' : p.zone ? 'var(--brand)' : 'currentColor';
    return `<g><rect x="${X(p.x) - cw / 2}" y="${Y(p.y) - ch / 2}" width="${cw}" height="${ch}" rx="4" fill="hsl(215 25% ${light}%)" stroke="${stroke}" stroke-width="${hit ? 2.5 : p.zone ? 2 : 0.5}" ${hit || p.zone ? '' : 'stroke-opacity=".25"'}/>`
         + `<text x="${X(p.x)}" y="${Y(p.y) + 4}" text-anchor="middle" font-size="${small ? 10 : 11}" fill="${light > 55 ? '#0b1017' : '#fff'}" font-family="ui-monospace,monospace">${v}${hit ? '▼' : ''}</text></g>`;
  }).join('');
  const bs = `<g opacity=".6"><ellipse cx="${X(b.x)}" cy="${Y(b.y)}" rx="12" ry="16" fill="none" stroke="currentColor" stroke-dasharray="3 3"/><text x="${X(b.x)}" y="${Y(b.y) + 4}" text-anchor="middle" font-size="9" fill="currentColor">맹점</text></g>`;
  const fx = `<g stroke="currentColor" stroke-width="1.5"><line x1="${X(0) - 5}" x2="${X(0) + 5}" y1="${Y(0)}" y2="${Y(0)}"/><line x1="${X(0)}" x2="${X(0)}" y1="${Y(0) - 5}" y2="${Y(0) + 5}"/></g>`;
  const tl = eye === 'R' ? ['코쪽', '귀쪽'] : ['귀쪽', '코쪽'];
  const labels = `<text x="${PX}" y="${H - 6}" font-size="11" fill="currentColor" opacity=".7">← ${tl[0]}</text><text x="${W - PX}" y="${H - 6}" text-anchor="end" font-size="11" fill="currentColor" opacity=".7">${tl[1]} →</text>`;
  return `<svg class="vf-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${VF.EYE_KO[eye]} 시야 지도. 숫자는 ${VU}, 클수록 잘 보임.">${cells}${bs}${fx}${labels}</svg>`;
}

const REL_KO = { fp:'빛이 없는데 누른 비율이 15%를 넘었습니다', fl:'맹점 확인 자극에 반응한 비율이 높습니다(시선 흔들림)', fn:'아주 밝은 자극을 놓친 비율이 높습니다', stray:'빛이 없을 때 누른 횟수가 전체 시행의 15%를 넘었습니다' };
function vfRenderResult(i, meta){
  const t = VFS.tests[i]; if(!t){ vfShow('home'); return; }
  const an = VF.analyzeEye(t.eye, VFS.tests, VFS.rules);
  const seg = VF.segmentOf(t.eye, VFS.tests).seg;
  const inSeg = seg.includes(t);
  const relList = seg.filter(x => x.reliable);
  const pos = relList.indexOf(t);
  const fol = inSeg && pos >= 2 ? an.follow[pos - 2] : null;
  const pts = VF.pointsOf(t), s = VF.statsOf(t), rel = t.rel, map = VF.mapOf(t);
  const probs = VF.relProblems(rel);
  const relTxt = t.reliable ? '신뢰할 수 있는 검사입니다.' : `<b>신뢰도가 낮아 판정에서 제외됩니다.</b> ${probs.map(k => REL_KO[k]).join(' · ')}. 조건을 확인하고 다시 검사하세요.`;
  const p = k => VF.pct(rel[k], rel[k + 'N']);
  const lines = [
    `거짓 신호(빛이 없는데 누름) ${p('fp') == null ? '–' : p('fp') + '%'} (${rel.fp}/${rel.fpN}) · 기준 15% 이하`,
    `고정 흔들림(맹점 확인 자극에 반응) ${p('fl') == null ? '–' : p('fl') + '%'} (${rel.fl}/${rel.flN})`,
    `놓침 확인(아주 밝은 자극을 놓침) ${p('fn') == null ? '–' : p('fn') + '%'} (${rel.fn}/${rel.fnN})`
  ];
  if(Number.isInteger(rel.st) && Number.isInteger(rel.tr)) lines.push(`빛이 없을 때 누른 횟수 ${rel.st}회 / 전체 시행 ${rel.tr}회${rel.tr ? ` (${Math.round(100 * rel.st / rel.tr)}%)` : ''} · 기준 15% 이하`);
  let change = '<p class="tiny">신뢰도가 낮은 검사라 기준선과 비교하지 않았습니다.</p>';
  if(t.reliable){
    if(!inSeg) change = `<p class="tiny">지금 비교에 쓰는 지도(${esc(an.mapId)})와 다른 지도(${esc(map.mapId)})의 기록이라 비교하지 않았습니다.</p>`;
    else if(an.state === 'baseline') change = `<p>이 검사는 <b>기준선 검사</b>로 쓰입니다 (${an.nReliable}/2). 같은 조건에서 ${an.need}번 더 하면 변화 비교가 시작됩니다.</p>`;
    else if(pos === 0 || pos === 1) change = `<p>이 검사는 <b>기준선 검사</b>입니다 (${pos + 1}/2).</p>`;
    else if(fol) change = `<p>기준선 대비 평균 ${VF.fmt(fol.dMs)}, 중심 10° ${VF.fmt(fol.dCentral)}, 귀쪽−코쪽(짝) ${VF.fmt(fol.dTN)}${fol.dFocus != null ? `, 집중 구역(${esc(VF.ZONE_KO[map.zone])}) ${VF.fmt(fol.dFocus)}` : ''} (${VU}), 나빠진 점 ${fol.nWorse}개 (붙은 최대 ${fol.cluster}개). `
         + `${fol.reasons.includes('focus') ? `<b>임시 변화 사유:</b> 집중 점 ${fol.nFocusWorse}개가 기준선보다 6점 이상 낮습니다(임상 검증 전 임시 기준). ` : ''}`
         + `${fol.worse ? '<b>기준선보다 나빠진 양상입니다.</b>' : '기준선과 비슷합니다.'}</p>`;
  }
  const saveNote = VFS.save === 'ok' || VFS.save === 'saving'
    ? `<div class="notice sec"><span class="ic">🔐</span><div><b>${VFS.save === 'ok' ? '암호화해 이 브라우저에 저장했습니다.' : '암호화해 저장하는 중입니다.'}</b> 브라우저 데이터를 지우면 사라질 수 있으니, 가끔 ‘백업 파일로 내보내기’로 따로 보관하세요.</div></div>`
    : `<div class="notice sec"><span class="ic">🔐</span><div><b>자동 저장이 끝나지 않았습니다.</b> 저장 상태를 확인하고, 필요하면 ‘백업 파일로 내보내기’로 보관하세요.</div></div>`;
  vfEl('vfResultTag').textContent = `${VF.EYE_KO[t.eye]} · ${t.date} · ${map.mapId}`;
  vfEl('vfResultBody').innerHTML =
      vfMapSvg(t.eye, t.th, fol ? fol.worseIdx : [], pts)
    + `<p class="tiny">숫자는 ${VU}(0~30)이며 클수록 잘 보입니다. 병원 시야계의 dB와 다르고, 화면·밝기가 보정되지 않아 <b>절대값이 아니라 내 기준선과의 변화</b>만 의미가 있습니다. 지도: ${esc(map.desc)}</p>`
    + `<p>전체 평균 <b>${VF.r1(s.ms)}</b> · 중심 10° <b>${VF.r1(s.central)}</b> · 귀쪽 ${VF.r1(s.temporal)} / 코쪽 ${VF.r1(s.nasal)} · 귀쪽−코쪽(짝 ${s.nPairs}개) ${VF.fmt(VF.r1(s.tn))}${s.focus != null ? ` · 집중 구역 ${VF.r1(s.focus)}` : ''}${t.un.length ? ` · 전혀 안 보인 점 ${t.un.length}개` : ''}</p>`
    + change
    + `<p>${relTxt}</p><ul class="tiny">${lines.map(l => `<li>${l}</li>`).join('')}${meta ? `<li>걸린 시간 ${Math.floor(meta.secs / 60)}분 ${meta.secs % 60}초</li>` : ''}</ul>`
    + saveNote
    + `<div class="vf-actions"><button class="btn" data-vf="setup">다른 눈 검사하기</button><button class="btn ghost" data-vf="home">처음으로</button><button class="btn ghost" data-vf="save-from-result">백업 파일로 내보내기</button></div>`;
}

/* ── 증상 점검 ───────────────────────────────────────────── */
function vfRenderSymptom(){
  vfEl('vfSymOut').innerHTML = '';
  vfEl('vfSymList').innerHTML = VF.SYMPTOMS.map(s =>
    `<label class="vf-check"><input type="checkbox" data-vfsym="${s.id}"> ${esc(s.text)}${s.tier === 'emergency' ? ' <span class="vf-tag">응급</span>' : ''}</label>`).join('')
    + '<label class="vf-check"><input type="checkbox" id="vfSymNone"> 해당하는 것이 없습니다</label>';
}
function vfSubmitSymptom(){
  const ids = [...document.querySelectorAll('[data-vfsym]')].filter(c => c.checked).map(c => c.dataset.vfsym);
  const none = vfEl('vfSymNone').checked;
  if(!ids.length && !none){ vfEl('vfSymOut').innerHTML = '<p class="help no">해당하는 항목을 고르거나 ‘해당하는 것이 없습니다’를 선택하세요.</p>'; return; }
  const today = vfToday(), clean = none ? [] : ids;
  VFS.symptoms = VFS.symptoms.filter(x => x.date !== today); VFS.symptoms.push({ date:today, ids:clean });
  VFS.symptoms.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  VFS.dirty = true; vfPersist();
  const lv = VF.symptomLevel(clean), info = VF.LEVEL[lv];
  vfEl('vfSymOut').innerHTML = `<div class="vf-level ${LV_CLASS[lv]}" style="margin-top:14px"><span class="vf-lvmark">${LV_MARK[lv]}</span><div><b>${esc(lv ? info.label : '새로 생긴 증상이 없습니다')}</b><br>${esc(lv ? info.action : '검사를 이어가세요. 증상이 생기면 다시 점검하세요.')}</div></div>`;
}

/* ── 진료용 요약 ─────────────────────────────────────────── */
function vfSummaryOf(){ return VF.buildSummary({ tests:VFS.tests, symptoms:VFS.symptoms, rules:VFS.rules }, VF.dayNum(vfToday())); }
function vfSummaryText(){
  const s = vfSummaryOf();
  return s.lines.join('\n') + '\n\n의사에게 할 질문\n' + s.questions.map((q, i) => `${i + 1}. ${q}`).join('\n') + `\n\n출력일 ${vfToday()}`;
}
function vfRenderSummary(){
  const s = vfSummaryOf();
  const maps = ['R', 'L'].map(eye => {
    const mine = VF.segmentOf(eye, VFS.tests).seg.filter(t => t.reliable);
    if(!mine.length) return '';
    const last = mine[mine.length - 1], an = VF.analyzeEye(eye, VFS.tests, VFS.rules);
    const l = an.latest || null;            // 가장 최근 신뢰 검사의 분석(기준선 검사뿐이면 없음)
    return `<div class="vf-sum-map"><b>${VF.EYE_KO[eye]} 최근 (${esc(last.date)} · ${esc(an.mapId)})</b>${vfMapSvg(eye, last.th, l ? l.worseIdx : [], VF.pointsOf(last))}</div>`;
  }).join('');
  const rows = VFS.tests.map(t => { const st = VF.statsOf(t);
    return `<tr><td>${esc(t.date)}</td><td>${VF.EYE_KO[t.eye]}</td><td>${esc(t.mapId || VF.LEGACY)}</td><td>${VF.r1(st.ms)}</td><td>${VF.r1(st.central)}</td><td>${VF.fmt(VF.r1(st.tn))}</td><td>${st.focus == null ? '–' : VF.r1(st.focus)}</td><td>${t.reliable ? '가능' : '낮음(제외)'}</td></tr>`; }).join('');
  const table = rows ? `<table class="rec"><thead><tr><th>날짜</th><th>눈</th><th>지도</th><th>평균</th><th>중심</th><th>귀쪽−코쪽</th><th>집중 구역</th><th>신뢰도</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  vfEl('vfPrintRoot').innerHTML = `<div id="vfPrintArea"><h3>${esc(s.lines[0])}</h3>`
    + s.lines.slice(1).map(l => `<p class="${l.startsWith('  ') ? 'vf-sub' : ''}">${esc(l.trim())}</p>`).join('')
    + `<div class="vf-sum-maps">${maps}</div>${table}<h4>의사에게 할 질문</h4><ol>${s.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol><p class="tiny">출력일 ${esc(vfToday())} · 숫자는 이 장치 기준의 ${VU}(0~30)이며 병원 시야계의 dB와 다릅니다.</p></div>`;
}

/* ── 백업 파일 내보내기·불러오기 ─────────────────────────── */
function vfOpenFile(mode){
  if(!S.acc || !S.masterKey) return;
  vfCloseFile();
  VFS.mode = mode; VFS.replaceAsk = false;
  vfEl('vfFilePanel').hidden = false;
  vfEl('vfPass').value = ''; vfEl('vfPass2').value = ''; vfEl('vfFileIn').value = '';
  vfEl('vfFileMsg').hidden = true;
  const save = mode === 'save';
  vfEl('vfPass2Row').hidden = !save; vfEl('vfFilePickRow').hidden = save;
  vfEl('vfFileGo').textContent = save ? '암호화해서 내보내기' : '불러오기';
  vfEl('vfFileHelp').textContent = save
    ? '기록은 이 브라우저에 자동으로 암호화 저장됩니다. 이 파일은 브라우저 데이터가 지워질 때를 대비한 백업입니다. 이름·이메일은 들어가지 않습니다. 비밀번호를 잊으면 복구할 수 없으니 따로 적어 두세요. 병원에는 이 파일이 아니라 ‘진료용 요약’을 보여 주세요.'
    : '이전에 내보낸 .sirius 백업 파일과 그 비밀번호를 입력하세요. 불러오면 현재 기록이 파일 내용으로 바뀌고 자동 저장됩니다.';
  (save ? vfEl('vfPass') : vfEl('vfFileIn')).focus();
}
function vfCloseFile(){
  vfFileSeq++;
  vfEl('vfFilePanel').hidden = true;
  vfEl('vfPass').value = ''; vfEl('vfPass2').value = ''; vfEl('vfFileIn').value = '';
  vfEl('vfFileGo').disabled = false;
  VFS.mode = ''; VFS.replaceAsk = false;
}
function vfLeave(){ vfCloseFile(); vfAbort(); }
function vfFileMsg(t){ const m = vfEl('vfFileMsg'); m.textContent = t; m.hidden = !t; }
function vfFileLive(t){
  return t && t.seq === vfFileSeq && S.acc === t.acc && S.masterKey === t.key && !!S.acc && !!S.masterKey
    && VFS.mode === t.mode && !vfEl('vfFilePanel').hidden;
}
async function vfFileGo(){
  if(!S.acc || !S.masterKey || vfEl('vfFileGo').disabled) return;
  vfFileMsg('');
  const pass = vfEl('vfPass').value;
  let ticket;
  try{
    if(VFS.mode === 'save'){
      if(pass !== vfEl('vfPass2').value) return vfFileMsg('두 비밀번호가 다릅니다.');
      const prob = VFFile.passProblem(pass); if(prob) return vfFileMsg(prob);
      const snapshot = VF.cleanState(VF.exportable({tests:VFS.tests,symptoms:VFS.symptoms,rules:VFS.rules}));
      ticket = {seq:++vfFileSeq,acc:S.acc,key:S.masterKey,mode:VFS.mode};
      vfEl('vfFileGo').disabled = true;
      const text = await VFFile.encrypt(snapshot, pass);
      if(!vfFileLive(ticket)) return;
      VFFile.download(text, VFFile.fileName());
      vfCloseFile(); vfRenderStatus();
    } else if(VFS.mode === 'load'){
      const file = vfEl('vfFileIn').files && vfEl('vfFileIn').files[0];
      if(!file) return vfFileMsg('불러올 파일을 선택하세요.');
      if(!(file.size >= 0) || file.size > VFFile.MAX_BYTES) return vfFileMsg(VFFile.FAIL);
      if((VFS.tests.length || VFS.symptoms.length) && !VFS.replaceAsk){
        VFS.replaceAsk = true; vfEl('vfFileGo').textContent = '지금 기록을 바꾸고 불러오기';
        return vfFileMsg('현재 기록이 파일 내용으로 바뀝니다(합치지 않습니다). 한 번 더 누르면 바꿉니다. 먼저 지금 기록을 백업해 두기를 권합니다.');
      }
      const before = JSON.stringify(VF.exportable({tests:VFS.tests,symptoms:VFS.symptoms,rules:VFS.rules}));
      ticket = {seq:++vfFileSeq,acc:S.acc,key:S.masterKey,mode:VFS.mode};
      vfEl('vfFileGo').disabled = true;
      const text = await file.text();
      if(!vfFileLive(ticket)) return;
      const st = await VFFile.decrypt(text, pass);
      if(!vfFileLive(ticket)) return;
      if(JSON.stringify(VF.exportable({tests:VFS.tests,symptoms:VFS.symptoms,rules:VFS.rules})) !== before)
        return vfFileMsg('불러오는 동안 기록이 바뀌었습니다. 현재 기록을 확인한 뒤 다시 불러와 주세요.');
      VFS.tests = st.tests; VFS.symptoms = st.symptoms; VFS.rules = st.rules; VFS.delAsk = -1;
      vfCloseFile(); vfRenderHome(); vfPersist();
    }
  }catch(e){ if(!ticket || vfFileLive(ticket)) vfFileMsg(VFFile.FAIL); }
  finally{ if(ticket && vfFileLive(ticket)) vfEl('vfFileGo').disabled = false; }
}

/* ── 이벤트 ──────────────────────────────────────────────── */
const vfPage = document.querySelector('[data-page="field"]');
vfPage.addEventListener('click', e => {
  const del = e.target.closest('[data-vfdel]'), open = e.target.closest('[data-vfopen]'), b = e.target.closest('[data-vf]');
  if(del){
    const i = +del.dataset.vfdel;
    if(VFS.delAsk !== i){ VFS.delAsk = i; vfRenderHistory(); return; }
    VFS.tests.splice(i, 1); VFS.delAsk = -1; VFS.dirty = true; vfRenderHome(); vfPersist(); return;
  }
  if(open){ const i = +open.dataset.vfopen; vfShow('result'); vfRenderResult(i); return; }
  if(!b) return;
  VFS.delAsk = -1;
  const a = b.dataset.vf;
  if(a === 'home') vfShow('home');
  else if(a === 'setup') vfShow('setup');
  else if(a === 'symptom') vfShow('symptom');
  else if(a === 'summary') vfShow('summary');
  else if(a === 'save') vfOpenFile('save');
  else if(a === 'load') vfOpenFile('load');
  else if(a === 'save-from-result'){ vfShow('home'); vfOpenFile('save'); }
});
vfPage.addEventListener('input', e => {
  const t = e.target;
  if(t.id === 'vfCardW'){ VFS.cardMoved = true; vfRenderSetup(); }
  else if(t.id === 'vfDist' || t.matches('[data-vfchk]')) vfRenderSetup();
  else if(t.dataset && t.dataset.vfrule){
    VFS.rules = VF.sanitizeRules({ ...VFS.rules, [t.dataset.vfrule]: t.value }); VFS.dirty = true; vfRenderStatus();
  }
  else if(t.id === 'vfSymNone' && t.checked) document.querySelectorAll('[data-vfsym]').forEach(c => { c.checked = false; });
  else if(t.dataset && t.dataset.vfsym && t.checked && vfEl('vfSymNone')) vfEl('vfSymNone').checked = false;
});
vfEl('vfRules').addEventListener('change', e => { if(e.target.dataset.vfrule){ vfRenderRules(); vfPersist(); } });
vfEl('vfRulesReset').onclick = () => { VFS.rules = { ...VF.RULES_DEFAULT }; VFS.dirty = true; vfRenderRules(); vfRenderStatus(); vfPersist(); };
vfEl('vfEye').addEventListener('click', e => { const b = e.target.closest('button'); if(b){ VFS.eye = b.dataset.eye === 'L' ? 'L' : 'R'; vfRenderSetup(); } });
vfEl('vfStart').onclick = vfStartStage;
vfEl('vfBegin').onclick = vfBegin;
vfEl('vfIntroQuit').onclick = () => { vfAbort(); vfShow('setup'); };
vfEl('vfPause').onclick = vfPause;
vfEl('vfResume').onclick = vfResume;
vfEl('vfQuit').onclick = () => { vfAbort(); vfShow('home'); };
vfEl('vfSymGo').onclick = vfSubmitSymptom;
vfEl('vfFileGo').onclick = vfFileGo;
vfEl('vfFileCancel').onclick = vfCloseFile;
vfEl('vfFileIn').addEventListener('change', () => { vfFileSeq++; VFS.replaceAsk=false; vfEl('vfFileGo').disabled=false; vfEl('vfPass').value=''; vfFileMsg(''); });
vfEl('vfCopy').onclick = async e => {
  const b = e.target;
  try{ await navigator.clipboard.writeText(vfSummaryText()); b.textContent = '복사했습니다'; }
  catch(err){ b.textContent = '복사할 수 없습니다'; }
  setTimeout(() => { b.textContent = '글로 복사'; }, 1800);
};
vfEl('vfPrint').onclick = () => {
  const root = document.documentElement;
  root.classList.add('vf-printing');
  window.addEventListener('afterprint', () => root.classList.remove('vf-printing'), { once:true });
  window.print();
};
window.addEventListener('beforeunload', e => { if((VFS.dirty || VFS.save === 'saving') && (VFS.tests.length || VFS.symptoms.length)){ e.preventDefault(); e.returnValue = ''; } });

/* 나가기·유휴 잠금: 검사 중단, 기록·입력값·화면을 모두 비웁니다 (계정 금고의 암호문은 그대로) */
function vfReset(){
  vfSaveSeq++;                                           // 늦게 끝난 저장 결과가 다음 세션 화면을 바꾸지 못하게
  vfCloseFile();
  vfTeardown();
  VFS.tests = []; VFS.symptoms = []; VFS.rules = { ...VF.RULES_DEFAULT }; VFS.dirty = false; VFS.delAsk = -1; VFS.last = -1;
  VFS.eye = 'R'; VFS.cardMoved = false; VFS.replaceAsk = false; VFS.mode = ''; VFS.save = '';
  VFS.ctx = { loc:'unknown', side:'unknown', from:false };
  if(typeof S !== 'undefined') S.vf = null;
  for(const id of ['vfPass', 'vfPass2', 'vfFileIn']) vfEl(id).value = '';
  vfEl('vfFilePanel').hidden = true; vfEl('vfFileMsg').hidden = true; vfEl('vfFileMsg').textContent = '';
  document.querySelectorAll('[data-vfchk]').forEach(c => { c.checked = false; });
  vfEl('vfCardW').value = 320; vfEl('vfDist').value = 33;
  for(const id of ['vfStatus', 'vfTrend', 'vfHistory', 'vfResultBody', 'vfPrintRoot', 'vfSymOut', 'vfSymList', 'vfRules', 'vfMapPreview']){ const el = vfEl(id); if(el) el.innerHTML = ''; }
  vfEl('vfResultTag').textContent = ''; vfEl('vfDirty').textContent = '';
  vfShow('home');
}
vfShow('home');
