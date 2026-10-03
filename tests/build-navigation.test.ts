import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { planBuildRoute } from '../adapters/minecraft/src/build-navigation.ts';

function fixture() {
  const obstacles = new Set<string>();
  const key = (p: Vec3) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const bot = {entity:{position:new Vec3(3.5,65,3.5)}, blockAt:(p:Vec3)=> {
    const solid = p.y<65 || obstacles.has(key(p));
    return {name:solid?'cobblestone':'air',boundingBox:solid?'block':'empty'};
  }};
  // A two-block high enclosure with one two-block high doorway.
  for(let y=65;y<=66;y++)for(let i=0;i<7;i++)for(const [x,z] of [[0,i],[6,i],[i,0],[i,6]])
    if(!(z===0&&x===3))obstacles.add(`${x},${y},${z}`);
  return {bot,obstacles};
}

test('construction routes out of a two-block wall through its doorway rather than jumping into it',()=>{
  const f=fixture(), target=new Vec3(6.5,65,-1.5);
  const result=planBuildRoute(f.bot,[target],{x:0,y:64,z:0});
  assert.ok(result);assert.ok(result.route.some(p=>p.x===3.5&&p.z===.5));
  assert.ok(result.destination.equals(target));
  for(const p of result.route)assert.equal(f.bot.blockAt(p).name,'air');
});

test('sealed construction enclosure has no route; search cannot break walls or invent unknown terrain',()=>{
  const f=fixture();f.obstacles.add('3,65,0');f.obstacles.add('3,66,0');
  assert.equal(planBuildRoute(f.bot,[new Vec3(6.5,65,-1.5)],{x:0,y:64,z:0}),null);
  const original=f.bot.blockAt;f.bot.blockAt=p=>p.z<0?null as any:original(p);
  assert.equal(planBuildRoute(f.bot,[new Vec3(6.5,65,-1.5)],{x:0,y:64,z:0}),null);
});
