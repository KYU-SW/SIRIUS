/* ═══════════════════════════════════════════════════════════════════════
   개인정보 보호 흐름 회귀 테스트 (Claude 검토, 2026-10-30)

   · 합성 데이터만 사용합니다. 실제 MRI·이름·이메일·비밀키·.env.local 을 읽거나 만들지 않습니다.
   · 브라우저 대신 아주 작은 가짜 DOM 에 index.html 의 실제 구조와 js/*.js 의 실제 코드를
     순서대로 올려 돌립니다(외부 패키지 설치 없음). 서버 시험은 임시 폴더에 복사본을 띄웁니다.
   · 검토에서 발견된 결함은 Codex 수정 후 모두 일반 회귀 테스트로 전환했습니다.
     실패를 허용하는 todo 검사는 없습니다.
   · 상세 설명·심각도·권장 패치: reports/claude-privacy-review.md
   ═══════════════════════════════════════════════════════════════════════ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX_HTML = read('index.html');
const SCRIPT_SRCS = [...INDEX_HTML.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);

/* ═══════════════ 1. 아주 작은 가짜 브라우저 ═══════════════ */
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'path', 'circle', 'ellipse', 'rect', 'line']);
const stripTags = s => String(s).replace(/<[^>]*>/g, '');
const escText = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function buildBrowser({ hostname = '127.0.0.1', voices = [], seedStorage = {}, fetchMode = 'ok', modelName = 'test-model' } = {}) {
  const hiddenLog = [];                 // 모든 hidden 변경 기록 (화면이 잠깐이라도 열렸는지 확인)
  const timers = new Map(); let timerSeq = 0;
  const storageWrites = [], cookieWrites = [], fetchLog = [], spoken = [], alerts = [];
  const pendingFetches = [], images = [], readers = [];
  const hold = { images: false, reader: false };
  const store = new Map(Object.entries(seedStorage));

  class El {
    constructor(tag, attrs = {}, parent = null, range = null) {
      this.tag = tag; this.attrs = new Map(Object.entries(attrs)); this.parent = parent; this.children = [];
      this.id = attrs.id || ''; this._hidden = 'hidden' in attrs; this._range = range;
      this._text = null; this._html = null;
      this.value = attrs.value ?? ''; this.checked = false; this.disabled = false;
      this.style = { setProperty() {} }; this.dataset = {};
      for (const [k, v] of this.attrs) if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = v;
      this.listeners = {}; this.onclick = null; this.oninput = null; this.onchange = null;
      this.width = Number(attrs.width) || 300; this.height = Number(attrs.height) || 150;
      this.classList = {
        contains: c => this._classes().has(c),
        add: c => { const s = this._classes(); s.add(c); this.attrs.set('class', [...s].join(' ')); },
        remove: c => { const s = this._classes(); s.delete(c); this.attrs.set('class', [...s].join(' ')); },
        toggle: (c, f) => { const s = this._classes(); const on = f ?? !s.has(c); on ? s.add(c) : s.delete(c); this.attrs.set('class', [...s].join(' ')); return on; }
      };
    }
    _classes() { return new Set(String(this.attrs.get('class') || '').split(/\s+/).filter(Boolean)); }
    get hidden() { return this._hidden; }
    set hidden(v) { this._hidden = !!v; hiddenLog.push({ id: this.id, value: !!v }); }
    get innerHTML() { if (this._html === null) this._html = this._range ? INDEX_HTML.slice(this._range[0], this._range[1]) : ''; return this._html; }
    set innerHTML(v) { this._html = String(v); this._text = stripTags(v); }
    get textContent() { if (this._text === null) this._text = stripTags(this.innerHTML); return this._text; }
    set textContent(v) { this._text = String(v); this._html = escText(v); }
    get innerText() { return this.textContent; }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    setAttribute(n, v) { this.attrs.set(n, String(v)); }
    removeAttribute(n) { this.attrs.delete(n); }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
    click() { const ev = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }; if (this.onclick) this.onclick(ev); (this.listeners.click || []).forEach(fn => fn(ev)); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    focus() {} scrollIntoView() {} remove() {}
    closest(sel) { for (let e = this; e; e = e.parent) if (matches(e, sel)) return e; return null; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) { return all(this).filter(e => matches(e, sel)); }
    getContext() { return this._ctx ||= makeCtx(this); }
    toBlob(cb, type) { cb({ type, size: 1000, fake: 'blob' }); }
    toDataURL() { return 'data:image/png;base64,AAAA'; }
  }
  function makeCtx(canvas) {
    const base = { canvas, measureText: () => ({ width: 10 }), createRadialGradient: () => ({ addColorStop() {} }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    return new Proxy(base, { get: (t, p) => (p in t ? t[p] : () => {}), set: () => true });
  }
  function all(root) { const out = []; (function walk(e) { for (const c of e.children) { out.push(c); walk(c); } })(root); return out; }
  function tokenMatch(e, tok) {
    const re = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=([^\]]+))?\]|^([a-z][a-z0-9]*)/g; let m, any = false;
    while ((m = re.exec(tok))) {
      any = true;
      if (m[1] && e.id !== m[1]) return false;
      if (m[2] && !e._classes().has(m[2])) return false;
      if (m[3] && (!e.attrs.has(m[3]) || (m[4] !== undefined && e.attrs.get(m[3]) !== m[4].replace(/^["']|["']$/g, '')))) return false;
      if (m[5] && e.tag !== m[5]) return false;
    }
    return any;
  }
  function matches(e, sel) {
    const toks = sel.trim().split(/\s+/);
    if (!tokenMatch(e, toks.pop())) return false;
    let p = e.parent;
    while (toks.length && p) { if (tokenMatch(p, toks[toks.length - 1])) toks.pop(); p = p.parent; }
    return toks.length === 0;
  }

  /* index.html 의 실제 구조를 읽어 요소 트리를 만듭니다 */
  const html = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length));
  const root = new El('#root'); const stack = [root]; const byId = new Map();
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g; let m;
  while ((m = tagRe.exec(html))) {
    const [full, close, tag, rawAttrs] = m; const t = tag.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === t) { stack[i]._range && (stack[i]._range[1] = m.index); stack.length = i; break; }
      continue;
    }
    const attrs = {}; const body = rawAttrs.replace(/\/\s*$/, '');
    for (const a of body.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
    const el = new El(t, attrs, stack[stack.length - 1], [m.index + full.length, m.index + full.length]);
    stack[stack.length - 1].children.push(el);
    if (el.id) byId.set(el.id, el);
    if (!VOID.has(t) && !/\/\s*$/.test(rawAttrs)) stack.push(el); else el._range = null;
  }
  const htmlEl = new El('html'); const body = new El('body');
  const doc = {
    body, documentElement: htmlEl, createElement: tag => new El(tag), addEventListener() {}, removeEventListener() {},
    getElementById: id => byId.get(id) ?? null,
    querySelectorAll: sel => all(root).filter(e => matches(e, sel)),
    querySelector: sel => all(root).find(e => matches(e, sel)) || null
  };
  Object.defineProperty(doc, 'cookie', { get: () => '', set: v => cookieWrites.push(v) });

  const MODEL = { probs: [0.7, 0.1, 0.1, 0.1], model: modelName,
    regions: [{ nx: 0.4, ny: 0.5, r: 0.1, conf: 0.6, area: 100, score: 10 }] };
  const respond = () => ({ ok: true, status: 200, json: async () => MODEL });
  const fakeFetch = (url, init = {}) => {
    fetchLog.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, signal: init.signal });
    if (fetchMode === 'hold') {
      return new Promise((resolve, reject) => {
        pendingFetches.push({ resolve: () => resolve(respond()), reject });
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(respond());
  };

  class FakeImage {
    constructor() { this.width = 512; this.height = 512; images.push(this); }
    set src(v) { this._src = v; if (!hold.images) queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
  }
  class FakeReader {
    readAsDataURL() { readers.push(this); if (!hold.reader) queueMicrotask(() => this.onload({ target: { result: 'data:image/png;base64,AAAA' } })); }
  }
  const speechSynthesis = { speaking: false, cancel() {}, speak(u) { spoken.push(u); }, getVoices: () => voices };

  const sandbox = {
    document: doc, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, URL, Blob, AbortController, queueMicrotask, console,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { storageWrites.push(k); store.set(k, String(v)); },
      removeItem: k => { storageWrites.push('-' + k); store.delete(k); }
    },
    fetch: fakeFetch, Image: FakeImage, FileReader: FakeReader,
    speechSynthesis, SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    navigator: { locks: { request: async (_name, work) => work() }, clipboard: { writeText: async () => {} } },
    getComputedStyle: () => ({ getPropertyValue: () => '#2563EB' }),
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
    alert: m => alerts.push(String(m)), confirm: () => true,
    location: { hostname, host: hostname + ':3000', origin: 'http://' + hostname + ':3000' }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.scrollTo = () => {};
  sandbox.print = () => {};
  sandbox.matchMedia = () => ({ matches: false });
  const context = vm.createContext(sandbox);
  for (const src of SCRIPT_SRCS) vm.runInContext(read(src), context, { filename: src });

  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const g = expr => vm.runInContext(expr, context);
  const visible = id => { for (let e = byId.get(id); e; e = e.parent) if (e._hidden) return false; return true; };
  const el = id => byId.get(id);
  return { context, g, el, visible, flush, click: id => byId.get(id).click(), hiddenLog, timers, storageWrites, cookieWrites,
    fetchLog, spoken, alerts, pendingFetches, images, readers, hold, byId, doc,
    pngFile: { type: 'image/png', size: 1024, name: 'patient-name-should-not-show.png' } };
}

const TRACK_TEXT = ['vTitle', 'vConf', 'report', 'findings', 'confPct', 'confNote', 'probs', 'probsTitle', 'questions',
  'scanLabel', 'fbSeries', 'fbSize', 'fbTime', 'fbQuality', 'checkMsg', 'tlScroll'];
const TRACK_WRAPPERS = ['confWrap', 'probsWrap', 'checkBox'];
const snapshot = b => Object.fromEntries(TRACK_TEXT.map(id => [id, b.el(id).textContent + '|' + b.el(id).innerHTML]));
/* 합성 계정으로 로그인한 상태를 만든다(실제 계정·비밀번호·저장소 없이). 키가 없으므로 저장은 되지 않는다. */
function login(b) {
  b.g(`S.acc = { id: 'synthetic_user', emailMask: 'sy***@e***.com', created: '2026-01-01T00:00:00Z' };
       S.masterKey = { synthetic:true }; S.name = 'Synthetic'; S.email = 'synthetic@example.com'; S.scans = []; S.guest = false; enterApp();`);
}
async function analyzeOnce(b) {
  login(b);
  b.g('loadFile')(b.pngFile);
  await b.flush();
}

function syntheticVf(b){
  b.g(`VFS.tests=[{date:'2026-01-01',eye:'R',th:VF.grid('R').map(()=>20),un:[],rel:{fp:0,fpN:10,fl:0,flN:10,fn:0,fnN:5},reliable:true,dist:33}];VFS.dirty=true;go('field');`);
}

test('고급 시야 암호화 도중 로그아웃·화면 이동하면 늦은 파일 다운로드를 하지 않는다',async()=>{
  for(const leave of ['logout','navigate']){
    const b=buildBrowser();login(b);syntheticVf(b);
    let release,args,downloads=0;
    const real=b.g('kdf');b.context.kdf=(...a)=>{args=a;return new Promise(r=>release=r)};
    b.context.URL={createObjectURL(){downloads++;return 'blob:synthetic';},revokeObjectURL(){}};
    b.g("vfOpenFile('save')");
    b.el('vfPass').value=b.el('vfPass2').value='Synthetic-file-passphrase!123';
    const work=b.el('vfFileGo').onclick();
    if(leave==='logout')b.click('lockBtn');else b.g("go('analyze')");
    release(await real(...args));await work;
    assert.equal(downloads,0);
    assert.equal(b.el('vfPass').value,'');
    assert.equal(b.el('vfFilePanel').hidden,true);
    if(leave==='logout')assert.equal(b.g('VFS.tests.length'),0);
  }
});

test('고급 시야 파일 읽기 도중 계정을 바꾸면 이전 기록이 새 세션에 들어오지 않는다',async()=>{
  const b=buildBrowser();login(b);syntheticVf(b);
  const text=await b.g("VFFile.encrypt({tests:VFS.tests,symptoms:[],rules:VFS.rules},'Synthetic-file-passphrase!123')");
  b.g("VFS.dirty=false;vfOpenFile('load')");
  let release;
  b.el('vfFileIn').files=[{size:text.length,text:()=>new Promise(r=>release=r)}];
  b.el('vfPass').value='Synthetic-file-passphrase!123';
  const work=b.el('vfFileGo').onclick();
  b.click('lockBtn');login(b);
  release(text);await work;
  assert.equal(b.g('VFS.tests.length'),0);
  assert.equal(b.el('vfFilePanel').hidden,true);
  assert.equal(b.el('vfFileGo').disabled,false);
});

test('고급 시야 파일 저장 중 추가한 기록은 저장 완료로 표시하지 않는다',async()=>{
  const b=buildBrowser();login(b);syntheticVf(b);
  let release,args,content;
  const real=b.g('kdf');b.context.kdf=(...a)=>{args=a;return new Promise(r=>release=r)};
  b.context.URL={createObjectURL(blob){content=blob.text();return 'blob:synthetic';},revokeObjectURL(){}};
  b.g("vfOpenFile('save')");b.el('vfPass').value=b.el('vfPass2').value='Synthetic-file-passphrase!123';
  const work=b.el('vfFileGo').onclick();
  b.g("VFS.tests.push({...VFS.tests[0],date:'2026-01-02'})");
  release(await real(...args));await work;
  assert.equal(b.g('VFS.dirty'),true);
  assert.equal(b.g('VFS.tests.length'),2);
  b.context.kdf=real;b.context.syntheticFile=await content;
  const saved=await b.g("VFFile.decrypt(syntheticFile,'Synthetic-file-passphrase!123')");
  assert.equal(saved.tests.length,1);
});

test('가입 저장 대기 중 홈으로 돌아가면 계정 쓰기와 늦은 복구 키 화면을 취소한다', async () => {
  const b=buildBrowser();b.click('goSignup');
  b.el('suId').value='synthetic_cancel';
  b.el('suPw').value=b.el('suPw2').value='Synthetic-Test!123';
  b.g('agreeBoxes().forEach(c => c.checked = true)');
  const accs=b.g('accounts'),commit=accs.commit.bind(accs);
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  accs.commit=async(...args)=>{entered();await gate;return commit(...args)};
  const work=b.el('btnSignup').onclick();await ready;
  b.click('authHome');release();await work;
  assert.equal(b.g("accounts.byId('synthetic_cancel')"),null);
  assert.equal(b.visible('landing'),true);assert.equal(b.visible('scr-recovery'),false);
  assert.equal(b.el('recKey').textContent.trim(),'');
  b.click('goSignup');assert.equal(b.el('btnSignup').textContent,'회원가입 완료');
});

test('비밀번호 변경 저장 대기 중 돌아가면 변경을 취소하고 숨은 인증 입력값도 지운다', async () => {
  const b=buildBrowser();await b.g("createAccount({id:'synthetic_cancel_pw',pw:'Synthetic-Test!123'})");
  b.el('loginId').value='synthetic_cancel_pw';b.el('loginPw').value='Synthetic-Test!123';await b.el('btnLogin').onclick();
  const before=b.g('JSON.stringify(S.acc)');b.g("show('chpw')");
  b.el('cpOld').value='Synthetic-Test!123';b.el('cpNew').value=b.el('cpNew2').value='Updated-Test!456';
  const accs=b.g('accounts'),commit=accs.commit.bind(accs);let release,entered;
  const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  accs.commit=async(...args)=>{entered();await gate;return commit(...args)};
  const work=b.el('btnChPw').onclick();await ready;b.click('cp2app');release();await work;
  assert.equal(b.g('JSON.stringify(S.acc)'),before);assert.equal(b.visible('app'),true);
  for(const id of ['cpOld','cpNew','cpNew2'])assert.equal(b.el(id).value,'');
  b.el('npRec').value='synthetic-recovery-marker';b.el('npPw').value='Synthetic-Test!123';b.click('lockBtn');
  for(const id of ['npRec','npPw','npPw2','loginPw'])assert.equal(b.el(id).value,'');
});

test('로그인 후 인증 화면에서도 유휴 잠금이 유지되고 홈으로 나가면 보관함을 잠근다', async () => {
  const b=buildBrowser();await b.g("createAccount({id:'synthetic_gate_idle',pw:'Synthetic-Test!123'})");
  const login=async()=>{b.el('loginId').value='synthetic_gate_idle';b.el('loginPw').value='Synthetic-Test!123';await b.el('btnLogin').onclick()};
  await login();b.g("show('chpw');resetIdle()");
  const idle=[...b.timers.values()].find(t=>t.ms===600000&&!t.interval);assert.ok(idle);
  idle.fn();assert.equal(b.g('S.masterKey'),null);assert.equal(b.visible('app'),false);
  await login();b.g("show('chpw')");b.click('authHome');assert.equal(b.g('S.masterKey'),null);
  assert.equal(b.g('S.acc'),null);assert.equal(b.visible('landing'),true);
});

test('기기 전용 실제 가입·로그인은 이메일이나 인증번호 없이 암호화 계정을 연다', async () => {
  const b = buildBrowser();
  b.click('goSignup');
  b.el('suId').value = 'synthetic_local';
  b.el('suPw').value = b.el('suPw2').value = 'Synthetic-Test!123';
  b.g('agreeBoxes().forEach(c => c.checked = true)');
  await b.g('checkIdNow()');
  assert.equal(b.el('btnSignup').disabled, false);
  assert.equal(b.visible('suEmail'), false);
  await b.el('btnSignup').onclick();
  assert.equal(b.g("accounts.byId('synthetic_local').emailMask"), '');
  b.el('recSaved').checked = true;
  await b.el('btnRecDone').onclick();
  b.el('loginPw').value = 'Synthetic-Test!123';
  await b.el('btnLogin').onclick();
  assert.equal(b.visible('app'), true);
  assert.equal(b.fetchLog.length, 0);
  assert.equal(b.el('lgDemoCode').textContent.trim(), '');
  b.click('lockBtn');
  assert.equal(b.visible('app'), false);
  assert.equal(b.g('S.masterKey'), null);
});

test('비밀번호 확인 도중 취소하면 늦은 복호화가 로그인 화면을 다시 열지 못한다', async () => {
  const b = buildBrowser();
  await b.g("createAccount({id:'synthetic_local',pw:'Synthetic-Test!123'})");
  b.el('loginId').value = 'synthetic_local';
  b.el('loginPw').value = 'Synthetic-Test!123';
  const work = b.el('btnLogin').onclick();
  b.g('clearPending()');
  await work;
  assert.equal(b.visible('app'), false);
  assert.equal(b.g('S.acc'), null);
});

test('복구 키 재발급 뒤 새 계정 가입이 로그인 없이 앱을 열지 않는다', async () => {
  const b=buildBrowser();
  await b.g("createAccount({id:'synthetic_first',pw:'Synthetic-Test!123'})");
  b.el('loginId').value='synthetic_first'; b.el('loginPw').value='Synthetic-Test!123';
  await b.el('btnLogin').onclick();
  await b.el('newRecBtn').onclick();
  b.el('recSaved').checked=true;
  await b.el('btnRecDone').onclick();
  assert.equal(b.visible('app'),true);
  b.click('lockBtn'); b.click('goSignup');
  b.el('suId').value='synthetic_second';
  b.el('suPw').value=b.el('suPw2').value='Synthetic-Test!123';
  b.g('agreeBoxes().forEach(c => c.checked = true)');
  await b.g('checkIdNow()'); await b.el('btnSignup').onclick();
  b.el('recSaved').checked=true; await b.el('btnRecDone').onclick();
  assert.equal(b.visible('app'),false);
  assert.equal(b.g('S.masterKey'),null);
  assert.equal(b.g('S.acc'),null);
});

test('복구 키 저장 실패는 기존 키와 계정 상태를 변경하지 않는다', async () => {
  const b=buildBrowser();
  await b.g("createAccount({id:'synthetic_first',pw:'Synthetic-Test!123'})");
  b.el('loginId').value='synthetic_first'; b.el('loginPw').value='Synthetic-Test!123';
  await b.el('btnLogin').onclick();
  const before=b.g('JSON.stringify(S.acc)');
  b.g('accounts.save = () => false');
  await b.el('newRecBtn').onclick();
  assert.equal(b.g('JSON.stringify(S.acc)'),before);
  assert.equal(b.visible('scr-recovery'),false);
  assert.equal(b.el('recKey').textContent,'');
  assert.match(b.alerts.at(-1),/이전 키는 유지/);
});

/* ═══════════════ 2. 정적 점검 (코드·마크업) ═══════════════ */
test('정적 점검: index.html 에 인라인 스크립트·이벤트 속성·외부 주소가 없고 CSP 가 외부 연결을 막는다', () => {
  const html = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc="js\/[A-Za-z0-9_-]+\.js"/, '외부·인라인 스크립트 금지');
    assert.equal(m[2].trim(), '', '인라인 스크립트 본문 금지');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, '이벤트 핸들러 속성 금지');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), /(?:src|href|action)\s*=\s*["']\s*(?:https?:)?\/\//i, '외부 리소스 금지');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
  for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|\*|https?:/);
  const serverCsp = /Content-Security-Policy', "([^"]+)"/.exec(read('server.js'))?.[1] || '';
  for (const d of ["script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(serverCsp.includes(d), d);
});

test('정적 점검: js/ 에는 원격 전송·영구 저장 API 가 새로 들어오지 않았다', () => {
  const forbidden = /XMLHttpRequest|sendBeacon|WebSocket|EventSource|indexedDB|sessionStorage|document\.cookie|window\.open|importScripts|serviceWorker|\beval\s*\(|new Function|document\.write|insertAdjacentHTML|outerHTML|postMessage/;
  const fetchSites = [];
  for (const name of readdirSync(path.join(ROOT, 'js'))) {
    const code = read('js/' + name);
    assert.doesNotMatch(code, forbidden, name);
    for (const m of code.matchAll(/\bfetch\(([^,)]+)/g)) fetchSites.push(`${name}: ${m[1].trim()}`);
  }
  // 허용된 호출 지점: 분석 서버(/api/analyze), 인증 서버 상태·API (privacy 모드에서는 비활성)
  assert.deepEqual(fetchSites.sort(), [
    "auth-backend.js: this.base + '/api/health'",
    "auth-backend.js: this.base + path",
    "engine.js: '/api/analyze'"
  ].sort());
});

/* ═══════════════ 3. 브라우저 흐름 (가짜 DOM) ═══════════════ */
test('하네스 점검: 부팅 후 랜딩만 보이고, 익명(둘러보기) 진입 기능이 없다', () => {
  const b = buildBrowser();
  assert.equal(b.g('CONFIG.privacy'), false);
  assert.equal(b.visible('landing'), true);
  assert.equal(b.visible('gate'), false);
  assert.equal(b.visible('app'), false);
  assert.equal(b.g('typeof enterGuest'), 'undefined');
  assert.equal(b.el('goGuest'), undefined, '둘러보기 버튼이 남아 있음');
});

test('로그인 필수: 시작·가이드·FAQ·시야 기록 어느 진입점도 로그인 없이 앱 화면을 열지 못한다', async () => {
  const entries = ['toLoginTop', 'toSignupTop', 'heroStart'];
  for (const id of entries) {
    const b = buildBrowser();
    b.click(id);
    await b.flush();
    assert.equal(b.visible('gate'), true, id + ' → 로그인/가입 화면');
    assert.equal(b.visible('app'), false, id + ' → 로그인 없이 앱이 열림');
    assert.equal(b.g('S.guest'), false); assert.equal(b.g('S.acc'), null);
  }
  const b = buildBrowser();
  for (const nav of b.doc.querySelectorAll('[data-landing]')) {
    if (nav.attrs.get('data-landing') === 'about') continue;
    b.g('showLanding()');
    nav.click();
    assert.equal(b.visible('app'), false, nav.attrs.get('data-landing') + ' → 로그인 없이 앱이 열림');
    assert.equal(b.visible('gate'), true);
  }
  const forbidden = /익명 분석|저장 없이 시작|이름·이메일 입력 없이|둘러보기 모드|기본 익명 모드/;
  assert.doesNotMatch(INDEX_HTML, forbidden, '화면 문구에 익명 이용 안내가 남아 있음');
});

test('로그인 상태: 네트워크 호출은 이 컴퓨터의 /api/analyze(JPEG) 하나뿐이고 저장을 누르기 전에는 저장소에 쓰지 않는다', async () => {
  const b = buildBrowser();
  await analyzeOnce(b);
  assert.equal(b.g('S.analysis.kind'), 'model');
  b.click('themeBtn3'); b.click('cvdBtn');
  b.click('lockBtn');
  assert.ok(b.storageWrites.every(k => ['neuria-theme', 'neuria-cvd'].includes(k)), JSON.stringify(b.storageWrites));
  assert.deepEqual(b.cookieWrites, []);
  assert.equal(b.fetchLog.length, 1);
  assert.equal(b.fetchLog[0].url, '/api/analyze');
  assert.equal(b.fetchLog[0].method, 'POST');
  assert.equal(b.fetchLog[0].headers['Content-Type'], 'image/jpeg');
});

test('로컬이 아닌 주소에서 열면 영상을 보내지 않고 브라우저 안 데모 엔진으로 대체한다', async () => {
  for (const hostname of ['example.com', 'localhost.evil.example', '127.0.0.1.evil.example', '']) {
    const b = buildBrowser({ hostname });
    await analyzeOnce(b);
    assert.deepEqual(b.fetchLog, [], hostname);
    assert.notEqual(b.g('S.analysis.kind'), 'model');
  }
});

test('나가기 직후 늦게 도착한 분석 응답과 이미지 로드는 화면·메모리에 남지 않는다', async () => {
  const b = buildBrowser({ fetchMode: 'hold' });
  const bootTitle = b.el('vTitle').textContent;          // 부팅 직후 안내 문구 (분석 결과가 아님)
  login(b);
  b.g('loadFile')(b.pngFile);
  await b.flush();
  assert.equal(b.pendingFetches.length, 1);
  b.click('lockBtn');                                     // 나가기
  b.pendingFetches[0].resolve();                          // 이전 요청이 뒤늦게 도착
  await b.flush();
  assert.equal(b.g('S.analysis'), null); assert.equal(b.g('S.img'), null); assert.equal(b.g('S.src'), null);
  assert.equal(JSON.stringify(b.g('S.regions')), '[]');
  assert.ok(['', bootTitle].includes(b.el('vTitle').textContent), '늦은 응답이 제목을 바꿈: ' + b.el('vTitle').textContent);
  assert.equal(b.el('report').innerHTML, '');
  assert.equal(b.el('findings').innerHTML, '');
  assert.equal(b.doc.body.style.cursor, '');
  assert.equal(b.visible('app'), false);

  // 다시 들어온 뒤에도 첫 번째 세션의 응답은 나타나지 않는다
  login(b);
  const second = (b.g('loadFile')(b.pngFile), b.flush());
  await second;
  const late = b.pendingFetches[0]; const fresh = b.pendingFetches[1];
  late.resolve(); await b.flush();
  assert.equal(b.g('S.analysis'), null, '이전 세션 응답이 새 세션에 반영됨');
  fresh.resolve(); await b.flush();
  assert.equal(b.g('S.analysis.kind'), 'model');

  // 파일 읽기·이미지 디코딩 도중에 나가도 결과가 만들어지지 않는다
  const c = buildBrowser(); login(c);
  c.hold.reader = true; c.g('loadFile')(c.pngFile); c.click('lockBtn');
  c.readers[0].onload({ target: { result: 'data:image/png;base64,AAAA' } }); await c.flush();
  assert.equal(c.fetchLog.length, 0); assert.equal(c.g('S.img'), null);
  const d = buildBrowser(); login(d);
  d.hold.images = true; d.g('loadFile')(d.pngFile); await d.flush();
  d.click('lockBtn'); d.images.at(-1).onload && d.images.at(-1).onload(); await d.flush();
  assert.equal(d.fetchLog.length, 0); assert.equal(d.g('S.img'), null);
});

test('로그인 상태: 화면에 넣는 텍스트는 이스케이프되고 서버가 준 모델 이름은 textContent 로만 쓰인다', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const b = buildBrowser({ modelName: evil });
  await analyzeOnce(b);
  assert.doesNotMatch(b.el('findings').innerHTML + b.el('questions').innerHTML + b.el('probs').innerHTML + b.el('who').innerHTML, /<img/i);
  assert.equal(b.el('engineBadge').textContent.includes(evil.slice(0, 5)), true);   // 문자 그대로 표시
  assert.equal(b.el('vConf').textContent.includes('<img'), true);
  assert.doesNotMatch(b.el('vConf').innerHTML, /<img/i);
  b.g("S.regions=[{name:'<b>x</b>',nx:.5,ny:.5,r:.1,conf:.5,status:'neutral',change:'<i>y</i>'}]; S.analysis={kind:'demo',probs:[.25,.25,.25,.25],quality:'q'}; renderAll();");
  assert.doesNotMatch(b.el('findings').innerHTML, /<b>x|<i>y/);
});

/* ───── 검토에서 확인한 결함의 회귀 방지 검사 ───── */
test('로그인 상태에도 10분 유휴 잠금이 적용된다 (F-01)', async () => {
  const b = buildBrowser();
  await analyzeOnce(b);
  const idle = [...b.timers.values()].find(t => t.ms === 10 * 60 * 1000 && !t.interval);
  assert.ok(idle, '익명 모드에서 유휴 타이머가 예약되지 않음');
  idle.fn();
  assert.equal(b.visible('app'), false);
  assert.equal(b.g('S.img'), null);
});

test('나가기 후 다시 들어와도 이전 결과 요약·확률·질문·파일 정보 텍스트가 남아 있지 않다 (F-02)', async () => {
  const b = buildBrowser();
  const before = snapshot(b);
  await analyzeOnce(b);
  assert.notDeepEqual(snapshot(b), before, '하네스 점검: 분석 결과가 화면에 그려져야 함');
  const sourceCanvas = b.g('S.src');
  b.click('lockBtn');
  assert.equal(sourceCanvas.width, 0);
  assert.equal(sourceCanvas.height, 0);
  login(b);                                               // 새 세션
  const after = snapshot(b);
  const stale = TRACK_TEXT.filter(id => after[id] !== before[id]);
  assert.deepEqual(stale, [], '남아 있는 요소: ' + stale.join(', '));
  for (const id of TRACK_WRAPPERS) assert.equal(b.el(id).hidden, true, id);
  assert.equal(b.el('cost').value, '');
});

test('나가기는 진행 중이던 /api/analyze 요청을 중단한다 (F-03)', async () => {
  const b = buildBrowser({ fetchMode: 'hold' });
  login(b);
  b.g('loadFile')(b.pngFile);
  await b.flush();
  assert.equal(b.fetchLog.length, 1);
  b.click('lockBtn');
  await b.flush();
  assert.equal(b.fetchLog[0].signal.aborted, true);
});

test('읽어주기(TTS)는 기기 안에서 동작하는 음성만 쓴다 (F-04)', async () => {
  const remote = { lang: 'ko-KR', name: 'Remote Korean', localService: false };
  const local = { lang: 'ko-KR', name: 'Local Korean', localService: true };
  const b = buildBrowser({ voices: [remote, local] });
  await analyzeOnce(b);
  b.click('ttsBtn');
  assert.equal(b.spoken.length, 1);
  assert.equal(b.spoken[0].voice?.localService, true, '원격 음성으로 문장이 전송될 수 있음');
  const onlyRemote = buildBrowser({ voices: [remote] });
  await analyzeOnce(onlyRemote);
  onlyRemote.click('ttsBtn');
  assert.ok(onlyRemote.spoken.length === 0 || onlyRemote.spoken[0].voice?.localService === true);
});

test('저장된 기록 데이터(thumb·status·이름)를 HTML 에 그대로 끼워 넣지 않는다 (F-07, 심층 방어)', () => {
  const b = buildBrowser();
  b.g(`S.scans=[{date:'26.10.30', thumb:'x" onerror="alert(1)', regions:[{name:'n', status:'good" data-x="1'}], probs:[1,0,0,0]}]; renderTimeline();`);
  assert.doesNotMatch(b.el('tlScroll').innerHTML, /onerror\s*=|data-x=/);
  const report = b.g(`buildReport({kind:'model', probs:[.7,.1,.1,.1]}, [{name:'<img src=x onerror=1>', conf:.5}], false, false)`).join('');
  assert.doesNotMatch(report, /<img/i);
});

test('부팅이 끝났을 때 로그인 화면이 아니라 랜딩이 보이고 앱은 닫혀 있다 (F-08)', () => {
  const b = buildBrowser();
  assert.equal(b.visible('landing'), true); assert.equal(b.visible('gate'), false); assert.equal(b.visible('app'), false);
});

test('안내 문구가 로그인 필수 구현과 모순되지 않는다 (F-09)', () => {
  assert.doesNotMatch(INDEX_HTML, /브라우저 메모리에서만 처리/, '영상은 이 컴퓨터의 분석 서버(별도 프로세스)로도 전송됨');
  assert.match(INDEX_HTML, /<button class="btn sm" id="toLoginTop">로그인<\/button>/);
  assert.match(read('PRIVACY.md'), /로그인이 필요/);
  assert.doesNotMatch(read('PRIVACY.md'), /기본 설정은 이름·이메일·비밀번호 입력 없이 사용하는 익명 분석 모드/);
});

/* ═══════════════ 4. 서버 (임시 폴더에 복사본을 띄움) ═══════════════ */
async function freePort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
async function startServer({ envFile = true, extraFiles = {}, mlPort = null, env = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sirius-privacy-'));
  const port = await freePort();
  for (const f of ['server.js', 'package.json', 'index.html', 'css', 'js', 'api']) await cp(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  if (envFile) await writeFile(path.join(dir, '.env.local'), 'GMAIL_USER=\nGMAIL_APP_PASSWORD=\nRESEND_API_KEY=\nAUTH_SECRET=synthetic-secret-do-not-serve-0000000000\n');
  for (const [rel, content] of Object.entries(extraFiles)) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), content); }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NO_OPEN: '1', ML_PORT: String(mlPort ?? await freePort()), GMAIL_USER: '', GMAIL_APP_PASSWORD: '', RESEND_API_KEY: '', ENABLE_EMAIL_AUTH: '', ...env }
  });
  let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  return { dir, port, base, logs: () => logs,
    stop: async () => { if (child.exitCode === null) { const e = once(child, 'exit'); child.kill(); await e; } await rm(dir, { recursive: true, force: true }); } };
}
function raw(port, requestPath, { method = 'GET', headers = {}, body = null, host = `127.0.0.1:${port}`, version = '1.1' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1'); let buf = ''; s.setEncoding('utf8');
    s.on('data', d => { buf += d; }); s.on('error', reject);
    s.on('close', () => { const i = buf.indexOf('\r\n\r\n'); const head = i < 0 ? buf : buf.slice(0, i);
      resolve({ status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1]), head, body: i < 0 ? '' : buf.slice(i + 4) }); });
    const lines = [`${method} ${requestPath} HTTP/${version}`]; if (host !== null) lines.push(`Host: ${host}`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    if (body !== null) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    lines.push('Connection: close'); s.write(lines.join('\r\n') + '\r\n\r\n' + (body ?? ''));
  });
}
function tree(dir, base = dir, out = []) {
  for (const n of readdirSync(dir).sort()) { const p = path.join(dir, n); const st = statSync(p);
    if (st.isDirectory()) tree(p, base, out); else out.push(`${path.relative(base, p)}:${st.size}`); }
  return out;
}

