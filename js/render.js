'use strict';

/* ═══════════════════════════════════════════════════════════
   I. 화면 갱신
   ═══════════════════════════════════════════════════════════ */
function renderAll(){
  const a = S.analysis; if(!a) return;
  const R = S.regions;
  const isModel = a.kind === 'model';
  const attentionLabel = isModel ? '모델 주목도' : '비대칭 점수';
  // 데모 휴리스틱은 학습 모델이 아니므로 퍼센트·유형 추정을 보여 주지 않습니다(확률처럼 읽히는 것을 막음)
  const scoreText = r => isModel ? ` · ${attentionLabel} ${(r.conf*100).toFixed(0)}%` : '';
  $('vTitle').textContent = R.length
    ? `눈여겨볼 곳 ${R.length}군데 — 가장 뚜렷한 곳은 ${R[0].name}`
    : a.kind === 'model' ? '모델 주목 영역이 뚜렷하지 않습니다' : '한쪽에만 두드러지는 부분은 찾지 못했습니다';
  $('vConf').textContent = R.length && isModel ? `${attentionLabel} ${(R[0].conf*100).toFixed(0)}% · ${ENGINE.name}` : `${ENGINE.name}${isModel ? '' : ' · 진단 아님'}`;
  $('report').innerHTML = buildReport(a, R, S.compared, S.simple).map(p=>`<p>${linkTerms(p)}</p>`).join('');
  $('findings').innerHTML = R.length ? R.map((r,i)=>`
    <div class="finding">
      <div class="top">
        <span class="num" style="background:var(${COLORVAR[r.status]})">${i+1}</span>
        <div><div class="nm">${esc(r.name)}</div><div class="ds">${esc(r.change)}${scoreText(r)}</div></div>
        <span class="tag t-${r.status}">${STATUS_KO[r.status]}</span>
      </div>
    </div>`).join('') : `<p class="tiny">${a.kind === 'model' ? '모델 주목 영역이 뚜렷하지 않습니다.' : '한쪽에만 두드러지는 부위를 찾지 못했습니다.'}</p>`;

  // 분석 신뢰도 막대
  const top = R.length ? R[0].conf : 0;
  $('confWrap').hidden = !R.length || !isModel;
  $('confPct').textContent = R.length ? `${(top*100).toFixed(0)}%` : '—';
  $('confBar').style.width = `${(top*100).toFixed(0)}%`;
  $('probsWrap').hidden = !isModel;
  $('probsTitle').textContent = ENGINE.probsTitle;
  $('confNote').textContent = ENGINE.confNote;
  const order = CLASSES.map((c,i)=>({...c, p:a.probs[i]})).sort((x,y)=>y.p-x.p);
  $('probs').innerHTML = order.map(c=>`
    <div class="prob">
      <span title="${esc(c.hint)}">${c.ko}</span>
      <span class="track"><span class="fill" style="width:${(c.p*100).toFixed(1)}%"></span></span>
      <span class="pct mono">${(c.p*100).toFixed(0)}%</span>
    </div>`).join('');
  $('questions').innerHTML = buildQuestions(a, R, S.compared).map(q=>`<li>${esc(q)}</li>`).join('');
  $('checkBox').hidden = false;
  $('saveScan').disabled = S.guest || !S.src;
  $('scanLabel').textContent = `${S.scans.length+1}차 분석 · ${new Date().toLocaleDateString('ko-KR')}`;
  $('fbQuality').textContent = `품질 ${a.quality}`;
  renderGlossary();
  draw();
}
function renderTimeline(){
  const safeThumb = value => typeof value === 'string' && value.length <= 1024*1024 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : '';
  const safeStatus = value => ['good','bad','spread','neutral'].includes(value) ? value : 'neutral';
  $('tlScroll').innerHTML = !S.scans.length ? '' : `
    <table class="rec">
      <thead><tr><th>회차</th><th>날짜</th><th>이미지</th><th>주요 부위</th><th>상태</th><th></th></tr></thead>
      <tbody>${S.scans.map((s,i)=>`
        <tr>
          <td class="mono">${i+1}차</td>
          <td class="mono">${esc(s.date)}</td>
          <td><img src="${safeThumb(s.thumb)}" alt="${i+1}차 영상 축소본"></td>
          <td>${s.regions.length ? esc(s.regions[0].name) + (s.regions.length>1 ? ` 외 ${s.regions.length-1}곳` : '') : '특이 소견 없음'}</td>
          <td><span class="recdots">${s.regions.length ? s.regions.map(r=>`<i class="dot ${safeStatus(r.status)}"></i>`).join('') : '<i class="dot neutral"></i>'}</span></td>
          <td><button class="btn sm tlcard" data-i="${i}">결과 보기</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  $('tlEmpty').hidden = S.scans.length > 0;
  const sum = S.scans.reduce((a,s)=>a + (s.cost||0), 0);
  $('costSum').textContent = sum ? `누적 ${sum.toLocaleString('ko-KR')}원 · ${S.scans.length}회` : '누적 —';
}
