'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { acquireVideoLock, PROTOCOL } = require('../lib/video-lock.cjs');
const windows = process.platform === 'win32';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'zip-lock-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}

test('Windows mutex serializes thumbnail/viewer contenders and permits cancellation', {skip:!windows}, async t=>{
  const root=await fixture(t);let active=0,maximum=0;
  const work=async()=>{const release=await acquireVideoLock(root);active++;maximum=Math.max(maximum,active);await delay(20);active--;await release();};
  await Promise.all([work(),work(),work()]);assert.equal(maximum,1);
  const release=await acquireVideoLock(root);const controller=new AbortController();
  const waiting=acquireVideoLock(root,{signal:controller.signal});controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});await release();
  assert.deepEqual(await fs.readdir(root),[]);
});

test('terminated owner releases its OS mutex and leftover guard can be recovered concurrently', {skip:!windows}, async t=>{
  const root=await fixture(t);
  const code="require(process.argv[1]).acquireVideoLock(process.argv[2]).then(()=>{process.stdout.write('ready');setInterval(()=>{},1000);}).catch(e=>{console.error(e);process.exit(1);});";
  const child=spawn(process.execPath,['-e',code,require.resolve('../lib/video-lock.cjs'),root],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('child exited before lock');}),delay(5000).then(()=>{throw Error('child did not acquire lock');})]);
  assert.equal(ready[0].toString(),'ready');
  const exited=once(child,'exit');child.kill();await exited;
  let count=0;
  await Promise.all([1,2].map(async()=>{const release=await acquireVideoLock(root);count++;await delay(10);await release();}));
  assert.equal(count,2);assert.deepEqual(await fs.readdir(root),[]);
  // Also recover the PID-only format used by the prior version, but only after
  // that exact process has stopped. No existing user process is signalled.
  await fs.writeFile(path.join(root,'quota.lock'),String(child.pid));
  const release=await acquireVideoLock(root);await release();
});

test('live legacy owner and unknown guards are never stolen or deleted', async t=>{
  const root=await fixture(t), file=path.join(root,'quota.lock');
  for(const content of [String(process.pid),'unknown','']) {
    await fs.writeFile(file,content);
    await assert.rejects(acquireVideoLock(root,{lockTimeoutMs:15}));
    assert.equal(await fs.readFile(file,'utf8'),content);
  }
});

test('orphan new-format guard recovers with a still-live PID only under the Windows mutex', {skip:!windows}, async t=>{
  const root=await fixture(t);await fs.writeFile(path.join(root,'quota.lock'),JSON.stringify({protocol:PROTOCOL,pid:process.pid}));
  const release=await acquireVideoLock(root);await release();assert.deepEqual(await fs.readdir(root),[]);
});

test('normal release will not delete a guard whose owner has changed', async t=>{
  const root=await fixture(t), file=path.join(root,'quota.lock');
  const release=await acquireVideoLock(root);await fs.writeFile(file,'different owner');
  await assert.rejects(release,/所有者が変わった/);
  assert.equal(await fs.readFile(file,'utf8'),'different owner');
});

test('a late accept error cannot release the mutex while protected work still owns it', {skip:!windows}, async t=>{
  const root=await fixture(t), original=net.createServer;let server,release;
  net.createServer=(...args)=>{server=original(...args);return server;};
  try { release=await acquireVideoLock(root); } finally { net.createServer=original; }
  try {
    const owner=await fs.readFile(path.join(root,'quota.lock'),'utf8');
    server.emit('error',Object.assign(new Error('synthetic accept failure'),{code:'EMFILE'}));
    assert.equal(server.listening,true);
    await assert.rejects(acquireVideoLock(root,{lockTimeoutMs:20}),/別の動画/);
    assert.equal(await fs.readFile(path.join(root,'quota.lock'),'utf8'),owner);
  } finally { await release(); }
  const next=await acquireVideoLock(root);await next();
});
