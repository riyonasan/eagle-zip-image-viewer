'use strict';
// Explicit opt-in only: provide an existing, trusted Eagle FFmpeg dependency
// directory. The runtime never reads this test-only environment variable.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { openArchive } = require('../lib/archive.cjs');
const { prepareVideo } = require('../lib/video.cjs');
const { zip } = require('./fixture.cjs');

async function main() {
  const provided = process.env.EAGLE_TEST_FFMPEG_DIR;
  assert.ok(provided && path.isAbsolute(provided), 'Set EAGLE_TEST_FFMPEG_DIR to an existing trusted FFmpeg dependency directory');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaries = { ffmpeg:path.join(provided,`ffmpeg${suffix}`),ffprobe:path.join(provided,`ffprobe${suffix}`) };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'zip-video-integration-'));
  const extraModule = {ffmpeg:{isInstalled:true,paths:binaries}};
  const execute=(args,options={})=>execFileSync(binaries.ffmpeg,args,{windowsHide:true,timeout:20000,maxBuffer:2*1024**2,...options});
  try {
    for (const [ext,duration,codec] of [['mp4',2,'libx264'],['avi',2,'mpeg4'],['mp4',0.4,'libx264']]) {
      const file=path.join(dir,`synthetic-${duration}.${ext}`);
      execute(['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i',`color=c=red:s=64x48:r=10:d=${duration}`,'-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,1)'",'-c:v',codec,'-threads','1','-pix_fmt','yuv420p',file]);
      const originalName=`テスト動画 1秒.${ext}`;
      const source=path.join(dir,'synthetic.zip');await fs.writeFile(source,zip([{name:`folder/${originalName}`,data:await fs.readFile(file)}]));
      const archive=await openArchive(source);let video;
      try {
        video=await prepareVideo(archive,0,{root:path.join(dir,'cache'),extraModule});
        await video.posterReady;
        assert.equal(path.basename(video.file),originalName);
        assert.ok(video.poster,video.posterError);assert.equal(video.poster.at,duration>1?1:0);
        const pixel=execute(['-hide_banner','-loglevel','error','-f','image2pipe','-i','pipe:0','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:video.poster.bytes});
        assert.equal(pixel.length,3);
        assert.ok(duration>1?pixel[2]>180&&pixel[0]<60:pixel[0]>180&&pixel[2]<60,`wrong frame color: ${pixel}`);
        assert.equal((await fs.stat(video.file)).size,(await fs.stat(file)).size);
        console.log(`${ext} ${duration}s: frame ${video.poster.at}s and decoded color passed`);
      } finally {archive.close();if(video)await video.release();}
    }
    assert.deepEqual(await fs.readdir(path.join(dir,'cache')),[]);
    console.log('Real FFmpeg integration passed; no player opened or Eagle library changed.');
  } finally {
    assert.equal(path.dirname(dir),os.tmpdir());
    await fs.rm(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
