import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Vec3} from 'vec3';
import registryFactory from 'prismarine-registry';
import blockFactory from 'prismarine-block';
import {compileBuild} from '../adapters/minecraft/src/build-blueprints.ts';
import {runBuildSkill,validateBuild} from '../adapters/minecraft/src/build-skill.ts';

function fixture(){
  const registry=registryFactory('1.21.4'),Block=blockFactory(registry),action={type:'build' as const,blueprint:'railed-bridge' as const,origin:{x:0,y:64,z:0}};
  const plan=compileBuild(action.blueprint,action),cells=new Map(plan.blocks.map(c=>[`${c.x},${c.y},${c.z}`,c.item]));
  const key=(p:Vec3)=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const stack={name:'cobblestone',type:registry.itemsByName.cobblestone.id,count:1};
  const controls:Record<string,boolean>={},bot:any=new EventEmitter();
  Object.assign(bot,{version:'1.21.4',registry,supportFeature:registry.supportFeature,game:{gameMode:'survival'},health:20,food:20,
    entity:{id:1,name:'player',position:new Vec3(1.5,65,.5),velocity:new Vec3(0,0,0),height:1.8,width:.6,eyeHeight:1.62,onGround:true},entities:{},
    _client:Object.assign(new EventEmitter(),{state:'play'}),_syncWindow:async()=>{},inventory:Object.assign(new EventEmitter(),{slots:[],items:()=>stack.count?[stack]:[]}),
    setControlState:(k:string,v:boolean)=>{controls[k]=v;},getControlState:(k:string)=>controls[k]??false,clearControlStates:()=>{for(const k of Object.keys(controls))controls[k]=false;},stopDigging:()=>{},deactivateItem:()=>{},lookAt:async()=>{},equip:async(i:any)=>{bot.heldItem=i;}});
  bot._client.write=(name:string)=>{if(name==='client_command')queueMicrotask(()=>bot._client.emit('statistics',{entries:[]}));};
  bot.blockAt=(p:Vec3)=>{const position=p.floored();const name=cells.get(key(p))??(position.y<64?'bedrock':'air');const b=Block.fromStateId(registry.blocksByName[name].defaultState,0);b.position=position;return b;};
  bot.world={raycast:(eye:Vec3,direction:Vec3,distance:number)=>{for(let n=.01;n<distance-.02;n+=.01){const b=bot.blockAt(eye.plus(direction.scaled(n)));if(b.boundingBox==='block')return b;}return null;}};
  let placements=0;
  bot._placeBlockWithOptions=async(reference:any,face:Vec3)=>{placements++;cells.set(key(reference.position.plus(face)),stack.name);stack.count--;};
  return {bot,action,cells,stack,controls,placements:()=>placements};
}
test('construction skips a completed building without spending another item',async()=>{
  const f=fixture();const result=await runBuildSkill(f.bot,f.action,new AbortController().signal);
  assert.equal(result.reached,true);assert.equal(result.matched,49);assert.equal(result.placed,0);assert.equal(f.stack.count,1);assert.equal(f.placements(),0);
});
test('construction repairs a missing cell through native survival placement and confirms material drain',async()=>{
  const f=fixture();f.cells.delete('2,65,0');
  const result=await runBuildSkill(f.bot,f.action,new AbortController().signal);
  assert.equal(result.reached,true);assert.equal(result.placed,1);assert.equal(f.placements(),1);assert.equal(f.stack.count,0);assert.equal(f.cells.get('2,65,0'),'cobblestone');
  const again=await runBuildSkill(f.bot,f.action,new AbortController().signal);assert.equal(again.placed,0);assert.equal(again.reached,true);
  assert.equal(f.bot.listenerCount('death'),0);assert.equal(f.bot.listenerCount('end'),0);
});
for(const [label,setup,code] of [
  ['conflicting existing block',(f:any)=>f.cells.set('2,65,0','diamond_block'),'build_conflict'],
  ['missing material',(f:any)=>{f.cells.delete('2,65,0');f.stack.count=0;},'build_missing_material'],
  ['blocked pedestrian passage',(f:any)=>f.cells.set('1,65,0','dirt'),'build_passage_blocked'],
  ['creative mode',(f:any)=>f.bot.game.gameMode='creative','not_survival'],
] as const)test(`construction refuses ${label} without modifying terrain`,async()=>{
  const f=fixture();setup(f);await assert.rejects(runBuildSkill(f.bot,f.action,new AbortController().signal),(e:any)=>e.details.stoppedReason===code);
  assert.equal(f.placements(),0);assert.equal(f.bot.listenerCount('death'),0);
});
test('unloaded construction cells and revoked grants cannot start native placement',async()=>{
  const f=fixture();const original=f.bot.blockAt;f.bot.blockAt=(p:Vec3)=>p.x===2&&p.y===65&&p.z===0?null:original(p);
  await assert.rejects(runBuildSkill(f.bot,f.action,new AbortController().signal),(e:any)=>e.details.stoppedReason==='build_unknown_cell');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(runBuildSkill(f.bot,f.action,cancelled.signal));assert.equal(f.placements(),0);
});
test('a blocked passage never reports reached even when every structural block exists',async()=>{
  const f=fixture();f.cells.set('1,65,0','dirt');
  await assert.rejects(runBuildSkill(f.bot,f.action,new AbortController().signal),(e:any)=>{
    assert.equal(e.details.stoppedReason,'build_passage_blocked');
    assert.equal(e.details.matched,49);assert.equal(e.details.placed,0);
    assert.equal(e.details.reached,false,'Complete structure alone does not prove a usable passage.');return true;
  });
  assert.equal(f.placements(),0);assert.equal(f.stack.count,1);
});
test('build validation rejects unsafe coordinates and oversized batches before execution',()=>{
  for(const raw of [{},{type:'build',blueprint:'unknown',origin:{x:0,y:64,z:0}},{type:'build',blueprint:'watchtower',origin:{x:0,y:Infinity,z:0}},
    {type:'build',blueprint:'watchtower',origin:{x:0,y:64,z:0},batchBlocks:13}])assert.throws(()=>validateBuild(raw));
});

