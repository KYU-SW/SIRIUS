import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = readFileSync(new URL('../js/store.js', import.meta.url), 'utf8');
function browserTabs(){
  const data = new Map(); let tail = Promise.resolve();
  const locks = {request: (_name, work) => {
    const next = tail.then(work); tail = next.catch(() => {}); return next;
  }};
  const open = () => {
    const context = vm.createContext({crypto:webcrypto, TextEncoder, TextDecoder, btoa, atob,
      CONFIG:{auth:'local'}, navigator:{locks}, localStorage:{
        getItem:k => data.get(k) ?? null, setItem:(k,v) => data.set(k,v), removeItem:k => data.delete(k)
      }});
    vm.runInContext(source, context);
    return {context, accounts:vm.runInContext('accounts', context)};
  };
  return {data, first:open(), second:open()};
}

test('두 탭의 같은 버전 저장 중 하나만 성공하고 새 기록을 덮어쓰지 않는다', async () => {
  const {first,second} = browserTabs();
  await first.context.createAccount({id:'synthetic_user', pw:'Synthetic-Test!123'});
  const a=first.accounts.byId('synthetic_user'), b=second.accounts.byId('synthetic_user');
  const expected=JSON.stringify(a);
  const result=await Promise.all([
    first.accounts.commit({...a,data:'synthetic-new'},expected),
    second.accounts.commit({...b,data:'synthetic-stale'},expected)
  ]);
  assert.equal(result.filter(r => r.ok).length,1);
  assert.equal(result.filter(r => r.conflict).length,1);
  assert.equal(first.accounts.byId(a.id).data,'synthetic-new');
});

test('다른 탭의 비밀번호 변경 뒤 오래된 저장이 이전 비밀번호를 되살리지 못한다', async () => {
  const {first,second}=browserTabs();
  await first.context.createAccount({id:'synthetic_user',pw:'Synthetic-Test!123'});
  const current=first.accounts.byId('synthetic_user'), stale=second.accounts.byId('synthetic_user');
  const unlocked=await first.context.unlockWithPw(current,'Synthetic-Test!123');
  const next={...current};
  await first.context.rewrapPassword(next,unlocked.raw,'Changed-Test!456');
  assert.equal((await first.accounts.commit(next,JSON.stringify(current))).ok,true);
  assert.equal((await second.accounts.commit({...stale,data:'old-record'},JSON.stringify(stale))).conflict,true);
  const saved=first.accounts.byId(current.id);
  await assert.rejects(first.context.unlockWithPw(saved,'Synthetic-Test!123'));
  await first.context.unlockWithPw(saved,'Changed-Test!456');
});

test('계정 삭제 뒤 오래된 탭은 계정을 되살리지 못하고 취소된 저장은 시작하지 않는다', async () => {
  const {first,second}=browserTabs();
  await first.context.createAccount({id:'synthetic_user',pw:'Synthetic-Test!123'});
  const stale=second.accounts.byId('synthetic_user');
  assert.equal((await first.accounts.commit({...stale,data:'cancelled'},JSON.stringify(stale),()=>false)).cancelled,true);
  assert.equal((await first.accounts.erase(stale.id,JSON.stringify(stale))).ok,true);
  assert.equal((await second.accounts.commit(stale,JSON.stringify(stale))).conflict,true);
  assert.equal(first.accounts.byId(stale.id),null);
});

test('손상된 보관함이나 탭 잠금 미지원 환경에서는 덮어쓰지 않는다', async () => {
  const {data,first}=browserTabs();
  data.set('mri-accounts-v3','{broken');
  const result=await first.accounts.commit({id:'synthetic_user'},'null');
  assert.equal(result.corrupt,true);
  assert.equal(data.get('mri-accounts-v3'),'{broken');
  first.context.navigator.locks=null;
  assert.equal((await first.accounts.commit({id:'synthetic_user'},'null')).unsupported,true);
  assert.equal(data.get('mri-accounts-v3'),'{broken');
});

test('변조된 암호화 반복 횟수와 salt 길이는 복호화 연산 전에 거절된다', async () => {
  const {first}=browserTabs();
  const {acc}=await first.context.createAccount({id:'synthetic_user',pw:'Synthetic-Test!123'});
  for(const iter of [0,-1,99999,1200001,1e9,'210000',true,NaN]){
    await assert.rejects(first.context.unlockWithPw({...acc,pwIter:iter},'Synthetic-Test!123'),/암호화 설정/);
  }
  await assert.rejects(first.context.unlockWithPw({...acc,pwSalt:btoa('short')},'Synthetic-Test!123'),/암호화 설정/);
});
