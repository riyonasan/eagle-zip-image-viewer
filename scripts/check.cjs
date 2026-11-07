'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const manifest = require('../manifest.json');
const root = require('node:path').resolve(__dirname, '..');
for (const dir of ['lib', 'scripts', 'tests', '.']) {
  for (const file of fs.readdirSync(`${root}/${dir}`)) {
    if (/\.(c?js)$/.test(file)) execFileSync(process.execPath, ['--check', `${root}/${dir}/${file}`], { stdio: 'inherit' });
  }
}
assert.deepEqual(Object.keys(manifest.preview), ['zip,cbz']);
assert.equal(manifest.version, require('../package.json').version);
assert.equal(require('../package.json').license, 'MIT');
assert.ok(fs.readFileSync(`${root}/LICENSE`, 'utf8').startsWith('MIT License'));
assert.ok(fs.existsSync(`${root}/THIRD_PARTY_NOTICES.md`));
assert.deepEqual(manifest.dependencies, ['ffmpeg']);
for (const handler of Object.values(manifest.preview)) {
  for (const kind of ['viewer', 'thumbnail']) assert.ok(fs.existsSync(`${root}/${handler[kind].path}`));
}
assert.ok(fs.existsSync(`${root}${manifest.logo}`));
assert.match(fs.readFileSync(`${root}/index.html`, 'utf8'), /connect-src 'none'/);
console.log('Syntax, manifest paths, logo and offline CSP: passed');
