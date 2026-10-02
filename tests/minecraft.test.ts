import test from 'node:test';
import assert from 'node:assert/strict';
import { action, botName, allowedOrigin } from '../adapters/minecraft/src/validation.ts';

test('commands and multiline chat cannot become Minecraft operator commands',()=>{
  for(const message of ['/op LinChe',' /stop','hi\n/op LinChe','§ahello']) assert.throws(()=>action({type:'say',message}));
  assert.deepEqual(action({type:'say',message:'你好！'}),{type:'say',message:'你好！'});
});
test('invalid coordinates and unbounded waits are rejected before game execution',()=>{
  for(const x of [NaN,Infinity,'3',30_000_001]) assert.throws(()=>action({type:'goto',x,y:0,z:0}));
  assert.throws(()=>action({type:'wait',ms:100000}));
  assert.throws(()=>action({type:'shell',command:'anything'}));
  assert.throws(()=>botName('../outside'));
});
test('cross-origin pages cannot control the loopback API',()=>{
  assert.equal(allowedOrigin('https://example.com',18791),false);
  assert.equal(allowedOrigin('null',18791),false);
  assert.equal(allowedOrigin('http://127.0.0.1:18791',18791),true);
  assert.equal(allowedOrigin(undefined,18791),true);
});
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { patchViewerBundle } from '../adapters/minecraft/src/viewer-assets.ts';

test('viewer schedules and indexes Minecraft sections below zero', async () => {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('prismarine-viewer/package.json'));
  const index = patchViewerBundle('index.js', await readFile(join(directory, 'public/index.js'), 'utf8'));
  const worker = patchViewerBundle('worker.js', await readFile(join(directory, 'public/worker.js'), 'utf8'));
  assert.equal((index.match(/=-64;/gu) || []).length, 2);
  assert.equal((worker.match(/\.minY\|\|0/gu) || []).length, 2);
  assert.throws(() => patchViewerBundle('index.js', 'changed upstream bundle'));
});
