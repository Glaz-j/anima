import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { ExamReactionObserver } from '../adapters/minecraft/benchmark/reaction-observer.ts';

function setup() {
  let now = 1000, action: any;
  const events: any[] = [];
  const bot: any = { health: 20, entity: { id: 1, position: new Vec3(0, 64, 0), eyeHeight: 1.62, isInWater: true },
    entities: {}, blockAt: () => ({ name: 'water' }), world: { raycast: () => null } };
  const observer = new ExamReactionObserver(bot, () => action, e => events.push(e), () => now);
  return { bot, observer, events, action(value: any) { action = value; }, time(value: number) { now = value; },
    input(channel: string, value: any = true) { observer.input({ type: 'input', at: now, channel, value }); } };
}

test('danger is observed even with no intent or authorized reaction; manual surface input counts', () => {
  const f = setup(); f.observer.update();
  assert.equal(f.events[0].type, 'hazard-observed');
  f.time(1200); f.input('aim', 'changed'); assert.equal(f.events.length, 1);
  f.action({ type: 'surface' }); f.time(2100); f.observer.update(); f.input('key:forward');
  assert.equal(f.events[1].type, 'reaction'); assert.equal(f.events[1].at - f.events[0].at, 1100);
  f.input('key:jump'); assert.equal(f.events.length, 2);
});

test('manual combat and reflex combat share response semantics, unrelated digging cannot answer danger', () => {
  const f = setup(); f.bot.entity.isInWater = false;
  f.bot.entities[2] = { id: 2, name: 'zombie', health: 20, position: new Vec3(2, 64, 0), height: 1.8, width: .6 };
  f.observer.update(); assert.equal(f.events.length, 1);
  f.action({ type: 'gather' }); f.input('aim', 'changed'); f.input('dig-start', 'start');
  assert.equal(f.events.length, 1);
  f.time(1600); f.action({ type: 'combat', entityId: 2 }); f.input('use_entity', 'use_entity');
  assert.equal(f.events[1].type, 'reaction'); assert.equal(f.events[1].at, 1600);
});

test('unanswered hazards remain unanswered and brief visibility flicker does not inflate their count', () => {
  const f = setup(); f.observer.update();
  f.bot.entity.isInWater = false; f.time(1400); f.observer.update();
  f.bot.entity.isInWater = true; f.time(1800); f.observer.update(); assert.equal(f.events.length, 1);
  f.bot.entity.isInWater = false; f.time(2900); f.observer.update();
  f.action({ type: 'surface' }); f.input('key:jump'); assert.equal(f.events.length, 1);
  f.bot.entity.isInWater = true; f.time(3000); f.observer.update();
  assert.equal(f.events.length, 2); assert.notEqual(f.events[0].hazardId, f.events[1].hazardId);
  f.observer.stop(); f.input('key:jump'); assert.equal(f.events.length, 2);
});

test('a real input preceding the periodic sample is not lost and never has negative reaction latency', () => {
  const f = setup(); f.action({ type: 'surface' }); f.input('key:jump');
  assert.deepEqual(f.events.map(e => e.type), ['hazard-observed', 'reaction']);
  assert.equal(f.events[1].at - f.events[0].at, 0);
  f.time(1050); f.observer.update(); assert.equal(f.events.length, 2);
});