test('서버: 허용 목록 밖 파일과 경로 우회(../, 인코딩, 대소문자, ADS)는 내용이 나가지 않는다', async () => {
  const s = await startServer({ extraFiles: { 'private-export.json': '{"marker":"PRIVATE-EXPORT-MARKER"}', 'data/registry.json': '{"users":[]}', 'ml/model_meta.json': '{}' } });
  try {
    for (const ok of ['/', '/index.html', '/js/app.js', '/css/style.css']) assert.equal((await raw(s.port, ok)).status, 200, ok);
    const attacks = ['/js/../server.js', '/js/..%2fserver.js', '/js/%2e%2e/server.js', '/%2e%2e/%2e%2e/etc/passwd', '/js%5c..%5cserver.js',
      '/index.html%00.js', '/INDEX.HTML', '/index.html::$DATA', '/index.html.', '/js/', '/css/', '/api/_store.js', '/api/_lib.js', '/.git/config',
      '/PRIVACY.md', '/package.json', '/.env.local', '/js/config.js/../../server.js', '/%252e%252e/server.js',
      '/private-export.json', '/data/registry.json', '/ml/model_meta.json', '/node_modules/nodemailer/package.json', '/test/server.test.js'];
    // '//server.js' 는 URL 파서가 호스트로 해석해 '/' 로 처리됨 → index.html 만 나가야 함
    const slash = await raw(s.port, '//server.js');
    assert.equal(slash.status, 200); assert.match(slash.body, /<!doctype html>/i); assert.doesNotMatch(slash.body, /refuseHardcodedKey|AUTH_SECRET/);
    for (const p of attacks) {
      const r = await raw(s.port, p);
      assert.notEqual(r.status, 200, `${p} → 200`);
      assert.doesNotMatch(r.body, /synthetic-secret|PRIVATE-EXPORT-MARKER|refuseHardcodedKey|AUTH_SECRET/, p);
    }
  } finally { await s.stop(); }
});

