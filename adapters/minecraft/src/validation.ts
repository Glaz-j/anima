import { BROADCAST_MAX_LENGTH, hasBroadcastTag, ordinaryChatText } from './communication.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function text(value: unknown, name: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, `${name} 必须是 1–${max} 字符的字符串。`);
  return value.trim();
}

export function botName(value: unknown): string {
  const name = text(value, 'name', 16);
  if (!/^[A-Za-z0-9_]{1,16}$/u.test(name)) throw new ApiError(400, '角色名只支持英文字母、数字、下划线，最多16字符。');
  return name;
}

export function coordinates(value: any) {
  const { x, y, z } = value ?? {};
  if (![x, y, z].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 30_000_000)) {
    throw new ApiError(400, 'x、y、z 必须是有限数值。');
  }
  return { x, y, z };
}

export function action(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '行动必须是对象。');
  const type = value.type;
  if (type === 'travel') {
    if (value.y !== undefined || value.position !== undefined || value.entityId !== undefined) throw new ApiError(400, 'travel 只接收水平目标 x/z，落脚高度由身体判断。');
    const { x, z } = coordinates({ x: value.x, y: 0, z: value.z });
    return { type, x, z };
  }
  if (type === 'approach') {
    if ((value.position !== undefined) === (value.entityId !== undefined) || ['x', 'y', 'z'].some(key => value[key] !== undefined)) {
      throw new ApiError(400, 'approach 请选择方块 position 或实体 entityId，不能混用脚部坐标。');
    }
    if (value.entityId !== undefined) return { type, entityId: entityIdentifier(value.entityId) };
    const position = coordinates(value.position);
    if (![position.x, position.y, position.z].every(Number.isInteger)) throw new ApiError(400, 'approach.position 必须是方块的整数格坐标。');
    return { type, position };
  }
  if (['goto', 'look', 'dig', 'place'].includes(type)) {
    const position = coordinates(value);
    if (type === 'place') return { type, ...position, item: text(value.item, 'item', 80) };
    return { type, ...position };
  }
  if (type === 'say' || type === 'broadcast') {
    const max = type === 'broadcast' ? BROADCAST_MAX_LENGTH : 250;
    const message = text(value.message, 'message', max);
    if (!ordinaryChatText(message, max)) throw new ApiError(400, '交谈只能是普通单行文本。');
    if (hasBroadcastTag(message)) throw new ApiError(400, '[世界] 是保留频道前缀；请通过 broadcast 动作发送正文。');
    return { type, message };
  }
  if (type === 'wait') {
    const ms = value.ms ?? 1000;
    if (!Number.isInteger(ms) || ms < 0 || ms > 5000) throw new ApiError(400, '等待时间应在 0–5000 毫秒之间。');
    return { type, ms };
  }
  if (type === 'stop') return { type };
  if (type === 'posture') {
    if (value.mode === 'none' && value.durationMs === undefined) return { type, mode: 'none' as const };
    if (value.mode !== 'tread_water') throw new ApiError(400, 'posture.mode 必须是 tread_water 或 none；none不接收时长。');
    return { type, mode: 'tread_water' as const, durationMs: boundedInteger(value.durationMs ?? 60000, 'durationMs', 1, 120000) };
  }
  if (type === 'equip') {
    const destination = value.destination ?? 'hand';
    if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(destination)) throw new ApiError(400, '无效装备位置。');
    return { type, item: text(value.item, 'item', 80), destination };
  }
  if (type === 'consume') return { type };
  if (type === 'fish') {
    const position = coordinates(value.position);
    if (![position.x, position.y, position.z].every(Number.isInteger)) throw new ApiError(400, 'fish.position 必须是瞄准水方块的整数坐标。');
    return { type, position, durationMs: boundedInteger(value.durationMs ?? 30000, 'durationMs', 1, 45000) };
  }
  if (type === 'use_item') {
    const hand = value.hand ?? 'main';
    if (!['main', 'off'].includes(hand)) throw new ApiError(400, 'use_item.hand 必须是 main 或 off。');
    if (value.position !== undefined && value.direction !== undefined) throw new ApiError(400, '绝对瞄准点 position 与相对方向 direction 只能选择一个。');
    const direction = value.direction === undefined ? undefined : coordinates(value.direction);
    if (direction && Math.hypot(direction.x, direction.y, direction.z) < .000001) throw new ApiError(400, '瞄准方向不能是零向量。');
    return { type, hand, durationMs: boundedInteger(value.durationMs ?? 0, 'durationMs', 0, 5000),
      ...(value.item === undefined ? {} : { item: text(value.item, 'item', 80) }),
      ...(value.position === undefined ? {} : { position: coordinates(value.position) }),
      ...(direction === undefined ? {} : { direction }) };
  }
  if (type === 'attack' || type === 'shoot') {
    const entityId = entityIdentifier(value.entityId);
    if (type === 'shoot') return { type, entityId };
    const durationMs = boundedInteger(value.durationMs ?? 1000, 'durationMs', 1, 10000);
    if (value.follow !== undefined && typeof value.follow !== 'boolean') throw new ApiError(400, 'attack.follow 必须是布尔值。');
    return { type, entityId, durationMs, ...(value.follow === undefined ? {} : { follow: value.follow }) };
  }
  if (type === 'move') {
    const controls = value.controls;
    if (!Array.isArray(controls) || controls.length === 0 || controls.length > 7 ||
      controls.some(c => !['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(c))) throw new ApiError(400, 'controls 必须是有效移动控制数组。');
    for (const [a, b] of [['forward', 'back'], ['left', 'right']]) {
      if (controls.includes(a) && controls.includes(b)) throw new ApiError(400, '移动方向不能互相冲突。');
    }
    return { type, controls: [...new Set(controls)], ms: boundedInteger(value.ms ?? 1000, 'ms', 1, 5000) };
  }
  if (type === 'interact') {
    if (value.entityId !== undefined) {
      if (['x', 'y', 'z', 'direction'].some(key => value[key] !== undefined)) throw new ApiError(400, '交互目标只能选择实体或带方向的方块坐标之一。');
      return { type, entityId: entityIdentifier(value.entityId) };
    }
    const direction = value.direction === undefined ? undefined : coordinates(value.direction);
    if (direction && (![direction.x, direction.y, direction.z].every(v => [-1, 0, 1].includes(v)) ||
      Math.abs(direction.x) + Math.abs(direction.y) + Math.abs(direction.z) !== 1)) throw new ApiError(400, '方块 direction 必须是六个单位面向量之一。');
    return { type, ...coordinates(value), ...(direction === undefined ? {} : { direction }) };
  }
  if (type === 'toss') return { type, item: text(value.item, 'item', 80), count: boundedInteger(value.count ?? 1, 'count', 1, 64) };
  if (type === 'scan') {
    const kind = value.kind ?? 'both';
    if (!['blocks', 'entities', 'both'].includes(kind)) throw new ApiError(400, 'scan.kind 必须是 blocks、entities 或 both。');
    return { type, kind, ...(value.name === undefined ? {} : { name: text(value.name, 'name', 80) }),
      maxDistance: boundedInteger(value.maxDistance ?? 24, 'maxDistance', 1, 64), count: boundedInteger(value.count ?? 12, 'count', 1, 16) };
  }
  if (type === 'recipes') return { type, item: text(value.item, 'item', 80) };
  if (type === 'craft') return { type, item: text(value.item, 'item', 80), count: boundedInteger(value.count ?? 1, 'count', 1, 64),
    ...(value.table === undefined ? {} : { table: coordinates(value.table) }) };
  if (type === 'gather') return { type, block: text(value.block, 'block', 80), count: boundedInteger(value.count ?? 1, 'count', 1, 16),
    maxDistance: boundedInteger(value.maxDistance ?? 16, 'maxDistance', 1, 32) };
  if (type === 'smelt') return { type, input: text(value.input, 'input', 80), fuel: text(value.fuel, 'fuel', 80),
    count: boundedInteger(value.count ?? 1, 'count', 1, 16), position: coordinates(value.position) };
  if (type === 'container') {
    const operation = value.operation;
    if (!['list', 'deposit', 'withdraw'].includes(operation)) throw new ApiError(400, 'container.operation 必须是 list、deposit 或 withdraw。');
    return { type, position: coordinates(value.position), operation,
      ...(operation === 'list' ? {} : { item: text(value.item, 'item', 80), count: boundedInteger(value.count ?? 1, 'count', 1, 64) }) };
  }
  if (type === 'sleep') return { type, position: coordinates(value.position) };
  throw new ApiError(400, '不支持这个 Minecraft 行动。');
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new ApiError(400, `${name} 必须是 ${minimum}–${maximum} 之间的整数。`);
  return Number(value);
}

function entityIdentifier(value: unknown) { return boundedInteger(value, 'entityId', 0, 2147483647); }

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
