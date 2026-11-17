'use strict';
/* ═══════════════════════════════════════════════════════════
   F. 경과 관찰 — 핵심 규칙 (DOM·저장소·네트워크 없음)
   ───────────────────────────────────────────────────────────
   · 종양 위치(6개+모름)에 따라 체크 구성이 정해지고, 기록은 날짜별로 쌓입니다.
   · 판정하지 않습니다. 첫 측정(기준점)과 비교해 "비슷함 / 변화 있음"만 말합니다.
   · 아래 TOL 값은 화면 표시용 약속일 뿐 의학적 기준이 아닙니다. 임상 임계치나 기준 범위를 쓰지 않습니다.
   · 상태(state)는 JSON으로 직렬화 가능한 객체이며, 모든 입력은 화이트리스트로 검증합니다. 자유 입력 문자열은 없습니다.
   ═══════════════════════════════════════════════════════════ */
const FU = (() => {
  const V = 1;
  const MAX_CHECKS = 300, MAX_MRI = 60;
  const TAP_MS = 10000;

  /* 종양 위치 6개 + 모름 (MSD Manual 위치별 증상 표 기준 — 기획서) */
  const LOCS = Object.freeze([
    { id:'sellar',      ko:'안장결절 · 접형골 날개 안쪽', hint:'시력·시야가 영향을 받을 수 있는 위치' },
    { id:'cavernous',   ko:'해면정맥동',                 hint:'복시·얼굴 감각이 영향을 받을 수 있는 위치' },
    { id:'olfactory',   ko:'후각구 · 전두 기저부',        hint:'후각·성격 변화가 영향을 받을 수 있는 위치' },
    { id:'parasagittal',ko:'시상동 옆 · 대뇌낫',          hint:'반대쪽 다리부터 힘·감각이 영향을 받을 수 있는 위치' },
    { id:'convexity',   ko:'대뇌 볼록면',                hint:'부분 발작·인지가 영향을 받을 수 있는 위치' },
    { id:'cpa',         ko:'소뇌교각 · 후두개와',         hint:'청력·얼굴·균형이 영향을 받을 수 있는 위치' },
    { id:'unknown',     ko:'모름 (판독지를 아직 못 봄)',   hint:'기본 체크를 구성합니다' },
  ]);
  const LOC_IDS = new Set(LOCS.map(l => l.id));
  /* 종양이 치우친 쪽. 판독지 표기: midline(가운데) · Lt.(왼쪽) · Rt.(오른쪽). 예전 기록(값 없음)은 unknown */
  const SIDES = Object.freeze([
    { id:'mid',     ko:'가운데 (midline)', hint:'판독지에 midline 또는 정중앙으로 적힌 경우' },
    { id:'left',    ko:'왼쪽 (Lt.)',      hint:'판독지에 Lt. 또는 left 로 적힌 경우' },
    { id:'right',   ko:'오른쪽 (Rt.)',     hint:'판독지에 Rt. 또는 right 로 적힌 경우' },
    { id:'unknown', ko:'모름',            hint:'모르면 가운데와 같은 검사 지도로 봅니다' },
  ]);
  const SIDE_IDS = new Set(SIDES.map(s => s.id));

  const TYPES = Object.freeze(['tap', 'vf4', 'sym', 'smell', 'hear', 'care']);
  const TYPE_KO = Object.freeze({
    tap:'손가락 두드리기', vf4:'간단 시야(한 눈씩)', sym:'증상 기록', smell:'후각 기록', hear:'청력 기록', care:'보호자 관찰 기록',
  });
  const TYPE_SET = new Set(TYPES);

  /* 위치별 구성: core = 먼저 권하는 체크, sym = 증상 기록에 보이는 항목,
     precise = 첫 권장이 '시야 기록' 화면의 정밀 시야검사(이때 vf4 는 빠른 확인용으로 남김) */
  const SETUP = Object.freeze({
    sellar:       { core:['vf4','sym'],        sym:['vis1','vis2','headache'], precise:true },
    cavernous:    { core:['sym','vf4'],        sym:['dip','eyemv','facenum'] },
    olfactory:    { core:['smell','care','sym'], sym:['smellchg','memory'] },
    parasagittal: { core:['tap','sym','care'], sym:['weak','balance','headache'] },
    convexity:    { core:['tap','sym','care'], sym:['seiz','memory','weak'] },
    cpa:          { core:['hear','sym','care'], sym:['hearing','facenum','balance'] },
    unknown:      { core:['vf4','tap','sym'],  sym:['vis1','vis2','dip','facenum','smellchg','hearing','weak','seiz','memory','balance','headache'] },
  });

  /* 증상 기록 항목: em=true 는 응급 안내 대상, needsCare=true 는 보호자가 옆에 있을 때만 */
  const EMERGENCY = Object.freeze([
    { id:'em1', ko:'갑자기 팔·다리에 힘이 빠지거나 마비됨', em:true },
    { id:'em2', ko:'갑자기 말이 어눌해지거나 말이 안 나옴', em:true },
    { id:'em3', ko:'갑자기 얼굴 한쪽이 처짐', em:true },
    { id:'em4', ko:'평소와 다른 심한 두통', em:true },
    { id:'em5', ko:'갑자기 시력이 크게 떨어지거나 한쪽이 안 보임', em:true },
  ]);
  const SYM_ITEMS = Object.freeze([
    ...EMERGENCY,
    { id:'vis1', ko:'시야가 좁아지거나 한쪽이 가려 보이는 느낌' },
    { id:'vis2', ko:'글자나 물체가 전보다 흐릿하게 보임' },
    { id:'dip', ko:'물체가 겹쳐 보임(복시)' },
    { id:'eyemv', ko:'눈을 움직일 때 불편하거나 한쪽 눈이 잘 안 움직이는 느낌' },
    { id:'facenum', ko:'얼굴 한쪽 감각이 둔함' },
    { id:'smellchg', ko:'냄새를 전보다 잘 못 맡음' },
    { id:'hearing', ko:'한쪽 귀가 전보다 잘 안 들리거나 귀울림이 있음' },
    { id:'weak', ko:'한쪽 팔·다리에 힘이 빠지거나 저림이 있음' },
    { id:'seiz', ko:'경련이나 갑자기 멍해지는 일이 있었음' },
    { id:'memory', ko:'기억·집중이 전보다 어려움' },
    { id:'balance', ko:'걸을 때 균형이 불안함 (보호자가 옆에 있을 때만 확인)', needsCare:true },
    { id:'headache', ko:'두통이 평소보다 잦음' },
  ]);
  const SYM_BY_ID = Object.freeze(Object.fromEntries(SYM_ITEMS.map(i => [i.id, i])));
  const EM_IDS = new Set(EMERGENCY.map(i => i.id));

  /* 보호자가 관찰하는 항목 */
  const CARE_ITEMS = Object.freeze([
    { id:'pers', ko:'성격이나 행동이 전과 다르다고 느낌' },
    { id:'seiz', ko:'경련이나 멍해짐을 직접 봄' },
    { id:'bal', ko:'걸을 때 비틀거리는 모습을 봄' },
    { id:'mem', ko:'같은 말을 반복하거나 잊는 일이 늘었다고 느낌' },
    { id:'sleep', ko:'잠이 늘었거나 활동이 줄었다고 느낌' },
    { id:'facemv', ko:'웃거나 눈을 감을 때 얼굴 양쪽의 움직임이 전과 다르게 보임' },   // 보호자가 눈으로 보고 느낀 것만(사진·카메라 분석 없음)
  ]);
  /* 위치별로 특히 살펴볼 보호자 관찰 항목(앞에 둠). 응급인 갑작스러운 얼굴 처짐은 증상 기록의 응급 항목(em3)이 따로 맡음 */
  const CARE_FOCUS = Object.freeze({ cpa:['facemv', 'bal'], cavernous:['facemv'] });
  const CARE_BY_ID = Object.freeze(Object.fromEntries(CARE_ITEMS.map(i => [i.id, i])));

  const HORMONE = Object.freeze({
    unknown:'아직 확인하지 않음',
    now:'지금 사용하고 있음',
    past:'예전에 사용한 적 있음',
    never:'사용한 적 없음',
  });
  const LEVEL3 = Object.freeze({
    smell:['못 맡음', '약하게 맡음', '뚜렷하게 맡음'],
    hear:['들리지 않음', '작게 들림', '잘 들림'],
  });

  /* 화면 표시용 약속 (의학적 기준 아님) */
  const TOL = Object.freeze({
    tapCount:0.2,     // 한 손 두드린 횟수가 첫 측정 대비 20% 이상 다름
    tapLR:20,         // 좌우 차이(%)가 첫 측정과 20%p 이상 다름
    tapCv:15,         // 리듬 흔들림(%)이 첫 측정과 15%p 이상 다름
    vfDir:2,          // 한 방향에서 본 횟수(0~3)가 첫 측정과 2 이상 다름
    vfTotal:3,        // 한 눈의 총합(0~12)이 첫 측정과 3 이상 다름
    streak:2,         // 변화 있음이 이어진 기록 수
  });

  /* ── 날짜 ── */
  const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isDate(s){
    if(typeof s !== 'string') return false;
    const m = RE_DATE.exec(s); if(!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if(y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }
  const dayNum = s => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
  function localDate(d = new Date()){
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  /* ── 정제 ── */
  function normSize(v){
    if(typeof v === 'string' && v.trim() !== '' && /^\d{1,3}([.,]\d{1,2})?$/.test(v.trim())) v = parseFloat(v.trim().replace(',', '.'));
    if(typeof v !== 'number' || !Number.isFinite(v) || v < 0.1 || v > 150) return null;
    return Math.round(v * 10) / 10;
  }
  function normTap(raw){
    const h = x => {
      if(!x || typeof x !== 'object') return null;
      const n = x.n, cv = x.cv;
      if(!isInt(n, 0, 300)) return null;
      if(cv !== null && cv !== undefined && !isInt(cv, 0, 500)) return null;
      return { n, cv: cv === undefined ? null : cv };
    };
    const L = h(raw.L), R = h(raw.R);
    return L && R ? { L, R } : null;
  }
  function normVf4(raw){
    if(raw.eye !== 'R' && raw.eye !== 'L') return null;
    const s = raw.seen, c = raw.catch;
    if(!s || typeof s !== 'object' || !c || typeof c !== 'object') return null;
    const seen = {};
    for(const k of ['u', 'd', 'l', 'r']){ if(!isInt(s[k], 0, 3)) return null; seen[k] = s[k]; }
    if(!isInt(c.shown, 0, 2) || !isInt(c.pressed, 0, c.shown)) return null;
    const out = { eye:raw.eye, seen, catch:{ shown:c.shown, pressed:c.pressed } };
    if(raw.fw !== undefined && raw.fw !== null){ if(!isInt(raw.fw, 100, 3000)) return null; out.fw = raw.fw; }   // 검사 화면 한 변(px, 50 단위): 기기·창 크기가 바뀌면 비교에 한계
    return out;
  }
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function normIds(arr, allowed){
    if(!Array.isArray(arr) || arr.length > 40) return null;
    const out = [];
    for(const x of arr){ if(typeof x !== 'string' || !own(allowed, x)) return null; if(!out.includes(x)) out.push(x); }
    return out;
  }
  function normLevel(raw){
    return isInt(raw.L, 0, 2) && isInt(raw.R, 0, 2) ? { L:raw.L, R:raw.R } : null;
  }
  function normCheck(raw, today){
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if(typeof raw.type !== 'string' || !TYPE_SET.has(raw.type) || !isDate(raw.date)) return null;
    if(today && dayNum(raw.date) > dayNum(today)) return null;
    const base = { type:raw.type, date:raw.date };
    let p = null;
    if(raw.type === 'tap') p = normTap(raw);
    else if(raw.type === 'vf4') p = normVf4(raw);
    else if(raw.type === 'sym'){ const it = normIds(raw.items, SYM_BY_ID); p = it ? { items:it } : null; }
    else if(raw.type === 'care'){ const it = normIds(raw.items, CARE_BY_ID); p = it ? { items:it } : null; }
    else p = normLevel(raw);               // smell, hear
    return p ? Object.assign(base, p) : null;
  }

  const empty = () => ({ v:V, loc:'unknown', side:'unknown', next:null, mri:[], checks:[], meds:{ hormone:'unknown', date:null }, nid:1 });

  function byDate(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; }

  /** 저장소에서 읽은 값·외부 입력 → 안전한 상태. 잘못된 항목은 버리고 형식이 다르면 빈 상태를 돌려줍니다. */
  function clean(raw, todayArg){
    const today = isDate(todayArg) ? todayArg : localDate();   // 촬영일·체크 날짜는 오늘 이후일 수 없음(다음 MRI 예정일만 미래 가능)
    const out = empty();
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    if(raw.v !== V) return out;
    if(typeof raw.loc === 'string' && LOC_IDS.has(raw.loc)) out.loc = raw.loc;
    if(typeof raw.side === 'string' && SIDE_IDS.has(raw.side)) out.side = raw.side;   // 없으면(예전 기록) unknown
    if(isDate(raw.next)) out.next = raw.next;
    if(Array.isArray(raw.mri)){
      const seen = new Set();
      for(const m of raw.mri.slice(0, MAX_MRI * 2)){
        if(!m || typeof m !== 'object' || !isDate(m.date) || seen.has(m.date)) continue;
        const size = normSize(m.size); if(size === null || dayNum(m.date) > dayNum(today)) continue;
        seen.add(m.date); out.mri.push({ date:m.date, size });
        if(out.mri.length >= MAX_MRI) break;
      }
      out.mri.sort((a, b) => a.date < b.date ? -1 : 1);
    }
    if(Array.isArray(raw.checks)){
      const ids = new Set(); let nid = 1;
      const list = [];
      for(const c of raw.checks.slice(0, MAX_CHECKS * 2)){
        const n = normCheck(c, today); if(!n) continue;
        let id = c.id;
        if(!Number.isInteger(id) || id < 1 || id > 1e9 || ids.has(id)) id = 0;
        n.id = id; list.push(n);
        if(id) ids.add(id);
        if(list.length >= MAX_CHECKS) break;
      }
      for(const n of list){ if(!n.id){ while(ids.has(nid)) nid++; n.id = nid; ids.add(nid); } }
      list.sort(byDate);
      out.checks = list;
      out.nid = list.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    }
    const md = raw.meds;
    if(md && typeof md === 'object' && typeof md.hormone === 'string' && Object.prototype.hasOwnProperty.call(HORMONE, md.hormone)){
      out.meds.hormone = md.hormone;
      out.meds.date = isDate(md.date) ? md.date : null;
    }
    return out;
  }

  /* ── 상태 바꾸기 (항상 새 객체, 실패하면 {ok:false,error}) ── */
  const fail = error => ({ ok:false, error });
  function setLoc(state, loc){
    if(typeof loc !== 'string' || !LOC_IDS.has(loc)) return fail('종양 위치를 목록에서 골라 주세요.');
    const s = clean(state); s.loc = loc;
    return { ok:true, state:s };
  }
  function setSide(state, side){
    if(typeof side !== 'string' || !SIDE_IDS.has(side)) return fail('치우친 쪽을 목록에서 골라 주세요.');
    const s = clean(state); s.side = side;
    return { ok:true, state:s };
  }
  function setNext(state, date){
    const s = clean(state);
    if(date === null || date === '') { s.next = null; return { ok:true, state:s }; }
    if(!isDate(date)) return fail('다음 MRI 예정일을 날짜로 입력해 주세요.');
    s.next = date; return { ok:true, state:s };
  }
  /** MRI 크기 기록을 추가하거나 같은 촬영일의 값을 바꿉니다. today 이후 날짜는 받지 않습니다. */
  function addMri(state, date, size, today){
    const s = clean(state, today);
    if(!isDate(date)) return fail('촬영일을 날짜로 입력해 주세요.');
    if(today && dayNum(date) > dayNum(today)) return fail('촬영일이 오늘 이후입니다. 다음 MRI 예정일 칸에 입력해 주세요.');
    const sz = normSize(size);
    if(sz === null) return fail('종양 크기는 0.1~150 mm 사이 숫자로 입력해 주세요.');
    const i = s.mri.findIndex(m => m.date === date);
    if(i >= 0) s.mri[i].size = sz;
    else{
      if(s.mri.length >= MAX_MRI) return fail(`MRI 기록은 ${MAX_MRI}개까지 둘 수 있습니다.`);
      s.mri.push({ date, size:sz });
    }
    s.mri.sort((a, b) => a.date < b.date ? -1 : 1);
    return { ok:true, state:s, replaced:i >= 0 };
  }
  function removeMri(state, date){
    const s = clean(state); const n = s.mri.length;
    s.mri = s.mri.filter(m => m.date !== date);
    return { ok:s.mri.length !== n, state:s };
  }
  function addCheck(state, rec, today){
    const s = clean(state, today);
    const n = normCheck(rec, today);
    if(!n) return fail('기록 내용이 올바르지 않습니다. 날짜와 값을 다시 확인해 주세요.');
    if(s.checks.length >= MAX_CHECKS) return fail(`체크 기록은 ${MAX_CHECKS}개까지 둘 수 있습니다. 오래된 기록을 지운 뒤 다시 시도해 주세요.`);
    n.id = s.nid; s.nid++;
    s.checks.push(n); s.checks.sort(byDate);
    return { ok:true, state:s, id:n.id };
  }
  function removeCheck(state, id){
    const s = clean(state); const n = s.checks.length;
    s.checks = s.checks.filter(c => c.id !== id);
    return { ok:s.checks.length !== n, state:s };
  }
  function setMeds(state, hormone, date, today){
    const s = clean(state, today);
    if(typeof hormone !== 'string' || !Object.prototype.hasOwnProperty.call(HORMONE, hormone)) return fail('약 사용 여부를 목록에서 골라 주세요.');
    if(date !== null && date !== '' && date !== undefined){
      if(!isDate(date) || (today && dayNum(date) > dayNum(today))) return fail('날짜를 올바르게 입력해 주세요.');
    }
    s.meds = { hormone, date: (hormone === 'unknown' || hormone === 'never' || !date) ? null : date };
    return { ok:true, state:s };
  }

  /* ── 두드리기 / 간단 시야 측정값 계산 ── */
  /** times: 시작 후 ms. 10초를 넘는 값·잘못된 값은 버리고, 30 ms 안의 중복 입력은 한 번으로 셉니다. */
  function tapMetrics(times){
    const t = (Array.isArray(times) ? times : []).filter(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= TAP_MS).sort((a, b) => a - b);
    const keep = [];
    for(const x of t){ if(!keep.length || x - keep[keep.length - 1] >= 30) keep.push(x); }
    const n = Math.min(keep.length, 300);
    let cv = null;
    if(n >= 6){
      const iv = []; for(let i = 1; i < n; i++) iv.push(keep[i] - keep[i - 1]);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / iv.length);
      if(mean > 0) cv = Math.min(500, Math.round(sd / mean * 100));
    }
    return { n, cv };
  }
  const tapLR = rec => { const mx = Math.max(rec.L.n, rec.R.n); return mx ? Math.round(Math.abs(rec.L.n - rec.R.n) / mx * 100) : null; };

  const DIRS = Object.freeze(['u', 'd', 'l', 'r']);
  const DIR_KO = Object.freeze({ u:'위', d:'아래', l:'왼쪽', r:'오른쪽' });
  /** 4방향 × 3번 + 아무것도 안 나오는 확인용 2번을 섞습니다. rand 는 테스트용으로 바꿀 수 있습니다. */
  function vfPlan(rand = Math.random){
    const t = [];
    for(const d of DIRS) for(let i = 0; i < 3; i++) t.push(d);
    t.push(null, null);
    for(let i = t.length - 1; i > 0; i--){ const j = Math.floor(rand() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
    return t.map(dir => ({ dir, wait:1200 + Math.floor(rand() * 1600) }));
  }
  function vfScore(results){
    const seen = { u:0, d:0, l:0, r:0 }; const c = { shown:0, pressed:0 };
    for(const r of Array.isArray(results) ? results : []){
      if(!r) continue;
      if(r.dir === null){ c.shown++; if(r.pressed) c.pressed++; }
      else if(seen[r.dir] !== undefined && r.pressed) seen[r.dir]++;
    }
    c.shown = Math.min(2, c.shown); c.pressed = Math.min(c.shown, c.pressed);
    return { seen, catch:c };
  }
  const vfTotal = rec => rec.seen.u + rec.seen.d + rec.seen.l + rec.seen.r;
  const vfReliable = rec => rec.catch.pressed < 2;

  /* ── 기준점 비교 ── */
  const checksOf = (s, type, eye) => s.checks.filter(c => c.type === type && (!eye || c.eye === eye));
  function diffRecord(type, base, cur){
    const why = [];
    if(type === 'tap'){
      for(const [k, nm] of [['L', '왼손'], ['R', '오른손']]){
        if(base[k].n > 0 ? Math.abs(cur[k].n - base[k].n) / base[k].n >= TOL.tapCount : cur[k].n > 0)
          why.push(`${nm} 두드린 횟수 ${base[k].n}회 → ${cur[k].n}회`);
      }
      const a = tapLR(base), b = tapLR(cur);
      if(a !== null && b !== null && Math.abs(a - b) >= TOL.tapLR) why.push(`좌우 차이 ${a}% → ${b}%`);
      for(const [k, nm] of [['L', '왼손'], ['R', '오른손']]){
        if(base[k].cv !== null && cur[k].cv !== null && Math.abs(base[k].cv - cur[k].cv) >= TOL.tapCv) why.push(`${nm} 리듬 흔들림 ${base[k].cv}% → ${cur[k].cv}%`);
      }
    } else if(type === 'vf4'){
      for(const d of DIRS) if(Math.abs(cur.seen[d] - base.seen[d]) >= TOL.vfDir) why.push(`${DIR_KO[d]} 방향 ${base.seen[d]}/3 → ${cur.seen[d]}/3`);
      const a = vfTotal(base), b = vfTotal(cur);
      if(!why.length && Math.abs(a - b) >= TOL.vfTotal) why.push(`전체 ${a}/12 → ${b}/12`);
    } else if(type === 'sym' || type === 'care'){
      const names = type === 'sym' ? SYM_BY_ID : CARE_BY_ID;
      for(const id of cur.items) if(!base.items.includes(id)) why.push(`새로 체크함: ${names[id].ko}`);
    } else {                                   // smell, hear
      for(const k of ['L', 'R']) if(cur[k] !== base[k]) why.push(`${k === 'L' ? '왼쪽' : '오른쪽'} ${LEVEL3[type][base[k]]} → ${LEVEL3[type][cur[k]]}`);
    }
    return why;
  }
  /** type(·눈)별 기준점 비교. state: none | baseline | same | changed */
  function compare(state, type, eye){
    const s = clean(state);
    let list = checksOf(s, type, eye);
    if(type === 'vf4') list = list.filter(vfReliable);
    if(!list.length) return { state:'none', n:0 };
    const base = list[0];
    if(list.length === 1) return { state:'baseline', n:1, base, latest:base, reasons:[], streak:0 };
    const latest = list[list.length - 1];
    const reasons = diffRecord(type, base, latest);
    const limited = type === 'vf4' && !!base.fw && !!latest.fw && base.fw !== latest.fw;
    const limitNote = limited ? `기준점과 검사 화면 크기가 달라(${base.fw}px → ${latest.fw}px) 비교에 한계가 있습니다. 같은 기기·창 크기·확대 비율로 다시 검사해 보세요.` : '';
    let streak = 0;
    for(let i = list.length - 1; i >= 1; i--){ if(diffRecord(type, base, list[i]).length) streak++; else break; }
    return { state: reasons.length ? 'changed' : 'same', n:list.length, base, latest, reasons, streak, repeated: streak >= TOL.streak, limited, limitNote };
  }
  /** 같은 종류(·눈)의 기준점 기록 id. 기록이 없으면 null. 삭제·소급 입력으로 기준점이 바뀌었는지 알리는 데 씁니다. */
  const baseId = (state, type, eye) => { const c = compare(state, type, eye); return c.base ? c.base.id : null; };
  function allCompare(state){
    const out = [];
    for(const t of TYPES){
      if(t === 'vf4'){ for(const e of ['R', 'L']) out.push(Object.assign({ type:t, eye:e }, compare(state, t, e))); }
      else out.push(Object.assign({ type:t }, compare(state, t)));
    }
    return out.filter(x => x.state !== 'none');
  }
  const label = c => c.type === 'vf4' ? `${TYPE_KO.vf4} · ${c.eye === 'R' ? '오른쪽' : '왼쪽'} 눈` : TYPE_KO[c.type];

  /** MRI 크기와 체크가 엇갈릴 때의 안내. 체크의 기준점 날짜와 최근 날짜가 최근 두 MRI 날짜와 같을 때만 비교합니다.
   *  날짜가 다르면 "판단할 수 없음"이라고만 말하며, 값을 보간하거나 의미를 해석하지 않고 기록된 날짜와 숫자만 서술합니다. */
  function crossing(state, today){
    const s = clean(state, today);
    if(s.mri.length < 2) return { cross:false };
    const a = s.mri[s.mri.length - 2], b = s.mri[s.mri.length - 1];
    const cmp = allCompare(s).filter(c => c.n >= 2);
    if(!cmp.length) return { cross:false };
    const aligned = cmp.filter(c => c.base.date === a.date && c.latest.date === b.date && !c.limited);
    const mriTxt = `MRI 기록 ${a.date} ${a.size} mm → ${b.date} ${b.size} mm`;
    if(!aligned.length){
      return { cross:false, undetermined:true,
        text:`${mriTxt}. 체크의 기준점과 최근 기록 날짜(${cmp.map(c => `${label(c)} ${c.base.date} → ${c.latest.date}`).join(', ')})가 이 두 MRI 날짜와 달라 엇갈림 여부를 판단할 수 없습니다.` };
    }
    const changed = aligned.filter(c => c.state === 'changed');
    if(b.size <= a.size && changed.length){
      return { cross:true, kind:'mri-flat',
        text:`${mriTxt}로 늘지 않았고, 같은 두 날짜의 체크(${changed.map(label).join(', ')})는 첫 측정과 달라진 기록이 있습니다. 영상과 기능이 다르게 보일 수 있으니 진료 때 함께 알려 주세요.` };
    }
    if(b.size > a.size && !changed.length){
      return { cross:true, kind:'mri-grew',
        text:`${mriTxt}로 늘었고, 같은 두 날짜의 체크(${aligned.map(label).join(', ')})는 첫 측정과 비슷한 기록입니다. 체크가 모든 변화를 잡지는 못하니 이 차이를 진료 때 알려 주세요.` };
    }
    return { cross:false };
  }

  /* ── 체크 구성 ── */
  function setupFor(loc){
    const key = LOC_IDS.has(loc) ? loc : 'unknown';
    const cfg = SETUP[key];
    const core = cfg.core.slice();
    const extra = TYPES.filter(t => !core.includes(t));
    const sym = [...EMERGENCY, ...cfg.sym.map(id => SYM_BY_ID[id])];
    const focus = CARE_FOCUS[key] || [];
    const care = [...focus.map(id => CARE_BY_ID[id]), ...CARE_ITEMS.filter(i => !focus.includes(i.id))];
    return { loc:key, core, extra, sym, care, careFocus:focus.slice(), precise:!!cfg.precise };
  }
  const symEmergency = rec => rec.items.filter(id => EM_IDS.has(id));

  /* ── 그래프 데이터: 단위가 다른 값은 서로 다른 패널·눈금으로 나눕니다. 날짜 사이는 잇거나 채우지 않습니다. ── */
  function niceTicks(lo, hi, want = 4){
    if(!(hi > lo)) { hi = lo + 1; }
    const raw = (hi - lo) / want, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * p).find(v => v >= raw) || p * 10;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const t = []; for(let v = a; v <= b + step / 2; v += step) t.push(Math.round(v * 1000) / 1000);
    return t;
  }
  /* 시야 기록(VF.digest) 결과를 숫자·날짜·고정 코드로만 다시 만듭니다. 화면에 들어가는 글자는 이 파일의 고정 문구뿐입니다. */
  const VF_MAP_IDS = new Set(['base-v1', 'sellar-mid-v1', 'sellar-left-v1', 'sellar-right-v1', 'legacy-30']);
  const VF_REASON_KO = Object.freeze({ cluster:'붙어 있는 나빠진 점', central:'중심 평균 하락', temporal:'귀쪽−코쪽 차이 증가', focus:'집중 구역 점 하락(임시 기준)' });
  const num = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100 ? Math.round(v * 10) / 10 : null;
  function cleanVf(list){
    const out = [];
    for(const e of Array.isArray(list) ? list.slice(0, 2) : []){
      if(!e || (e.eye !== 'R' && e.eye !== 'L') || !VF_MAP_IDS.has(e.mapId) || out.some(x => x.eye === e.eye)) continue;
      const pts = (Array.isArray(e.pts) ? e.pts : []).filter(p => p && isDate(p.date) && num(p.v) !== null).slice(-400).map(p => ({ date:p.date, v:num(p.v), unreliable:!!p.unreliable }));
      const b = e.baseline && typeof e.baseline === 'object' ? { ms:num(e.baseline.ms), tn:num(e.baseline.tn), focus:num(e.baseline.focus) } : null;
      const L = e.latest && typeof e.latest === 'object' && isDate(e.latest.date) ? {
        date:e.latest.date, ms:num(e.latest.ms), dMs:num(e.latest.dMs), dTN:num(e.latest.dTN), dFocus:num(e.latest.dFocus),
        nFocusWorse:isInt(e.latest.nFocusWorse, 0, 3) ? e.latest.nFocusWorse : 0, worse:!!e.latest.worse,
        reasons:(Array.isArray(e.latest.reasons) ? e.latest.reasons : []).filter(r => own(VF_REASON_KO, r)) } : null;
      const st = ['none', 'baseline', 'tracking', 'stable', 'recheck', 'confirmed'].includes(e.state) ? e.state : 'none';
      out.push({ eye:e.eye, mapId:e.mapId, zoneKo:e.zone === 'central' ? '중심' : e.zone === 'temporal-upper' ? '귀쪽 위' : '', state:st,
        nReliable:isInt(e.nReliable, 0, 400) ? e.nReliable : 0, otherMap:isInt(e.otherMap, 0, 400) ? e.otherMap : 0, baseline:b, latest:L, pts });
    }
    return out;
  }
  function graph(state, extra){
    const s = clean(state);
    const pts = [];
    const panels = [];
    const mri = s.mri.map(m => ({ date:m.date, v:m.size }));
    if(mri.length) panels.push({ id:'mri', title:'MRI 종양 크기', unit:'mm', series:[{ id:'mri', label:'MRI 크기', pts:mri }] });
    const vfx = cleanVf(extra && extra.vf).filter(e => e.pts.length)
      .map(e => ({ id:'vfx-' + e.eye, label:`${e.eye === 'R' ? '오른쪽' : '왼쪽'} 눈 (${e.mapId})`, pts:e.pts }));
    if(vfx.length) panels.push({ id:'vfx', title:'정밀 시야: 평균 앱 점수', unit:'점', series:vfx, fixed:[0, 30], fixedTicks:[0, 10, 20, 30] });
    const vf = [];
    for(const e of ['R', 'L']){
      const p = checksOf(s, 'vf4', e).map(c => ({ date:c.date, v:vfTotal(c), unreliable:!vfReliable(c) }));
      if(p.length) vf.push({ id:'vf-' + e, label:`${e === 'R' ? '오른쪽' : '왼쪽'} 눈`, pts:p });
    }
    if(vf.length) panels.push({ id:'vf4', title:'간단 시야: 보인 자극 수', unit:'/12', series:vf, fixed:[0, 12], fixedTicks:[0, 3, 6, 9, 12] });
    const tp = [];
    for(const h of ['L', 'R']){
      const p = checksOf(s, 'tap').map(c => ({ date:c.date, v:c[h].n }));
      if(p.length) tp.push({ id:'tap-' + h, label:h === 'L' ? '왼손' : '오른손', pts:p });
    }
    if(tp.length) panels.push({ id:'tap', title:'손가락 두드리기: 10초 횟수', unit:'회', series:tp });
    for(const p of panels){
      const vals = p.series.flatMap(x => x.pts.map(q => q.v));
      const [lo, hi] = p.fixed || [Math.min(...vals), Math.max(...vals)];
      p.ticks = p.fixed ? p.fixedTicks : niceTicks(Math.max(0, lo - (hi - lo) * 0.1 || 0), hi + (hi - lo) * 0.1 || hi);
      for(const q of p.series.flatMap(x => x.pts)) pts.push(q.date);
    }
    const days = [...new Set(pts)].sort();
    return { panels, dates:days, minDay:days.length ? dayNum(days[0]) : 0, maxDay:days.length ? dayNum(days[days.length - 1]) : 0, crossing:crossing(s) };
  }

  /* ── 진료 요약 · 질문 ── */
  function questionList(state){
    const s = clean(state);
    const q = [];
    const loc = LOCS.find(l => l.id === s.loc);
    q.push({ k:'loc', t:s.loc === 'unknown' ? '제 종양의 정확한 위치와, 그 위치에서 특히 살펴야 할 증상은 무엇인가요?' : `제 종양 위치(${loc.ko})에서 특히 살펴야 할 증상은 무엇인가요?` });
    for(const c of allCompare(s).filter(x => x.state === 'changed')){
      q.push({ k:'chg', t:`${label(c)}에서 첫 측정과 달라진 기록이 있습니다${c.repeated ? '(여러 번 이어짐)' : ''}${c.limited ? '(검사 화면 크기가 달라 비교에 한계가 있음)' : ''}. 병원에서 확인이 필요한가요?` });
    }
    const x = crossing(s);
    if(x.cross) q.push({ k:'cross', t:'MRI 크기 기록과 집에서 한 체크 결과가 서로 다르게 보입니다. 이 차이를 어떻게 봐야 하나요?' });
    const faceRec = checksOf(s, 'care').filter(c => c.items.includes('facemv')).slice(-1)[0];
    if(faceRec) q.push({ k:'face', t:`보호자가 얼굴 양쪽의 움직임이 전과 다르게 보인다고 기록했습니다(${faceRec.date}). 얼굴 신경과 관련해 확인이 필요한가요?` });
    if(s.meds.hormone === 'now' || s.meds.hormone === 'past') q.push({ k:'med', t:'피임 주사제(메드록시프로게스테론) 사용 이력이 있습니다. 수막종과 관련해 확인이 필요한가요?' });
    if(s.next) q.push({ k:'next', t:`다음 MRI는 ${s.next}로 잡혀 있습니다. 그 전에 병원에 연락해야 하는 경우는 어떤 때인가요?` });
    else q.push({ k:'next', t:'다음 MRI는 언제가 좋은가요? 그 사이 집에서 체크하는 간격은 어떻게 하면 되나요?' });
    q.push({ k:'gen', t:'집에서 하는 체크를 진료에 어떻게 활용하면 좋을까요?' });
    return q;
  }
  const questions = state => questionList(state).map(x => x.t);
  /** 인쇄용: 한 페이지에 들어가도록 5개로 줄이되 위치·엇갈림·약·다음 MRI 질문을 먼저 남기고 나머지를 변화 질문으로 채웁니다. */
  function printQuestions(state){
    const all = questionList(state);
    const keep = new Set();
    for(const k of ['loc', 'cross', 'face', 'med', 'next']) all.forEach((x, i) => { if(x.k === k) keep.add(i); });
    all.forEach((x, i) => { if(keep.size < 5 && x.k === 'chg') keep.add(i); });
    all.forEach((x, i) => { if(keep.size < 5 && x.k === 'gen') keep.add(i); });
    return all.filter((x, i) => keep.has(i)).slice(0, 5).map(x => x.t);
  }
  /* 정밀 시야 요약 문장 (고정 문구 + 숫자 + mapId) */
  const sgn = v => v == null ? '–' : (v > 0 ? '+' : '') + v;
  function vfLines(vf){
    return vf.map(e => {
      const eye = `${e.eye === 'R' ? '오른쪽' : '왼쪽'} 눈 [지도 ${e.mapId}]`;
      const other = e.otherMap ? ` · 다른 지도 기록 ${e.otherMap}회는 비교에서 뺌` : '';
      if(e.state === 'none' || e.state === 'baseline') return `${eye}: 기준선 측정 중 (${e.nReliable}/2)${other}`;
      const b = e.baseline || {}, L = e.latest;
      const head = `${eye}: 기준선 평균 ${b.ms ?? '–'}점, 귀쪽−코쪽 ${sgn(b.tn)}${b.focus != null ? `, 집중 구역(${e.zoneKo}) ${b.focus}점` : ''}`;
      if(!L) return `${head} · 기준선 이후 검사 없음${other}`;
      const why = L.reasons.length ? ` · 변화 사유: ${L.reasons.map(r => VF_REASON_KO[r]).join(', ')}` : ' · 기준선과 비슷함';
      return `${head} → 최근 ${L.date} 평균 ${sgn(L.dMs)}, 귀쪽−코쪽 변화 ${sgn(L.dTN)}${L.dFocus != null ? `, 집중 구역 변화 ${sgn(L.dFocus)} (6점 이상 낮은 집중 점 ${L.nFocusWorse}/3)` : ''}${why}${other}`;
    });
  }
  function summary(state, today, extra){
    const s = clean(state);
    const loc = LOCS.find(l => l.id === s.loc);
    const vf = cleanVf(extra && extra.vf);
    const cmp = allCompare(s).map(c => ({
      key:c.type + (c.eye || ''), name:label(c), state:c.state, n:c.n,
      base:c.base ? c.base.date : null, latest:c.latest ? c.latest.date : null,
      reasons:c.reasons || [], repeated:!!c.repeated, limited:!!c.limited, limitNote:c.limitNote || '',
    }));
    const lastSym = checksOf(s, 'sym').slice(-1)[0];
    const em = lastSym ? symEmergency(lastSym) : [];
    const emergencyDates = checksOf(s, 'sym').filter(c => symEmergency(c).length).map(c => c.date).filter(d => d !== (em.length ? lastSym.date : '')).slice(-3);
    const daysToNext = s.next && today && isDate(today) ? dayNum(s.next) - dayNum(today) : null;
    return {
      locKo:loc.ko, side:s.side, sideKo:SIDES.find(x => x.id === s.side).ko, vf, vfLines:vfLines(vf), next:s.next, daysToNext, mri:s.mri.slice(), mriRecent:s.mri.slice(-3), hormone:s.meds.hormone, hormoneKo:HORMONE[s.meds.hormone], hormoneDate:s.meds.date,
      compare:cmp, crossing:crossing(s), emergencyItems:em.map(id => SYM_BY_ID[id].ko), emergencyDate:em.length ? lastSym.date : null,
      emergencyDates, questions:questions(s), printQuestions:printQuestions(s), nChecks:s.checks.length,
    };
  }

  return Object.freeze({
    V, MAX_CHECKS, MAX_MRI, TAP_MS, TOL, LOCS, SIDES, setSide, cleanVf, TYPES, TYPE_KO, SETUP, SYM_ITEMS, EMERGENCY, CARE_ITEMS, HORMONE, LEVEL3, DIRS, DIR_KO,
    isDate, dayNum, localDate, empty, clean, setLoc, setNext, addMri, removeMri, addCheck, removeCheck, setMeds,
    tapMetrics, tapLR, vfPlan, vfScore, vfTotal, vfReliable, compare, allCompare, label, crossing, setupFor, symEmergency,
    niceTicks, graph, questions, printQuestions, baseId, summary,
  });
})();
