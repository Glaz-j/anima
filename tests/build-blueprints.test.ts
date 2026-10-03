import test from 'node:test';
import assert from 'node:assert/strict';
import {compileBuild,BUILD_KINDS,BUILD_LIMITS} from '../adapters/minecraft/src/build-blueprints.ts';
for(const kind of BUILD_KINDS) for(const rotation of [0,90,180,270]) test(`${kind} rotated${rotation} has a finite material-accounted blueprint and usable passages`,()=>{
  const b=compileBuild(kind,{origin:{x:100,y:64,z:-50},rotation});
  assert.ok(b.blocks.length>40&&b.blocks.length<=BUILD_LIMITS.blocks);
  const keys=new Set(b.blocks.map(v=>`${v.x},${v.y},${v.z}`));assert.equal(keys.size,b.blocks.length);
  assert.equal(Object.values(b.materials).reduce((a,c)=>a+c,0),b.blocks.length);
  for(const cell of b.clear)assert.equal(keys.has(`${cell.x},${cell.y},${cell.z}`),false,'Required passage must not be filled.');
  for(const point of b.access){
    assert.equal(point.x%1===.5||point.x%1===-.5,true);assert.equal(point.z%1===.5||point.z%1===-.5,true);
    const x=Math.floor(point.x),z=Math.floor(point.z);
    assert.ok(keys.has(`${x},${point.y-1},${z}`),'Every advertised access point has a floor in the completed structure.');
    assert.equal(keys.has(`${x},${point.y},${z}`),false);assert.equal(keys.has(`${x},${point.y+1},${z}`),false);
  }
  for(const cell of b.blocks)for(const k of ['x','y','z'] as const)assert.ok(Number.isSafeInteger(cell[k])&&cell[k]>=b.bounds.min[k]&&cell[k]<=b.bounds.max[k]);
  const zero=compileBuild(kind);assert.equal(zero.blocks.length,b.blocks.length);
});
test('house has a two-block doorway, windows, indoor volume and a gabled roof',()=>{
  const b=compileBuild('village-house',{origin:{x:0,y:0,z:0}});
  assert.ok(b.clear.some(v=>v.x===3&&v.y===1&&v.z===0));assert.ok(b.clear.some(v=>v.x===3&&v.y===2&&v.z===0));
  assert.equal(b.blocks.filter(v=>v.item==='glass').length,3);
  const roof=b.blocks.filter(v=>v.phase==='roof');assert.ok(roof.some(v=>v.y===6));assert.ok(roof.some(v=>v.x===0&&v.y===3));
  assert.ok(b.clear.filter(v=>v.x>0&&v.x<6&&v.z>0&&v.z<6).length>=50);
});
test('bridge has a continuous nine-cell unobstructed centre and two protective edges',()=>{
  const b=compileBuild('railed-bridge',{origin:{x:0,y:0,z:0}});
  for(let z=0;z<9;z++){
    assert.ok(b.blocks.some(v=>v.x===1&&v.y===0&&v.z===z));
    assert.ok(b.clear.some(v=>v.x===1&&v.y===1&&v.z===z));
    for(const x of [0,2])assert.ok(b.blocks.some(v=>v.x===x&&v.y===1&&v.z===z));
  }
});
test('wall preserves an entrance instead of sealing its courtyard',()=>{
  const b=compileBuild('courtyard-wall',{origin:{x:0,y:0,z:0}});
  for(const x of [4,5])for(const y of [1,2])assert.ok(b.clear.some(v=>v.x===x&&v.y===y&&v.z===0));
});
test('palette variants preserve geometry, and invalid/unbounded plans reject',()=>{
  for(const kind of BUILD_KINDS){const oak=compileBuild(kind),spruce=compileBuild(kind,{palette:'spruce'});assert.deepEqual(oak.blocks.map(({item,...v})=>v),spruce.blocks.map(({item,...v})=>v));}
  for(const options of [{rotation:45},{origin:{x:NaN,y:64,z:0}},{origin:{x:0,y:319,z:0}},{origin:{}},{palette:'unknown'}])assert.throws(()=>compileBuild('village-house',options as any));
  assert.throws(()=>compileBuild('unknown' as any));
});
