import {test} from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import {sendMail} from '../api/_lib.js';

test('선택적 메일 기능은 TLS·콘텐츠 접근 제한을 강제하고 비활성 상태에서는 전송하지 않는다',async()=>{
  const keys=['ENABLE_EMAIL_AUTH','GMAIL_USER','GMAIL_APP_PASSWORD','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_INSECURE'];
  const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const original=nodemailer.createTransport, options=[];let sends=0;
  nodemailer.createTransport=o=>{options.push(o);return {async sendMail(){sends++;return {}}}};
  try{
    Object.assign(process.env,{ENABLE_EMAIL_AUTH:'true',GMAIL_USER:'synthetic@example.invalid',GMAIL_APP_PASSWORD:'synthetic-test-only',SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_INSECURE:'true'});
    await sendMail('receiver@example.invalid','123456','signup');
    delete process.env.SMTP_HOST;
    await sendMail('receiver@example.invalid','123456','signup');
    assert.equal(sends,2);
    for(const option of options){
      assert.equal(option.requireTLS,true);
      assert.equal(option.disableFileAccess,true);assert.equal(option.disableUrlAccess,true);
      assert.notEqual(option.ignoreTLS,true);assert.notEqual(option.tls?.rejectUnauthorized,false);
    }
    process.env.ENABLE_EMAIL_AUTH='false';
    await assert.rejects(sendMail('receiver@example.invalid','123456','signup'));
    assert.equal(sends,2,'기본 비활성 상태에서는 transport를 호출하지 않음');
  }finally{
    nodemailer.createTransport=original;
    for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];
  }
});