test('서버: 잘못된 Host·Origin·Sec-Fetch-Site 요청은 어느 경로에서든 거절되고 CORS 허용 헤더가 없다', async () => {
  const s = await startServer();
  try {
    const bad = [
      { host: `attacker.example:${s.port}` }, { host: `127.0.0.1.attacker.example:${s.port}` }, { host: `127.0.0.1:${s.port + 1}` }, { host: null, version: '1.0' },
      { headers: { Origin: 'null' } }, { headers: { Origin: 'https://attacker.example' } }, { headers: { Origin: `http://127.0.0.1:${s.port}.attacker.example` } },
      { headers: { Origin: `http://localhost:${s.port + 1}` } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }
    ];
    for (const extra of bad) for (const [method, p] of [['GET', '/'], ['GET', '/api/health'], ['POST', '/api/analyze'], ['OPTIONS', '/api/analyze']]) {
      const r = await raw(s.port, p, { method, ...extra, headers: { 'Content-Type': 'image/jpeg', ...(extra.headers || {}) }, body: method === 'POST' ? 'x' : null });
      assert.ok([400, 403].includes(r.status), `${JSON.stringify(extra)} ${method} ${p} → ${r.status}`);
      assert.doesNotMatch(r.head, /access-control-allow/i);
    }
    const good = await raw(s.port, '/api/health', { host: `localhost:${s.port}`, headers: { Origin: `http://localhost:${s.port}` } });
    assert.equal(good.status, 200); assert.doesNotMatch(good.head, /access-control-allow/i);
    for (const h of ['x-content-type-options: nosniff', 'x-frame-options: deny', 'referrer-policy: no-referrer', 'cache-control: no-store']) assert.ok(good.head.toLowerCase().includes(h), h);
    for (const route of ['send-code', 'verify-code', 'check-id', 'register']) {
      const r = await raw(s.port, '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a@b.co"}' });
      assert.equal(r.status, 403, route);
    }
  } finally { await s.stop(); }
});

