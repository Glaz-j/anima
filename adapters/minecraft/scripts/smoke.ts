import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const session = JSON.parse(await readFile(resolve('var/minecraft/api-session.json'), 'utf8'));
async function call(path: string, input?: any) {
  const response = await fetch(session.baseUrl + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(110000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
let ready = false;
for (let i=0; i<60; i++) { const { bots }=await call('bots'); if(bots.filter((b:any)=>b.ready).length>=2){ready=true;break;} await delay(1000); }
assert.ok(ready, 'Two bots must join the actual server');
const initial = await call('bots/LinChe/observe');
const target = { x: initial.position.x + 3, y: initial.position.y, z: initial.position.z };
const movement = await call('bots/LinChe/actions', {type:'goto',...target});
assert.equal(movement.status,'completed');
assert.ok(Math.hypot(movement.after.x-initial.position.x,movement.after.z-initial.position.z)>1, 'Actual position must change');
const other = await call('bots/XiaoYu/observe');
const approach=await call('bots/XiaoYu/actions',{type:'goto',x:movement.after.x,y:movement.after.y,z:movement.after.z+2});
assert.equal(approach.status,'completed');
const message='你好小雨，我们已经真实进入 Minecraft 世界。';
assert.equal((await call('bots/LinChe/actions',{type:'say',message})).status,'completed');
await delay(800);
const heard=await call('bots/XiaoYu/observe');
assert.ok(heard.recentEvents.some((e:any)=>e.type==='heard'&&e.speaker==='LinChe'&&e.message===message),'Nearby bot must hear chat');
const placeTarget={x:Math.floor(movement.after.x)+2,y:Math.floor(movement.after.y),z:Math.floor(movement.after.z)};
const placed=await call('bots/LinChe/actions',{type:'place',...placeTarget,item:'cobblestone'});
assert.equal(placed.status,'completed','Place a real block');
const dug=await call('bots/LinChe/actions',{type:'dig',...placeTarget});
assert.equal(dug.status,'completed','Remove the real block');
const evidence:any={time:new Date().toISOString(),initial,movement,approach,chat:{message,heard:true},placed,dug};
if(process.argv.includes('--live')){
  const before=await call('bots/LinChe/observe');
  const task=await call('bots/LinChe/tasks',{instruction:`这是一次真实控制验证。先调用 say 向小雨简短打招呼，然后调用 goto 走到 x=${(before.position.x+3).toFixed(1)}, y=${before.position.y.toFixed(1)}, z=${before.position.z.toFixed(1)}。只需要这两个行动，不要等待或做其他事。`});
  assert.equal(task.status,'completed');
  assert.ok(task.actions.some((a:any)=>a.action.type==='say'&&a.status==='completed'),'Real model must call say');
  assert.ok(task.actions.some((a:any)=>a.action.type==='goto'&&a.status==='completed'),'Real model must call goto');
  evidence.llm=task;
}
await writeFile(resolve('var/minecraft/smoke-result.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({passed:true,actualMovement:movement.after,llmTested:Boolean(evidence.llm),evidence:'var/minecraft/smoke-result.json'},null,2));
