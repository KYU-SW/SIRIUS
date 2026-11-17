import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

/* store.js 의 kdf/seal/unseal 과 vf-core.js, vf-file.js 를 실제 코드 그대로 실행합니다. 합성 데이터만 사용합니다. */
const ctx = vm.createContext({ crypto: webcrypto, btoa, atob, TextEncoder, TextDecoder, localStorage: { getItem(){ throw new Error('저장소 사용 금지'); }, setItem(){ throw new Error('저장소 사용 금지'); } } });
for(const f of ['store.js', 'vf-map.js', 'vf-core.js', 'vf-file.js']) vm.runInContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'), ctx);
const VF = vm.runInContext('VF', ctx), VFFile = vm.runInContext('VFFile', ctx);
const J = v => JSON.parse(JSON.stringify(v));

const PASS = 'synthetic-pass-phrase-A1';
function state(){
  const g = VF.grid('R');
  return { tests: ['2026-01-05', '2026-01-12'].map(date => ({ date, eye: 'R', th: g.map((p, i) => 20 + (i % 5)), un: [], rel: { fp: 0, fpN: 10, fl: 1, flN: 10, fn: 0, fnN: 4 }, reliable: true, dist: 33 })),
           symptoms: [{ date: '2026-01-12', ids: ['blur'] }], rules: VF.RULES_DEFAULT };
}

test('암호화한 기록은 같은 비밀번호로 그대로 복원된다', async () => {
  const text = await VFFile.encrypt(state(), PASS);
  const back = J(await VFFile.decrypt(text, PASS));
  assert.equal(back.tests.length, 2);
  assert.deepEqual(back.tests[0].th, J(state().tests[0].th));
  assert.deepEqual(back.symptoms, [{ date: '2026-01-12', ids: ['blur'] }]);
  assert.deepEqual(back.rules, J(VF.RULES_DEFAULT));
});
test('파일 안에는 검사 날짜·값·증상이 평문으로 보이지 않고 이름·이메일 칸도 없다', async () => {
  const text = await VFFile.encrypt(state(), PASS);
  for(const needle of ['2026-01', '"th"', 'blur', 'tests', 'symptoms', 'email', 'name', '이름']) assert.ok(!text.includes(needle), needle);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['ct', 'format', 'iter', 'iv', 'kdf', 'salt', 'v']);
});
test('같은 내용도 저장할 때마다 다른 파일이 된다(무작위 salt·iv)', async () => {
  const a = JSON.parse(await VFFile.encrypt(state(), PASS)), b = JSON.parse(await VFFile.encrypt(state(), PASS));
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.iv, b.iv); assert.notEqual(a.ct, b.ct);
});
test('틀린 비밀번호·변조·형식 오류는 모두 같은 일반 오류로 거부한다', async () => {
  const text = await VFFile.encrypt(state(), PASS);
  const f = JSON.parse(text);
  const flip = s => (s[10] === 'A' ? 'B' : 'A') ? s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11) : s;
  const variants = [
    [text, 'wrong-pass-phrase-zz'], [JSON.stringify({ ...f, ct: flip(f.ct) }), PASS], [JSON.stringify({ ...f, iv: flip(f.iv) }), PASS],
    [JSON.stringify({ ...f, salt: flip(f.salt) }), PASS], [JSON.stringify({ ...f, v: 2 }), PASS], [JSON.stringify({ ...f, format: 'x' }), PASS],
    [JSON.stringify({ ...f, kdf: 'MD5' }), PASS], ['not json', PASS], ['', PASS], [null, PASS], ['{}', PASS],
    [JSON.stringify({ ...f, ct: '<script>' }), PASS], [JSON.stringify({ ...f, salt: 5 }), PASS]
  ];
  for(const [t, p] of variants) await assert.rejects(() => VFFile.decrypt(t, p), e => e.message === VFFile.FAIL);
});
test('헤더의 반복 횟수를 비정상 값으로 바꿔 과도한 연산을 시키지 못한다', async () => {
  const f = JSON.parse(await VFFile.encrypt(state(), PASS));
  for(const iter of [1, 100, 5e9, -1, 1.5, '600000', null]){
    const t0 = Date.now();
    await assert.rejects(() => VFFile.decrypt(JSON.stringify({ ...f, iter }), PASS), e => e.message === VFFile.FAIL);
    assert.ok(Date.now() - t0 < 500, 'iter ' + iter);
  }
});
test('너무 큰 파일은 해석하지 않고 거부한다', async () => {
  await assert.rejects(() => VFFile.decrypt('x'.repeat(VFFile.MAX_BYTES + 1), PASS), e => e.message === VFFile.FAIL);
});
test('암호화 뒤 내용이 형식에 맞지 않으면(위조 파일) 불러오기가 거부된다', async () => {
  // 올바른 키로 봉인했지만 내용이 검증을 통과하지 못하는 파일
  const badState = state(); badState.tests[0].th[0] = 99;
  const src = vm.runInContext('(async (pass, s) => { const salt = crypto.getRandomValues(new Uint8Array(16)); const box = await seal(await kdf(pass, salt, 600000), s); return JSON.stringify({format:"sirius-vf",v:1,kdf:"PBKDF2-SHA256",iter:600000,salt:b64.enc(salt),iv:box.iv,ct:box.ct}); })', ctx);
  const forged = await src(PASS, { app: 'sirius-vf', v: 1, tests: J(badState.tests), symptoms: [], rules: {} });
  await assert.rejects(() => VFFile.decrypt(forged, PASS), e => e.message === VFFile.FAIL);
});
test('내보내기 비밀번호 규칙: 12자 이상, 앞뒤 공백·반복 글자 거부', async () => {
  assert.ok(VFFile.passProblem('short'));
  assert.ok(VFFile.passProblem(' leading-space-1234'));
  assert.ok(VFFile.passProblem('aaaaaaaaaaaaaa'));
  assert.equal(VFFile.passProblem(PASS), '');
  await assert.rejects(() => VFFile.encrypt(state(), 'short'), /12자/);
});
test('파일 이름에는 개인 정보가 없고 날짜 형식이다', () => {
  assert.match(VFFile.fileName(new Date(2026, 10, 10)), /^sirius-vf-20261110\.sirius$/);
  assert.equal(VFFile.localDate(new Date(2026, 0, 5)), '2026-01-05');
});
