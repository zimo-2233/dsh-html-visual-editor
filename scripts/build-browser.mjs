// Bundle the engine for the browser acceptance harness in test/browser/.
// The shipped client bundle (lib/client.js) is built by scripts/build.mjs.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url);
const bin = process.platform === 'win32'
  ? new URL('node_modules/@esbuild/win32-x64/esbuild.exe', root)
  : new URL('node_modules/esbuild/bin/esbuild', root);
const result = spawnSync(fileURLToPath(bin), [
  fileURLToPath(new URL('src/engine.js', root)),
  '--bundle', '--format=iife', '--global-name=HVE', '--target=es2022',
  '--outfile=' + fileURLToPath(new URL('test/browser/engine.browser.js', root)),
], {stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log('Built test/browser/engine.browser.js');
