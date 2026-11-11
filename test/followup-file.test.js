import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const ctx=vm.createContext({crypto:webcrypto,btoa,atob,TextEncoder,TextDecoder,
  localStorage:{getItem(){throw Error('No storage');},setItem(){throw Error('No storage');}}});
for(const file of ['store.js','vf-core.js','vf-file.js','followup-core.js','followup-file.js'])
  vm.runInContext(readFileSync(new URL('../js/'+file,import.meta.url),'utf8'),ctx);
const FU=vm.runInContext('FU',ctx), File=vm.runInContext('FUFile',ctx);
const PASS='Synthetic-backup-passphrase!123';
const plain=value=>JSON.parse(JSON.stringify(value));
function state(){
  const s=FU.empty();s.loc='sellar';s.mri=[{date:'2026-01-01',size:18.5}];
  s.checks=[{id:1,type:'sym',date:'2026-02-01',items:['vis1']}];
  s.email='never-export@example.invalid';s.name='SyntheticPrivateMarker';
  return s;
}

test('경과관찰 백업은 암호화 왕복하며 계정 식별자와 알 수 없는 필드는 제외한다',async()=>{
  const text=await File.encrypt(state(),PASS);
  for(const marker of ['2026-01-01','never-export@example.invalid','SyntheticPrivateMarker','"mri"','"checks"'])assert.ok(!text.includes(marker));
  assert.deepEqual(plain(await File.decrypt(text,PASS)),plain(FU.clean(state())));
  const second=JSON.parse(await File.encrypt(state(),PASS)),first=JSON.parse(text);
  assert.notEqual(first.salt,second.salt);assert.notEqual(first.iv,second.iv);assert.notEqual(first.ct,second.ct);
});

test('잘못된 비밀번호·변조·과도한 반복 횟수·다른 종류 파일은 같은 일반 오류로 거절한다',async()=>{
  const text=await File.encrypt(state(),PASS), f=JSON.parse(text);
  const bad=[['{}',PASS],[text,'wrong-password'],[JSON.stringify({...f,format:'sirius-vf'}),PASS],
    [JSON.stringify({...f,iter:1e9}),PASS],[JSON.stringify({...f,iv:btoa('short')}),PASS],
    [JSON.stringify({...f,ct:(f.ct[0]==='A'?'B':'A')+f.ct.slice(1)}),PASS],['x'.repeat(File.MAX_BYTES+1),PASS]];
  for(const [value,pass]of bad)await assert.rejects(File.decrypt(value,pass),e=>e.message===File.FAIL);
});

test('인증된 암호문이어도 손상된 기록을 버린 채 일부만 복원하지 않는다',async()=>{
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const corrupt=FU.empty();corrupt.checks=[{type:'tap',date:'2026-01-01',L:{n:-10},R:{n:5}}];
  const key=await ctx.kdf(PASS,salt,600000);
  for(const body of [corrupt,{...FU.empty(),next:'broken-date'},
    {...FU.empty(),meds:{hormone:'unsupported',date:null}},
    {...FU.empty(),meds:{hormone:'now',date:'broken-date'}}]){
    const box=await ctx.seal(key,body);
    const f={format:'sirius-followup',v:1,kdf:'PBKDF2-SHA256',iter:600000,salt:btoa(String.fromCharCode(...salt)),...box};
    await assert.rejects(File.decrypt(JSON.stringify(f),PASS),e=>e.message===File.FAIL);
  }
});

test('백업 비밀번호와 파일 이름에는 계정 식별 정보를 사용하지 않는다',()=>{
  assert.ok(File.passProblem('short'));assert.ok(File.passProblem('a'.repeat(20)));
  assert.ok(File.passProblem('x'.repeat(257)));assert.equal(File.passProblem(PASS),'');
  assert.match(File.fileName(),/^sirius-followup-\d{8}\.sirius-followup$/);
});