test('서버: 영상은 127.0.0.1 분석 서버로만 전달되고, 파일·로그·오류 응답에 남지 않는다', async () => {
  const seen = []; let mode = 'ok';
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, remote: req.socket.remoteAddress, body: Buffer.concat(chunks) });
      if (mode === 'error') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('UPSTREAM-TRACE-SECRET C:\\Users\\private\\x.py'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ probs: [1, 0, 0, 0], regions: [], model: 'fake' }));
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const s = await startServer({ mlPort: upstream.address().port });
  try {
    const before = tree(s.dir);
    const marker = 'SYNTHETIC-PIXEL-MARKER-7f3a';
    const payload = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker), Buffer.alloc(64, 1)]);
    const headers = { 'Content-Type': 'image/jpeg', Origin: s.base, Cookie: 'sid=leak', Referer: 'http://x/', 'User-Agent': 'ua-secret', 'X-Forwarded-For': '203.0.113.9' };
    const ok = await fetch(s.base + '/api/analyze', { method: 'POST', headers, body: payload });
    assert.equal(ok.status, 200); assert.equal((await ok.json()).model, 'fake');
    mode = 'error';
    const err = await fetch(s.base + '/api/analyze', { method: 'POST', headers, body: payload });
    assert.equal(err.status, 502);
    assert.doesNotMatch(await err.text(), /UPSTREAM-TRACE|Users/);
    assert.equal(seen.length, 2);
    for (const r of seen) {
      assert.equal(r.url, '/analyze'); assert.equal(r.method, 'POST'); assert.match(r.remote, /127\.0\.0\.1/);
      assert.deepEqual(r.body, payload);
      for (const h of ['cookie', 'origin', 'referer', 'user-agent', 'x-forwarded-for', 'authorization']) assert.equal(r.headers[h], undefined, h + ' 전달됨');
    }
    assert.doesNotMatch(s.logs(), /SYNTHETIC-PIXEL-MARKER|UPSTREAM-TRACE|ua-secret|203\.0\.113\.9/);
    assert.deepEqual(tree(s.dir), before, '분석 요청이 작업 폴더에 파일을 만들었음');
    // 분석 서버가 꺼져 있으면 503 (대체 동작은 브라우저가 처리)
    upstream.close(); upstream.closeAllConnections?.(); await new Promise(r => setTimeout(r, 50));
    assert.equal((await fetch(s.base + '/api/analyze', { method: 'POST', headers, body: payload })).status, 503);
  } finally { upstream.closeAllConnections?.(); upstream.close(); await s.stop(); }
});

