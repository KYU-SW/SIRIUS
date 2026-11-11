'use strict';

/* ═══════════════════════════════════════════════════════════
   B. 저장소 · 암호화
   구조: 계정마다 임의 마스터키 → 비밀번호 / 복구 키로 각각 봉인
        데이터(이메일 원본·이름·회차)는 마스터키로 암호화
   ═══════════════════════════════════════════════════════════ */
const AKEY = 'mri-accounts-v3';
const OLD2 = 'mri-vault-v2';
const OLD1 = 'mri-reader-v1';
const LKEY = 'mri-attempts-v1';
const ITER = 600000;
const LEGACY_ITER = 210000;
const EMAIL_PEPPER = 'mri-reader/email/v3';
const SUBTLE = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

const b64 = {
  enc(buf){ const a = new Uint8Array(buf); let s=''; for(let i=0;i<a.length;i+=0x8000) s += String.fromCharCode.apply(null, a.subarray(i,i+0x8000)); return btoa(s); },
  dec(str){ return Uint8Array.from(atob(str), c=>c.charCodeAt(0)); }
};
const ls = {
  get(k){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
async function sha256hex(s){
  const d = await SUBTLE.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function kdf(secret, salt, iter){
  if(typeof secret !== 'string' || !Number.isInteger(iter) || iter < 100000 || iter > 1200000 || !salt || salt.byteLength !== 16)
    throw new Error('암호화 설정이 올바르지 않습니다.');
  const base = await SUBTLE.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return SUBTLE.deriveKey({name:'PBKDF2', salt, iterations:iter, hash:'SHA-256'}, base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
async function seal(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await SUBTLE.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj)));
  return {iv:b64.enc(iv), ct:b64.enc(ct)};
}
async function unseal(key, box){
  const pt = await SUBTLE.decrypt({name:'AES-GCM', iv:b64.dec(box.iv)}, key, b64.dec(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
const importMaster = raw => SUBTLE.importKey('raw', raw, {name:'AES-GCM'}, false, ['encrypt','decrypt']);

const REC_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';    // 헷갈리는 0/O/1/I/L 제외
function makeRecoveryKey(){
  let s = '';
  const limit = 256 - (256 % REC_ALPHA.length);
  while(s.length < 20){
    for(const x of crypto.getRandomValues(new Uint8Array(32))){
      if(x < limit && s.length < 20) s += REC_ALPHA[x % REC_ALPHA.length];
    }
  }
  return 'MRI-' + s.match(/.{4}/g).join('-');
}
const normRec = s => s.toUpperCase().replace(/[^A-Z0-9]/g,'');

const accounts = {
  all(){
    const saved = ls.get(AKEY);
    return saved && typeof saved === 'object' && !Array.isArray(saved)
      ? Object.assign(Object.create(null), saved) : Object.create(null);
  },
  save(a){ return ls.set(AKEY, a); },
  byId(id){ return this.all()[String(id||'').toLowerCase()] || null; },
  async byEmail(email){
    const h = await sha256hex(EMAIL_PEPPER + String(email||'').trim().toLowerCase());
    return Object.values(this.all()).find(a => a && a.emailHash === h) || null;
  },
  put(acc){ const a = this.all(); a[acc.id.toLowerCase()] = acc; return this.save(a); },
  remove(id){ const a = this.all(); delete a[String(id).toLowerCase()]; return this.save(a); },
  // Serialize writes across tabs and reject a stale unlocked snapshot.
  async change(id, expected, next, guard = () => true){
    const write = () => {
      if(!guard()) return {ok:false, cancelled:true};
      let all;
      try{
        const raw = localStorage.getItem(AKEY), parsed = raw === null ? {} : JSON.parse(raw);
        if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {ok:false, corrupt:true};
        all = Object.assign(Object.create(null), parsed);
      }catch(e){ return {ok:false, corrupt:true}; }
      const key = String(id).toLowerCase();
      if(JSON.stringify(all[key] || null) !== expected) return {ok:false, conflict:true};
      if(next) all[key] = next; else delete all[key];
      return {ok:this.save(all)};
    };
    if(typeof navigator !== 'undefined'){
      if(!navigator.locks || typeof navigator.locks.request !== 'function') return {ok:false, unsupported:true};
      return navigator.locks.request('sirius-local-vault-write', write);
    }
    return write(); // Non-browser unit-test environment.
  },
  commit(acc, expected, guard){ return this.change(acc.id, expected, acc, guard); },
  erase(id, expected, guard){ return this.change(id, expected, null, guard); }
};

function maskEmail(e){
  const [l, d] = String(e).split('@');
  if(!d) return '***';
  const ml = l.length <= 2 ? l[0] + '*' : l.slice(0,2) + '*'.repeat(Math.max(1, l.length-2));
  const parts = d.split('.');
  return `${ml}@${parts[0][0]}${'*'.repeat(Math.max(1, parts[0].length-1))}.${parts.slice(1).join('.')}`;
}
function maskId(id){
  return id.length <= 3 ? id[0] + '**' : id.slice(0,2) + '*'.repeat(id.length-3) + id.slice(-1);
}

/* 계정 생성 */
async function createAccount({id, email = '', pw, scans, name}, isCurrent = () => true){
  if(typeof CONFIG !== 'undefined' && CONFIG.privacy) throw new Error('개인정보 보호 모드에서는 계정을 만들지 않습니다.');
  if(typeof CONFIG !== 'undefined' && CONFIG.auth === 'local') email = '';
  if(typeof id !== 'string' || !/^[A-Za-z0-9_]{4,20}$/.test(id) || accounts.byId(id)) throw new Error('사용할 수 없는 아이디입니다.');
  if(typeof pw !== 'string' || pw.length < 8 || pw.length > 256) throw new Error('비밀번호 길이를 확인해 주세요.');
  const master = crypto.getRandomValues(new Uint8Array(32));
  const mKey = await importMaster(master);
  const pwSalt = crypto.getRandomValues(new Uint8Array(16));
  const recSalt = crypto.getRandomValues(new Uint8Array(16));
  const rec = makeRecoveryKey();
  const acc = {
    v: 3,
    id,
    emailHash: email ? await sha256hex(EMAIL_PEPPER + email.toLowerCase()) : '',
    emailMask: email ? maskEmail(email) : '',
    created: new Date().toISOString(),
    pwSalt: b64.enc(pwSalt), recSalt: b64.enc(recSalt), iter: ITER,
    wrapPw:  await seal(await kdf(pw, pwSalt, ITER), {m: b64.enc(master)}),
    wrapRec: await seal(await kdf(normRec(rec), recSalt, ITER), {m: b64.enc(master)}),
    data:    await seal(mKey, {email, name: name || '', scans: scans || []})
  };
  const result = await accounts.commit(acc, 'null', isCurrent);
  if(result.cancelled) throw new Error('계정 생성을 취소했습니다.');
  if(!result.ok) throw new Error(result.conflict ? '다른 탭에서 이미 만든 아이디입니다.' : result.unsupported ? '최신 Chrome·Edge·Safari에서 localhost로 실행한 주소 또는 HTTPS 주소로 열어 주세요.' : '브라우저 저장 공간이 부족하거나 저장 자료를 읽을 수 없습니다. 기존 자료는 덮어쓰지 않았습니다.');
  return {acc, rec};
}
async function unlockWithPw(acc, pw){
  const kek = await kdf(pw, b64.dec(acc.pwSalt), wrapIterations(acc, 'pwIter'));
  const {m} = await unseal(kek, acc.wrapPw);          // 틀리면 예외
  return { raw: b64.dec(m), key: await importMaster(b64.dec(m)) };
}
async function unlockWithRec(acc, rec){
  const kek = await kdf(normRec(rec), b64.dec(acc.recSalt), wrapIterations(acc, 'recIter'));
  const {m} = await unseal(kek, acc.wrapRec);
  return { raw: b64.dec(m), key: await importMaster(b64.dec(m)) };
}
function wrapIterations(acc, field){
  return acc[field] === undefined ? (acc.iter === undefined ? LEGACY_ITER : acc.iter) : acc[field];
}
async function rewrapPassword(acc, masterRaw, newPw){
  const recIter = wrapIterations(acc, 'recIter');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  acc.pwSalt = b64.enc(salt);
  acc.wrapPw = await seal(await kdf(newPw, salt, ITER), {m: b64.enc(masterRaw)});
  acc.iter = ITER;
  acc.pwIter = ITER;
  acc.recIter = recIter; // A password update must not invalidate the existing recovery key.
  return acc;
}
async function rewrapRecovery(acc, masterRaw){
  const pwIter = wrapIterations(acc, 'pwIter');
  const rec = makeRecoveryKey();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  acc.recSalt = b64.enc(salt);
  acc.wrapRec = await seal(await kdf(normRec(rec), salt, ITER), {m: b64.enc(masterRaw)});
  acc.pwIter = pwIter;
  acc.recIter = ITER;
  return rec;
}
