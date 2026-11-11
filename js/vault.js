'use strict';

// Only the latest write in the same unlocked account may update the vault.
let vaultWriteSeq = 0;
function cancelVaultWrites(){ vaultWriteSeq++; }

async function saveVault(){
  if(S.guest || !S.masterKey || !S.acc) return {ok:false};
  const seq = ++vaultWriteSeq, account = S.acc, key = S.masterKey;
  const expected = JSON.stringify(account);
  const stale = () => seq !== vaultWriteSeq || S.acc !== account || S.masterKey !== key;
  try{
    const box = await seal(key, {email:S.email, name:S.name, scans:S.scans, followup:S.followup || null});
    if(stale()) return {ok:false, cancelled:true};
    const next = {...account, data:box};
    let result;
    try{
      result = accounts.commit ? await accounts.commit(next, expected, () => !stale()) : {ok:accounts.put(next)};
    }catch(e){ result = {ok:false}; }
    if(stale()) return {ok:false, cancelled:true};
    if(result.ok) account.data = box;
    return result;
  }catch(e){ return stale() ? {ok:false, cancelled:true} : {ok:false}; }
}
