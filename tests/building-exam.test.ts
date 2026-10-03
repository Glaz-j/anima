import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_EXAMS,buildingExamTask } from '../adapters/minecraft/benchmark/building-exam.ts';
import { compileBuild } from '../adapters/minecraft/src/build-blueprints.ts';

test('building suite has six distinct structures in two material/orientation conditions and exact finite supply',()=>{
  assert.equal(BUILDING_EXAMS.length,14);assert.equal(new Set(BUILDING_EXAMS.map(t=>t.id)).size,14);
  assert.equal(new Set(BUILDING_EXAMS.map(t=>t.blueprint)).size,6);
  for(const spec of BUILDING_EXAMS){
    const task=buildingExamTask(spec.id),plan=compileBuild(spec.blueprint,{palette:spec.palette,rotation:spec.rotation});
    const supplied:Record<string,number>={};for(const stack of task.inventory){
      assert.ok(stack.count>0&&stack.count<=64);supplied[stack.item]=(supplied[stack.item]??0)+stack.count;
    }
    assert.deepEqual(supplied,plan.materials);assert.equal(task.stage,2);
    assert.ok(task.required.includes('server-blocks'));assert.match(task.instruction,/不能.*宣称完成/);
    assert.equal(task.enemies.length,0);assert.ok(task.timeoutMs<=900000);
  }
});

test('river variants remove deck support over nine cells and retain remote banks in both orientations',()=>{
  for(const id of ['build-river-bridge-oak-01','build-river-bridge-spruce-rotated-01']){
    const task=buildingExamTask(id),water=task.terrain.find(t=>t.block==='water');assert.ok(water);
    assert.equal(Math.min(water.to.x-water.from.x+1,water.to.z-water.from.z+1),9);
    assert.equal(Math.max(water.to.x-water.from.x+1,water.to.z-water.from.z+1),11);
    assert.equal(water.from.y,63);assert.equal(water.to.y,63);
    assert.ok(task.terrain.some(t=>t.block==='bedrock'&&t.from.y===62));
    assert.equal(task.terrain.filter(t=>t.block==='bedrock'&&t.from.y===64).length,2,'Real bank attachment exists at deck height.');
  }
});
