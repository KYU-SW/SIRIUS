import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

function storage() {
  const data = new Map();
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    localStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key),
    },
  });
  vm.runInContext(readFileSync(new URL('../js/store.js', import.meta.url), 'utf8'), context);
  return { data, context, accounts: vm.runInContext('accounts', context) };
}

test('개인정보 보호 모드에서는 계정 생성과 저장이 시작되지 않는다', async () => {
  const {data,context} = storage();
  context.CONFIG = {privacy:true};
  const create = vm.runInContext('createAccount', context);
  await assert.rejects(create({id:'demo_user',email:'fake@example.com'}), /계정을 만들지 않습니다/);
  assert.equal(data.size,0);
});

test('내장 객체 이름이 등록된 계정으로 오인되지 않는다', () => {
  const { accounts } = storage();
  assert.equal(accounts.byId('constructor'), null);
  assert.equal(accounts.byId('__proto__'), null);
});

test('기기 전용 계정은 전달된 이메일도 저장하지 않고 비밀번호로만 복호화한다', async () => {
  const {data, context} = storage();
  context.CONFIG = {privacy:false, auth:'local'};
  const {acc} = await context.createAccount({id:'local_user', email:'do-not-store@example.invalid', pw:'Synthetic-Test!123'});
  assert.equal(acc.emailHash, '');
  assert.equal(acc.emailMask, '');
  const unlocked = await context.unlockWithPw(acc, 'Synthetic-Test!123');
  assert.equal((await context.unseal(unlocked.key, acc.data)).email, '');
  assert.ok(!data.get('mri-accounts-v3').includes('do-not-store'));
  await assert.rejects(context.unlockWithPw(acc, 'incorrect'));
});

test('특수한 이름도 일반 계정처럼 저장·조회·삭제한다', () => {
  const { accounts } = storage();
  for (const id of ['constructor', '__proto__', 'normal_user']) {
    assert.equal(accounts.put({ id, emailMask: 'a***@example.com' }), true);
    assert.equal(accounts.byId(id).id, id);
  }
  accounts.remove('__proto__');
  assert.equal(accounts.byId('__proto__'), null);
  assert.equal(accounts.byId('normal_user').id, 'normal_user');
});

test('저장된 계정 목록의 잘못된 형태를 빈 목록으로 처리한다', () => {
  const { data, accounts } = storage();
  for (const value of ['[]', 'null', '42', '"string"', '{']) {
    data.set('mri-accounts-v3', value);
    assert.equal(Object.keys(accounts.all()).length, 0);
  }
});

test('암호화 계정은 비밀번호·복구 키로 열리고 재발급 후 이전 키를 거부한다', async () => {
  const { data, context } = storage();
  const { acc, rec } = await context.createAccount({ id: 'demo', email: 'demo@example.invalid', pw: 'Example-Password!123', name: 'PrivateNameMarker', scans: [{ note: 'private-scan-marker' }] });
  const persisted = data.get('mri-accounts-v3');
  for (const secret of ['Example-Password!123', 'demo@example.invalid', 'PrivateNameMarker', 'private-scan-marker']) assert.ok(!persisted.includes(secret));
  const unlocked = await context.unlockWithPw(acc, 'Example-Password!123');
  assert.equal((await context.unseal(unlocked.key, acc.data)).scans[0].note, 'private-scan-marker');
  await assert.rejects(context.unlockWithPw(acc, 'incorrect'));
  const recovered = await context.unlockWithRec(acc, rec);
  assert.equal((await context.unseal(recovered.key, acc.data)).name, 'PrivateNameMarker');
  await context.rewrapPassword(acc, unlocked.raw, 'Changed-Password!456');
  await assert.rejects(context.unlockWithPw(acc, 'Example-Password!123'));
  assert.equal((await context.unseal((await context.unlockWithPw(acc, 'Changed-Password!456')).key, acc.data)).email, 'demo@example.invalid');
  const nextRecovery = await context.rewrapRecovery(acc, unlocked.raw);
  await assert.rejects(context.unlockWithRec(acc, rec));
  assert.equal((await context.unseal((await context.unlockWithRec(acc, nextRecovery)).key, acc.data)).scans.length, 1);
});

test('이전 반복 횟수의 계정도 비밀번호·복구 키를 따로 갱신하며 기존 기록을 유지한다', async () => {
  const {context}=storage();
  const oldIter=100000, pw='Legacy-Test!123', rec='MRI-SYNTH-ETIC-RECOVERY';
  const master=webcrypto.getRandomValues(new Uint8Array(32));
  const pwSalt=webcrypto.getRandomValues(new Uint8Array(16)), recSalt=webcrypto.getRandomValues(new Uint8Array(16));
  const encoded=x=>btoa(String.fromCharCode(...x));
  const acc={id:'legacy_user',iter:oldIter,pwSalt:encoded(pwSalt),recSalt:encoded(recSalt),
    wrapPw:await context.seal(await context.kdf(pw,pwSalt,oldIter),{m:encoded(master)}),
    wrapRec:await context.seal(await context.kdf(rec.replace(/[^A-Z0-9]/g,''),recSalt,oldIter),{m:encoded(master)})};
  acc.data=await context.seal(await vm.runInContext('importMaster',context)(master),{marker:'synthetic-preserved-record'});
  const original=await context.unlockWithPw(acc,pw);
  await context.rewrapPassword(acc,original.raw,'Updated-Test!456');
  assert.equal(acc.pwIter,600000);assert.equal(acc.recIter,oldIter);
  await context.unlockWithRec(acc,rec);
  await assert.rejects(context.unlockWithPw(acc,pw));
  await context.unlockWithPw(acc,'Updated-Test!456');
  const replacement=await context.rewrapRecovery(acc,original.raw);
  assert.equal(acc.recIter,600000);
  const recovered=await context.unlockWithRec(acc,replacement);
  assert.equal((await context.unseal(recovered.key,acc.data)).marker,'synthetic-preserved-record');
  await context.unlockWithPw(acc,'Updated-Test!456');
  await assert.rejects(context.unlockWithRec(acc,rec));
});
