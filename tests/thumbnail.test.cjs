'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { zip, PNG } = require('./fixture.cjs');
const { openArchive } = require('../lib/archive.cjs');

test('thumbnail uses natural first page, writes only supplied output, and closes archive', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-thumbnail-test-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const src = path.join(dir,'synthetic.zip'), dest = path.join(dir,'thumbnail.png');
  await fs.writeFile(src,zip([{name:'1.mp4'},{name:'10.png'},{name:'2.png'}]));
  const calls=[], revokes=[]; let closed=false;
  const canvas={getContext:()=>({drawImage:()=>calls.push('draw')}),toDataURL:()=>`data:image/png;base64,${PNG.toString('base64')}`};
  const context=vm.createContext({module:{exports:{}},Buffer,Blob,setTimeout,clearTimeout,
    require:name=>name==='./lib/archive.cjs'?{openArchive:async file=>{const a=await openArchive(file);return {...a,readPage:async i=>{const p=await a.readPage(i);calls.push(p.name);return p;},close:()=>{closed=true;a.close();}};}}:require(name),
    document:{createElement:tag=>{assert.equal(tag,'canvas');return canvas;}},
    URL:{createObjectURL:()=> 'blob:cover',revokeObjectURL:url=>revokes.push(url)},
    Image:class {set src(_){queueMicrotask(()=>this.onload?.());} removeAttribute(){} }
  });
  vm.runInContext(syncFs.readFileSync(require.resolve('../thumbnail.cjs'),'utf8'),context);
  const item={name:'archive'};
  assert.equal(await context.module.exports({src,dest,item}),item);
  assert.deepEqual(calls,['2.png','draw']); assert.equal(closed,true);
  assert.equal(item.width,1);assert.equal(item.height,1);assert.equal(canvas.width,1);
  assert.deepEqual(await fs.readFile(dest),PNG);assert.deepEqual(revokes,['blob:cover']);
  assert.deepEqual((await fs.readdir(dir)).sort(),['synthetic.zip','thumbnail.png']);
});

test('thumbnail decoder error rejects, closes and releases URL without writing output', async () => {
  let closed=false,written=false,revoked=false;
  const context=vm.createContext({module:{exports:{}},Buffer,Blob,setTimeout,clearTimeout,
    require:name=>name==='./lib/archive.cjs'?{openArchive:async()=>({readPage:async()=>({bytes:PNG,mime:'image/png',width:1,height:1}),close:()=>{closed=true;}})}:{writeFile:async()=>{written=true;}},
    URL:{createObjectURL:()=> 'blob:error',revokeObjectURL:()=>{revoked=true;}},
    Image:class {set src(_){queueMicrotask(()=>this.onerror?.());} removeAttribute(){} }
  });
  vm.runInContext(syncFs.readFileSync(require.resolve('../thumbnail.cjs'),'utf8'),context);
  await assert.rejects(context.module.exports({src:'synthetic',dest:'unused',item:{}}),/先頭画像/);
  assert.equal(closed,true);assert.equal(revoked,true);assert.equal(written,false);
});

test('thumbnail uses decoded dimensions for EXIF-rotated JPEG aspect ratio', async () => {
  const canvas={getContext:()=>({drawImage:()=>{}}),toDataURL:()=>`data:image/png;base64,${PNG.toString('base64')}`};
  const context=vm.createContext({module:{exports:{}},Buffer,Blob,setTimeout,clearTimeout,
    require:name=>name==='./lib/archive.cjs'?{openArchive:async()=>({readPage:async()=>({bytes:PNG,mime:'image/jpeg',width:1200,height:800}),close:()=>{}})}:{writeFile:async()=>{}},
    document:{createElement:()=>canvas}, URL:{createObjectURL:()=> 'blob:rotated',revokeObjectURL:()=>{}},
    Image:class {naturalWidth=800;naturalHeight=1200;set src(_){queueMicrotask(()=>this.onload?.());} removeAttribute(){} }
  });
  vm.runInContext(syncFs.readFileSync(require.resolve('../thumbnail.cjs'),'utf8'),context);
  const item={}; await context.module.exports({src:'synthetic',dest:'unused',item});
  assert.equal(canvas.width,267);assert.equal(canvas.height,400);
  assert.equal(item.width,800);assert.equal(item.height,1200);
});

test('video-only ZIP cover uses a poster or a recognizable fallback and releases temporary media', async () => {
  for (const mode of ['poster', 'codec-unavailable', 'dependency-unavailable']) {
    const hasPoster = mode === 'poster', available = mode !== 'dependency-unavailable';
    let released=0,written=0,closed=0,prepared=0;
    const ctx={drawImage(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){}};
    const canvas={getContext:()=>ctx,toDataURL:()=>`data:image/png;base64,${PNG.toString('base64')}`};
    const dependency={ffmpeg:{isInstalled:true,paths:{}}};
    const context=vm.createContext({module:{exports:{}},Buffer,Blob,setTimeout,clearTimeout,
      require:name=>{
        if(name==='./lib/archive.cjs')return {openArchive:async()=>({pages:[{kind:'video'}],close:()=>{closed++;}})};
        if(name==='./lib/video.cjs')return {
          ffmpegPaths:async options=>{assert.equal(options.extraModule,dependency);if(!available)throw new Error('Dependency unavailable');return {};},
          prepareVideo:async(_,index,options)=>{prepared++;assert.equal(index,0);assert.equal(options.extraModule,dependency);return {poster:hasPoster?{bytes:PNG,mime:'image/png',width:640,height:480}:null,release:async()=>{released++;}};}
        };
        return {writeFile:async()=>{written++;}};
      },document:{createElement:()=>canvas},URL:{createObjectURL:()=> 'blob:video',revokeObjectURL(){}},
      Image:class{set src(_){queueMicrotask(()=>this.onload?.());}removeAttribute(){}}
    });
    vm.runInContext(syncFs.readFileSync(require.resolve('../thumbnail.cjs'),'utf8'),context);
    const item={};await context.module.exports({src:'synthetic',dest:'poster',item,extraModule:dependency});
    assert.equal(prepared,Number(available));assert.equal(written,1);assert.equal(closed,1);assert.equal(released,Number(available));
    assert.equal(canvas.width,400);assert.equal(canvas.height,hasPoster?300:225);
  }
});
