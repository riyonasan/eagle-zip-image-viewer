'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../lib/retry.cjs');

test('retry is initial attempt plus at most three retries for any read/generation error', async()=>{
  for(const code of ['ENOENT','CRC','LIMIT',undefined]) {
    let attempts=0;
    await assert.rejects(retry(()=>{attempts++;throw Object.assign(Error('failure'),{code});},{delays:[0,0,0]}));
    assert.equal(attempts,4);
  }
  let count=0;assert.equal(await retry(()=>{if(++count<4)throw Error('retry');return 'ready';},{delays:[0,0,0]}),'ready');
});

test('retry cancellation stops both before first attempt and while waiting', async()=>{
  let calls=0;const controller=new AbortController();controller.abort();
  await assert.rejects(retry(()=>{calls++;},{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
  const waiting=new AbortController();
  await assert.rejects(retry(()=>{calls++;setImmediate(()=>waiting.abort());throw Error('later');},{signal:waiting.signal,delays:[10000,10000,10000]}),{name:'AbortError'});
  assert.equal(calls,1);
});