test('서버: 이메일 인증을 켜지 않은 기본 상태에서는 비밀키 파일(.env.local)을 새로 만들지 않는다 (F-05)', async () => {
  const s = await startServer({ envFile: false });
  try { assert.equal(existsSync(path.join(s.dir, '.env.local')), false); } finally { await s.stop(); }
});

test('서버: 정적 허용 목록은 index.html 이 참조하는 스크립트·스타일만 (F-06)', async () => {
  const s = await startServer({ extraFiles: { 'js/zz-private-note.js': '// PRIVATE-NOTE-MARKER' } });
  try {
    const r = await raw(s.port, '/js/zz-private-note.js');
    assert.notEqual(r.status, 200); assert.doesNotMatch(r.body, /PRIVATE-NOTE-MARKER/);
  } finally { await s.stop(); }
});

/* ═══════════════ 시야 기록(SIRIUS 시야 모듈) 개인정보 점검 ═══════════════ */
function vfSeed(b) {
  b.g(`(() => {
    const g = VF.grid('R');
    for (let i = 0; i < 2; i++) VFS.tests.push({ date: '2026-01-0' + (i + 1), eye: 'R', th: g.map(() => 24), un: [], rel: { fp: 0, fpN: 5, fl: 0, flN: 5, fn: 0, fnN: 3 }, reliable: true, dist: 33 });
    VFS.symptoms.push({ date: '2026-01-02', ids: ['blur'] });
    VFS.dirty = true; vfRenderHome(); vfRenderSummary();
  })()`);
  b.el('vfPass').value = 'synthetic-secret-phrase-1';
  b.el('vfPass2').value = 'synthetic-secret-phrase-1';
}
const vfLeft = b => ({
  tests: b.g('VFS.tests.length'), symptoms: b.g('VFS.symptoms.length'), dirty: b.g('VFS.dirty'), run: b.g('vfRun'),
  pass: b.el('vfPass').value + b.el('vfPass2').value, hist: b.el('vfHistory').innerHTML, status: b.el('vfStatus').innerHTML,
  summary: b.el('vfPrintRoot').innerHTML, trend: b.el('vfTrend').innerHTML
});