test('a bounded slice leaves real remaining work; resuming spends only the unfinished cell',async()=>{
  const f=fixture();f.cells.delete('0,65,0');f.cells.delete('2,65,0');f.stack.count=2;
  const first=await runBuildSkill(f.bot,{...f.action,batchBlocks:1},new AbortController().signal);
  assert.equal(first.placed,1);assert.equal(first.reached,false);assert.equal(f.stack.count,1);
  const next=await runBuildSkill(f.bot,f.action,new AbortController().signal);
  assert.equal(next.placed,1);assert.equal(next.reached,true);assert.equal(f.stack.count,0);
});

test('revocation during equip drains the operation without sending placement or leaving controls active',async()=>{
  const f=fixture();f.cells.delete('2,65,0');const abort=new AbortController();
  let release!:()=>void, started!:()=>void;
  const equipped=new Promise<void>(resolve=>{started=resolve;});
  f.bot.equip=async()=>{started();await new Promise<void>(resolve=>{release=resolve;});f.bot.heldItem=f.stack;};
  const running=runBuildSkill(f.bot,f.action,abort.signal);await equipped;abort.abort();release();
  await assert.rejects(running);assert.equal(f.placements(),0);assert.equal(f.stack.count,1);
  assert.ok(Object.values(f.controls).every(v=>v===false));assert.equal(f.bot.listenerCount('death'),0);
});

test('revocation after confirmed placement preserves partial evidence and safely resumes',async()=>{
  const f=fixture();f.cells.delete('0,65,0');f.cells.delete('2,65,0');f.stack.count=2;
  const abort=new AbortController();
  await assert.rejects(runBuildSkill(f.bot,f.action,abort.signal,type=>{if(type==='build-progress')abort.abort();}),
    (e:any)=>e.details.placed===1);
  assert.equal(f.placements(),1);assert.equal(f.stack.count,1);
  const next=await runBuildSkill(f.bot,f.action,new AbortController().signal);
  assert.equal(next.reached,true);assert.equal(next.placed,1);assert.equal(f.placements(),2);
});

test('a local slice deadline yields confirmed partial work, while an external cancellation remains cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();f.cells.delete('0,65,0');f.cells.delete('2,65,0');f.stack.count=2;
  const grant=new AbortController();
  const first=await runBuildSkill(f.bot,f.action,grant.signal,type=>{if(type==='build-progress')t.mock.timers.tick(45000);});
  assert.equal(first.placed,1);assert.equal(first.matched,48);assert.equal(first.missingMaterials.cobblestone,1);
  assert.equal(first.reached,false);assert.equal(first.stoppedReason,'build_slice_time_limit');
  assert.equal(grant.signal.aborted,false);assert.equal(f.stack.count,1);
  const next=await runBuildSkill(f.bot,f.action,grant.signal);
  assert.equal(next.placed,1);assert.equal(next.reached,true);assert.equal(f.stack.count,0);
});
