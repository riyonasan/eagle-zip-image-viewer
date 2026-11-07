'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ZipFile } = require('yazl');
const { pipeline } = require('node:stream/promises');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const target = path.join(root, 'dist', `eagle-zip-image-viewer-${version}`);
// Never silently replace an earlier package or mix stale files into it.
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.mkdirSync(target, { recursive: false });
for (const name of ['manifest.json', 'index.html', 'viewer.js', 'viewer.css', 'thumbnail.cjs', 'logo.png', 'lib', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
}
for (const [name, metadata] of Object.entries(require('../package-lock.json').packages)) {
  if (name.startsWith('node_modules/') && !metadata.dev) fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true });
}
const zip = new ZipFile();
function append(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name, full = path.join(dir, entry.name);
    if (entry.isDirectory()) append(full, relative + '/');
    else if (entry.isFile()) zip.addFile(full, relative);
    else throw new Error('Unexpected link in package');
  }
}
append(target);
const output = `${target}.zip`;
const completion = pipeline(zip.outputStream, fs.createWriteStream(output, { flags: 'wx' }));
zip.end();
completion.then(() => console.log(output)).catch(error => { console.error(error); process.exitCode = 1; });