test('시야 기록: 로그인한 뒤에 열리고, 네트워크·브라우저 저장소를 쓰지 않는다', async () => {
  const b = buildBrowser();
  login(b); b.g("go('field')");
  assert.equal(b.visible('gate'), false);
  assert.equal(b.doc.querySelector('[data-page="field"]')._hidden, false, '시야 기록 페이지가 열려야 함');
  vfSeed(b);
  assert.match(b.el('vfHistory').innerHTML, /2026-01-01/, '하네스 점검: 기록이 화면에 그려져야 함');
  await b.g("VFFile.encrypt({ tests: VFS.tests, symptoms: VFS.symptoms, rules: VFS.rules }, 'synthetic-secret-phrase-1')");
  assert.equal(b.fetchLog.length, 0, '시야 기록은 네트워크를 쓰지 않는다');
  const allowed = new Set(['neuria-theme', 'neuria-cvd', '-neuria-theme', '-neuria-cvd']);
  assert.deepEqual(b.storageWrites.filter(k => !allowed.has(k)), [], '브라우저 저장소에는 시야 기록을 쓰지 않는다');
  assert.equal(b.cookieWrites.length, 0);
});

test('시야 기록: 나가기를 누르면 기록·증상·요약·파일 비밀번호 입력값이 모두 사라진다', () => {
  const b = buildBrowser();
  login(b); b.g("go('field')");
  vfSeed(b);
  assert.equal(b.g('VFS.tests.length'), 2);
  b.click('lockBtn');
  const left = vfLeft(b);
  assert.equal(left.tests, 0); assert.equal(left.symptoms, 0); assert.equal(left.dirty, false); assert.equal(left.run, null);
  assert.equal(left.pass, '');
  for (const html of [left.hist, left.status, left.summary, left.trend]) assert.doesNotMatch(html, /2026-01|synthetic/);
  assert.equal(b.visible('app'), false);
});

