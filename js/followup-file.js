'use strict';

// A user-selected encrypted backup, separate from account credentials and the legacy VF file.
const FUFile = (() => {
  const MAX_BYTES = 2 * 1024 * 1024, ITER = 600000;
  const FAIL = '비밀번호가 맞지 않거나 올바른 SIRIUS 경과관찰 백업이 아닙니다.';
  const base64 = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  function passProblem(pass){
    if(typeof pass !== 'string' || pass.length > 256) return '백업 비밀번호는 12~256자로 정해 주세요.';
    return VFFile.passProblem(pass);
  }
  function checkedBody(raw){
    if(!raw || raw.v !== FU.V || !Array.isArray(raw.mri) || !Array.isArray(raw.checks)) throw new Error(FAIL);
    if(raw.mri.length > FU.MAX_MRI || raw.checks.length > FU.MAX_CHECKS) throw new Error(FAIL);
    const state = FU.clean(raw);
    // Do not silently discard damaged records while replacing a user's vault.
    if(state.mri.length !== raw.mri.length || state.checks.length !== raw.checks.length || state.loc !== raw.loc) throw new Error(FAIL);
    if(raw.next !== state.next || !raw.meds || raw.meds.hormone !== state.meds.hormone || raw.meds.date !== state.meds.date) throw new Error(FAIL);
    return state;
  }
  async function encrypt(state, pass){
    if(!SUBTLE) throw new Error('이 브라우저에서는 암호화를 쓸 수 없습니다.');
    const problem = passProblem(pass); if(problem) throw new Error(problem);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const box = await seal(await kdf(pass, salt, ITER), FU.clean(state));
    return JSON.stringify({format:'sirius-followup',v:1,kdf:'PBKDF2-SHA256',iter:ITER,salt:b64.enc(salt),iv:box.iv,ct:box.ct});
  }
  async function decrypt(text, pass){
    if(!SUBTLE) throw new Error('이 브라우저에서는 암호화를 쓸 수 없습니다.');
    try{
      if(typeof text !== 'string' || text.length > MAX_BYTES || typeof pass !== 'string' || pass.length > 256) throw 0;
      const file = JSON.parse(text);
      if(!file || file.format !== 'sirius-followup' || file.v !== 1 || file.kdf !== 'PBKDF2-SHA256') throw 0;
      if(!Number.isInteger(file.iter) || file.iter < 200000 || file.iter > 1200000) throw 0;
      if(!base64(file.salt,24,24) || !base64(file.iv,16,16) || !base64(file.ct,24,MAX_BYTES)) throw 0;
      const salt=b64.dec(file.salt), iv=b64.dec(file.iv);
      if(salt.byteLength !== 16 || iv.byteLength !== 12) throw 0;
      const raw=await unseal(await kdf(pass,salt,file.iter),{iv:file.iv,ct:file.ct});
      return checkedBody(raw);
    }catch(e){ throw new Error(FAIL); }
  }
  const fileName = () => `sirius-followup-${FU.localDate().replace(/-/g,'')}.sirius-followup`;
  return Object.freeze({MAX_BYTES,FAIL,passProblem,encrypt,decrypt,fileName,download:VFFile.download});
})();
