'use strict';
/* ═══════════════════════════════════════════════════════════
   V. 시야 기록 파일 — 비밀번호로 암호화해서 내보내고 불러옵니다
   ───────────────────────────────────────────────────────────
   · 기록은 브라우저 저장소에 남기지 않습니다. 보관은 환자가 가진 파일 한 개뿐입니다.
   · 암호화: PBKDF2-SHA256 + AES-256-GCM (store.js 의 kdf/seal/unseal 재사용, 자체 암호 없음)
   · 파일에는 이름·이메일·생년월일이 들어가지 않습니다. 날짜·눈·검사값·증상 코드만 있습니다.
   · 불러올 때는 복호화한 내용을 그대로 쓰지 않고 VF.cleanState 로 숫자·목록만 다시 만듭니다.
   ═══════════════════════════════════════════════════════════ */
const VFFile = (() => {
  const ITER_FILE = 600000;                  // 파일이 유출돼도 오프라인 대입이 어렵도록 계정 암호보다 높게
  const ITER_MIN = 200000, ITER_MAX = 1200000;   // 파일 헤더가 바뀌어도 과도한 연산을 하지 않도록 범위 제한
  const MAX_BYTES = 2 * 1024 * 1024;
  const MIN_PASS = 12;
  const FAIL = '비밀번호가 맞지 않거나 올바른 SIRIUS 시야 기록 파일이 아닙니다.';
  const isB64 = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

  function passProblem(p){
    if(typeof p !== 'string' || p.length < MIN_PASS) return `비밀번호는 ${MIN_PASS}자 이상으로 정해 주세요. 여러 낱말을 이어 쓰면 외우기 쉽습니다.`;
    if(/^\s|\s$/.test(p)) return '비밀번호 앞뒤에 공백이 있습니다.';
    if(new Set(p).size < 5) return '같은 글자가 너무 많이 반복됩니다.';
    return '';
  }
  async function encrypt(state, pass){
    if(!SUBTLE) throw new Error('이 브라우저에서는 암호화를 쓸 수 없습니다.');
    const problem = passProblem(pass); if(problem) throw new Error(problem);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const box = await seal(await kdf(pass, salt, ITER_FILE), VF.exportable(state));
    return JSON.stringify({ format:'sirius-vf', v:1, kdf:'PBKDF2-SHA256', iter:ITER_FILE, salt:b64.enc(salt), iv:box.iv, ct:box.ct });
  }
  async function decrypt(text, pass){
    if(!SUBTLE) throw new Error('이 브라우저에서는 암호화를 쓸 수 없습니다.');
    try{
      if(typeof text !== 'string' || text.length > MAX_BYTES) throw 0;
      const f = JSON.parse(text);
      if(!f || f.format !== 'sirius-vf' || f.v !== 1 || f.kdf !== 'PBKDF2-SHA256') throw 0;
      if(!Number.isInteger(f.iter) || f.iter < ITER_MIN || f.iter > ITER_MAX) throw 0;
      if(!isB64(f.salt, 16, 32) || !isB64(f.iv, 12, 24) || !isB64(f.ct, 16, MAX_BYTES)) throw 0;
      const raw = await unseal(await kdf(String(pass), b64.dec(f.salt), f.iter), { iv:f.iv, ct:f.ct });
      return VF.cleanState(raw);
    }catch(e){ throw new Error(FAIL); }
  }
  const pad = n => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fileName = (d = new Date()) => `sirius-vf-${localDate(d).replace(/-/g, '')}.sirius`;
  function download(text, name){
    const url = URL.createObjectURL(new Blob([text], { type:'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  return Object.freeze({ passProblem, encrypt, decrypt, fileName, localDate, download, MAX_BYTES, MIN_PASS, FAIL });
})();