test('시야 기록: 10분 유휴 잠금이 걸리면 검사 중이던 상태와 기록이 함께 지워진다', () => {
  const b = buildBrowser();
  login(b); b.g("go('field')");
  vfSeed(b);
  b.g('vfRun = { timers: [], T: VF.createTest({ eye: "R" }), paused: false }');          // 검사 도중 상황
  const idle = [...b.timers.values()].find(t => t.ms === 10 * 60 * 1000 && !t.interval);
  assert.ok(idle, '유휴 타이머가 있어야 함');
  idle.fn();
  const left = vfLeft(b);
  assert.equal(left.tests, 0); assert.equal(left.run, null); assert.equal(left.pass, '');
  assert.equal(b.el('vfStage')._hidden, true, '검사 화면이 닫혀야 함');
});

test('시야 기록: 화면에 넣는 모든 값은 고정 문구·숫자이고 가져온 파일의 글자는 HTML 로 해석되지 않는다', () => {
  const b = buildBrowser();
  login(b); b.g("go('field')");
  b.g(`(() => {
    const raw = { app: 'sirius-vf', v: 1, tests: [], symptoms: [{ date: '2026-01-02', ids: ['<img src=x onerror=alert(1)>', 'blur'] }], rules: { pointDrop: '<script>' } };
    const s = VF.cleanState(raw);
    VFS.tests = s.tests; VFS.symptoms = s.symptoms; VFS.rules = s.rules;
    vfRenderHome(); vfRenderSummary(); vfRenderSymptom();
  })()`);
  for (const id of ['vfStatus', 'vfTrend', 'vfHistory', 'vfPrintRoot', 'vfRules', 'vfSymList']) assert.doesNotMatch(b.el(id).innerHTML, /<img|<script|onerror/i, id);
  assert.equal(b.g('VFS.rules.pointDrop'), 6);
});

test('정적 점검: 시야 기록 코드에는 네트워크·저장소·동적 코드 실행이 없다', () => {
  for (const name of ['vf-core.js', 'vf-file.js', 'vf-ui.js']) {
    const code = read('js/' + name);
    assert.doesNotMatch(code, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|XMLHttpRequest|sendBeacon|WebSocket|window\.open|\beval\s*\(|new Function|insertAdjacentHTML|document\.write|postMessage/, name);
    assert.doesNotMatch(code, /https?:\/\//, name + ': 외부 주소 금지');
  }
});

test('경과 관찰: 로그인(S.acc+masterKey) 없이는 어떤 화면도 열리지 않고, 로그인하면 홈은 경과 관찰이다', () => {
  const b = buildBrowser();
  for(const page of ['followup', 'analyze', 'result', 'history', 'field', 'guide', 'faq', 'mypage']){
    b.g(`S.acc = null; S.masterKey = null; go('${page}')`);
    assert.equal(b.visible('gate'), true, page + ' → 로그인 화면'); assert.equal(b.visible('app'), false, page + ' → 로그인 없이 앱이 열림');
  }
  b.g("S.acc = { id: 'synthetic_user' }; S.masterKey = null; enterApp();");
  assert.equal(b.visible('app'), false, 'masterKey 가 없으면 enterApp 도 열리지 않음');
  b.g("S.acc = null; S.masterKey = { x: 1 }; enterApp();");
  assert.equal(b.visible('app'), false, 'S.acc 가 없으면 enterApp 도 열리지 않음');
  login(b);
  assert.equal(b.visible('app'), true);
  assert.equal(b.el('pageTitle').textContent, '경과 관찰');
  assert.equal(b.g('S.followup.v'), 1, '로그인 직후 S.followup 이 정제된 빈 상태로 준비됨');
  b.g("go('analyze')"); assert.equal(b.el('pageTitle').textContent, '영상 보기');
});

test('경과 관찰: 로그아웃하면 S.followup 과 화면이 지워지고 다른 계정으로 들어가도 섞이지 않는다', () => {
  const b = buildBrowser();
  login(b);
  b.g("S.followup = FU.addMri(S.followup, '2026-01-01', 18.5, '2026-11-10').state; followupEnter();");
  assert.match(b.el('fuRoot').innerHTML, /18\.5 mm/);
  b.click('lockBtn');
  assert.equal(b.g('S.followup'), null);
  assert.equal(b.el('fuRoot').innerHTML, '');
  login(b);
  assert.equal(b.g('S.followup.mri.length'), 0);
  assert.doesNotMatch(b.el('fuRoot').innerHTML, /18\.5 mm/);
});

test('경과 관찰: logout() 은 기록 화면과 S.followup 을 지운다', () => {
  const b = buildBrowser();
  login(b);
  b.g("S.followup = FU.addMri(S.followup, '2026-01-01', 18.5, '2026-11-10').state; followupEnter();");
  b.g('logout()');
  assert.equal(b.g('S.followup'), null); assert.equal(b.el('fuRoot').innerHTML, '');
});
