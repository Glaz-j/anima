import { Vec3 } from 'vec3';
import { setTimeout as delay } from 'node:timers/promises';
import { droppedItemSummary } from './entity-observation.ts';
import { blockProperties } from './block-observation.ts';
import { craftWindowState, synchronizeCraftInventory } from './craft-sync.ts';
import { managedWindowOperation, releaseUnmanagedWindow } from './window-lifecycle.ts';

export const SURVIVAL_ACTIONS = new Set(['scan', 'recipes', 'craft', 'gather', 'smelt', 'container', 'sleep']);
const failure = (code: string, message: string, details: any = {}) => Object.assign(new Error(message),
  { details: { ...details, stoppedReason: code } });
export interface GatherState {
  origin: { x: number; y: number; z: number };
  attemptedTargets: string[];
  movementAttempts: number;
}
/** Internal continuation state from our own previous receipt, never a model tool argument. */
export function copyGatherState(value: unknown): GatherState | undefined {
  const state = value as GatherState | undefined;
  if (!state || !state.origin || !['x', 'y', 'z'].every(key => Number.isFinite((state.origin as any)[key])
      && Math.abs((state.origin as any)[key]) <= 30000000)
    || !Array.isArray(state.attemptedTargets) || state.attemptedTargets.length > 128
    || !state.attemptedTargets.every(target => typeof target === 'string' && target.length <= 80
      && /^\(-?\d+, -?\d+, -?\d+\)$/u.test(target))
    || !Number.isInteger(state.movementAttempts) || state.movementAttempts < 0 || state.movementAttempts > 3) return undefined;
  return { origin: { x: state.origin.x, y: state.origin.y, z: state.origin.z },
    attemptedTargets: [...new Set(state.attemptedTargets)], movementAttempts: state.movementAttempts };
}
export interface SurvivalControls {
  moveTo(bot: any, target: Vec3, signal: AbortSignal, radius?: number): Promise<void>;
  // The production body plans a route to interaction range of this observed
  // block. Its return value is not proof of reach or of resource collection.
  approachBlock(position: { x: number; y: number; z: number }, signal: AbortSignal): Promise<unknown>;
  entityVisible(bot: any, entity: any): boolean;
}

function check(signal: AbortSignal) { if (signal.aborted) throw new Error('生存行动已取消或超时。'); }
function nameOf(name: string) { return name.replace(/^minecraft:/u, ''); }
function vector(position: any) { return new Vec3(position.x, position.y, position.z); }
function compact(item: any) { return item ? { item: item.name, count: item.count } : null; }
// Prismarine Window.items() is the player-storage region of that window;
// containerItems() is the container region. There is no inventoryItems() API.
// While a menu is open bot.inventory is only refreshed when it is closed.
function ownItems(bot: any): any[] { return (bot.currentWindow ?? bot.inventory).items(); }
function counts(bot: any) {
  const result = new Map<string, number>();
  for (const item of ownItems(bot)) result.set(item.name, (result.get(item.name) || 0) + item.count);
  return result;
}
function delta(before: Map<string, number>, bot: any) {
  const after = counts(bot);
  return [...new Set([...before.keys(), ...after.keys()])].map(item => ({ item, change: (after.get(item) || 0) - (before.get(item) || 0) })).filter(entry => entry.change !== 0);
}
function item(bot: any, name: string, required = 1) {
  const exact = nameOf(name), found = ownItems(bot).find(i => i.name === exact);
  if (!found || (counts(bot).get(exact) || 0) < required) throw new Error(`背包没有足够的 ${exact}（需要 ${required}）。`);
  return found;
}
function knownItem(bot: any, name: string) {
  const found = bot.registry.itemsByName[nameOf(name)];
  if (!found) throw failure('invalid_item', `不存在这个物品 ID：${name}。请使用实际注册表中的物品名称。`);
  return found;
}
function blockAtReach(bot: any, position: any, expected?: string[]) {
  const block = bot.blockAt(vector(position).floored());
  if (!block || block.position.offset(.5, .5, .5).distanceTo(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)) > 4.5) throw new Error('目标方块不在已加载的 4.5 格交互范围内。');
  if (!bot.canSeeBlock(block)) throw new Error('目标方块被遮挡。');
  if (expected && !expected.includes(block.name)) throw new Error(`目标必须是 ${expected.join('/')}，实际是 ${block.name}。`);
  return block;
}
export function withinDigReach(bot: any, block: any) {
  // Survival reach starts at the eyes, not the feet. A centre-point limit is
  // conservative; Mineflayer's canDigBlock has its own looser 5.1m check.
  const eyes = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  return block && block.position.offset(.5, .5, .5).distanceTo(eyes) <= 4.5 && bot.canDigBlock(block) && bot.canSeeBlock(block);
}
function pickupLanding(bot: any, position: Vec3) {
  const height = Math.floor(bot.entity.position.y + .05);
  const dangerous = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow']);
  for (const dy of [0, 1, -1, -2, -3]) {
    const point = new Vec3(position.x, height + dy, position.z), cell = point.floored();
    const feet = bot.blockAt(cell), head = bot.blockAt(cell.offset(0, 1, 0)), floor = bot.blockAt(cell.offset(0, -1, 0));
    if (feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' && floor?.boundingBox === 'block' &&
      ![feet, head, floor].some(block => dangerous.has(block.name))) return point;
  }
  return null;
}
async function checked(signal: AbortSignal, promise: Promise<any>) {
  const value = await promise; check(signal); return value;
}
async function closeWindow(bot: any, window: any) {
  if (window && bot.currentWindow === window) {
    if (typeof window.close === 'function') await window.close(); else await bot.closeWindow(window);
  }
}
function recipeInfo(bot: any, recipe: any) {
  const inventory = counts(bot);
  const materials = recipe.delta.filter((entry: any) => entry.id >= 0 && entry.count < 0).map((entry: any) => ({
    item: bot.registry.items[entry.id]?.name || `unknown:${entry.id}`, count: -entry.count,
  }));
  return { result: { item: bot.registry.items[recipe.result.id]?.name, count: recipe.result.count }, requiresTable: Boolean(recipe.requiresTable), materials,
    hasMaterials: materials.every((entry: any) => (inventory.get(entry.item) || 0) >= entry.count) };
}

function craftPrerequisites(bot: any, output: any, table: any) {
  // This is static recipe data plus our already synchronized inventory. Return
  // a small useful sample with the failure so replanning needs no extra scan.
  try {
    const inventory = counts(bot);
    const options = bot.recipesAll(output.id, null, true).map((recipe: any) => {
      const info = recipeInfo(bot, recipe);
      return { result: info.result, requiresTable: info.requiresTable, tableAvailable: Boolean(table),
        materials: info.materials.slice(0, 9).map((entry: any) => ({ item: entry.item, required: entry.count,
          available: inventory.get(entry.item) || 0, missing: Math.max(0, entry.count - (inventory.get(entry.item) || 0)) })) };
    });
    const missing = (option: any) => option.materials.reduce((sum: number, material: any) => sum + material.missing, 0);
    options.sort((a: any, b: any) => missing(a) - missing(b));
    return { options: options.slice(0, 3), note: '仅列出最多三个配方的一批材料要求；不代表已经找到或靠近工作台，其他配方仍可能可用。' };
  } catch { return undefined; }
}

function scan(bot: any, proposal: any, controls: SurvivalControls) {
  const needle = proposal.name?.toLowerCase().replace(/^minecraft:/u, '') || '';
  const matches = (name: string) => name.toLowerCase().includes(needle);
  const origin = bot.entity.position.clone(), blocks: any[] = [], entities: any[] = [];
  const candidateLimit = needle ? 512 : 256;
  let visibleCandidateCount = 0;
  if (proposal.kind !== 'entities') {
    const positions = bot.findBlocks({ matching: (block: any) => !['air', 'cave_air', 'void_air'].includes(block.name) && matches(block.name),
      maxDistance: proposal.maxDistance, count: candidateLimit });
    const visible: any[] = [];
    for (const position of positions) {
      const block = bot.blockAt(position);
      if (!block || position.distanceTo(origin) > proposal.maxDistance || !bot.canSeeBlock(block)) continue;
      const properties = blockProperties(block);
      visible.push({ name: block.name, position: { ...block.position }, distance: Number(position.distanceTo(origin).toFixed(2)),
        ...(properties ? { properties } : {}) });
    }
    visible.sort((a, b) => a.distance - b.distance);
    visibleCandidateCount = visible.length;
    if (needle) blocks.push(...visible.slice(0, proposal.count));
    else {
      // First show the nearest observation of each block type so a meadow does
      // not hide every nearby log/rock/water example behind sixteen grass blocks.
      const types = new Set<string>();
      for (const block of visible) if (!types.has(block.name) && blocks.length < proposal.count) {
        types.add(block.name); blocks.push(block);
      }
      for (const block of visible) if (blocks.length < proposal.count && !blocks.includes(block)) blocks.push(block);
    }
  }
  if (proposal.kind !== 'blocks') {
    for (const entity of Object.values(bot.entities) as any[]) {
      if (entity.id === bot.entity.id || !entity.position || entity.position.distanceTo(origin) > proposal.maxDistance) continue;
      if (!controls.entityVisible(bot, entity)) continue;
      const isDrop = ['item', 'Item', 'item_stack'].includes(entity.name), droppedItem = droppedItemSummary(entity);
      if (!matches([entity.username, entity.name, entity.displayName, droppedItem?.name].filter(Boolean).join(' '))) continue;
      entities.push({ id: entity.id, name: entity.username || entity.name || entity.displayName, type: entity.name || entity.type,
        ...(isDrop ? { droppedItem } : {}),
        position: { ...entity.position }, distance: Number(entity.position.distanceTo(origin).toFixed(2)) });
    }
    entities.sort((a, b) => a.distance - b.distance);
  }
  return { kind: proposal.kind, name: proposal.name, maxDistance: proposal.maxDistance, origin: { ...origin }, dimension: bot.game.dimension,
    filter: { mode: 'case-insensitive-substring', query: needle, semanticCategories: false,
      note: 'name按名称子串匹配；animal、food等不会展开为类别，空结果仅针对本次字面查询。省略name可观察不同可见对象。' },
    blocks, entities: entities.slice(0, proposal.count), scope: 'visible-loaded-only',
    // Internal matches include occluded blocks. Neither their count nor an
    // exhausted-candidate bit may become a resource detector through walls.
    candidateLimit, visibleCandidateCount, searchIncomplete: true,
    outputTruncated: { blocks: visibleCandidateCount > blocks.length, entities: entities.length > proposal.count },
    note: '仅报告预算内已加载且可见的实际观察，未证明全半径覆盖；空结果不代表该资源不存在，遮挡、未加载或未检查的位置仍未知。无 name 时优先展示不同方块类型，返回数量有上限。' };
}

async function gather(bot: any, proposal: any, signal: AbortSignal, controls: SurvivalControls, details: any) {
  const blockName = nameOf(proposal.block), definition = bot.registry.blocksByName[blockName];
  if (!definition) throw failure('invalid_block', `不存在这个方块 ID：${blockName}。`);
  const previous = copyGatherState(proposal.gatherState);
  if (proposal.gatherState !== undefined && !previous) throw failure('invalid_gather_state', '采集续接状态无效；需要重新授权，不能重置范围或重试预算。');
  const state: GatherState = previous ?? { origin: { ...bot.entity.position }, attemptedTargets: [], movementAttempts: 0 };
  const origin = vector(state.origin);
  details.gatherState = state;
  details.requestedBlocks = proposal.count; details.minedBlocks = 0; details.positions = [];
  details.rejectedCandidates = [];
  details.movementAttempts = state.movementAttempts;
  const reject = (position: Vec3, reason: string, standingPosition?: Vec3, movement?: any) => {
    details.rejectedCandidateCount = (details.rejectedCandidateCount || 0) + 1;
    if (details.rejectedCandidates.length < 12) details.rejectedCandidates.push({ position: { ...position }, reason,
      ...(standingPosition ? { standingPosition: { ...standingPosition } } : {}), ...(movement ? { movement } : {}) });
  };
  const attempted = new Set(state.attemptedTargets);
  for (let index = 0; index < proposal.count; index++) {
    check(signal);
    const positions: Vec3[] = bot.findBlocks({ matching: definition.id, point: origin, maxDistance: proposal.maxDistance, count: 64 });
    const supportingCell = bot.entity.position.floored().offset(0, -1, 0);
    const eligible = positions.filter(p => {
      const candidate = bot.blockAt(p);
      return candidate?.name === blockName && !p.equals(supportingCell) && !attempted.has(p.toString()) && p.distanceTo(origin) <= proposal.maxDistance && bot.canSeeBlock(candidate);
    }).sort((a, b) => Number(Boolean(withinDigReach(bot, bot.blockAt(b)))) - Number(Boolean(withinDigReach(bot, bot.blockAt(a)))) ||
      a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    details.searchIncomplete = true;
    if (!eligible.length) {
      throw failure(attempted.size ? 'candidates_exhausted' : 'no_visible_resource',
        `本次已加载候选中未找到可见且未尝试的 ${blockName}；已确认挖掉 ${details.minedBlocks}/${proposal.count} 块。未证明全半径覆盖，遮挡、未加载或未检查的位置仍未知。`);
    }
    let position: Vec3 | undefined;
    for (const candidatePosition of eligible.slice(0, 8)) {
      check(signal);
      if (attempted.size >= 128) throw failure('candidates_exhausted', '本任务已达到有限候选检查预算；其他位置或路线仍未知。');
      attempted.add(candidatePosition.toString());
      state.attemptedTargets = [...attempted];
      details.selectedTarget = { ...candidatePosition };
      const reachable = () => candidatePosition.equals(bot.entity.position.floored().offset(0, -1, 0)) ? false :
        bot.blockAt(candidatePosition)?.name === blockName && withinDigReach(bot, bot.blockAt(candidatePosition));
      if (reachable()) { position = candidatePosition; break; }
      if (state.movementAttempts >= 3) { reject(candidatePosition, '本次采集的接近尝试预算已用完。'); continue; }
      check(signal); state.movementAttempts++; details.movementAttempts = state.movementAttempts;
      // Let the body choose feet positions and the route. Adjacent cardinal
      // cells are not an exhaustive set of places from which a block is usable.
      // Production approach returns a bounded diagnostic summary, not its route
      // map. Keep only the latest attempt, including a cancelled partial route.
      delete details.approach;
      try { details.approach = await controls.approachBlock({ ...candidatePosition }, signal); }
      catch (error: any) {
        if (error.details?.approach) details.approach = error.details.approach;
        check(signal); reject(candidatePosition, error.message, undefined, error.details?.movement);
      }
      finally { bot.clearControlStates(); }
      check(signal);
      // The target can disappear, become occluded, or become our supporting
      // block while moving. Re-read physical state instead of trusting a receipt.
      if (reachable()) { position = candidatePosition; break; }
      reject(candidatePosition, '接近后目标已改变、被遮挡、成为脚下承重或仍不在实际可挖范围。');
    }
    if (!position) throw failure('candidates_exhausted', `本次有限检查的 ${Math.min(8, eligible.length)} 个候选未能采集 ${blockName}；其他位置或路线仍未知。`);
    const block = bot.blockAt(position);
    if (!block || block.name !== blockName || !withinDigReach(bot, block)) throw failure('target_changed', '靠近后目标已改变、被遮挡或仍不可挖。');
    if (position.equals(bot.entity.position.floored().offset(0, -1, 0))) throw failure('target_changed', '不能采集脚下承重方块。');
    // Tool choice is a local mechanic; resource choice and progression stay with the NPC.
    const available = ownItems(bot).filter(candidate => !block.harvestTools || block.harvestTools[candidate.type]);
    if (block.harvestTools && !available.length) throw failure('missing_tool', '没有能获取该方块掉落物的工具；不要把破坏方块误当采集成功。');
    if (typeof block.digTime === 'function') {
      available.sort((a, b) => block.digTime(a.type, false, false, false) - block.digTime(b.type, false, false, false));
      if (available[0] && block.digTime(available[0].type, false, false, false) < block.digTime(bot.heldItem?.type ?? null, false, false, false)) {
        await checked(signal, bot.equip(available[0], 'hand'));
      }
    } else if (block.harvestTools && !block.harvestTools[bot.heldItem?.type]) await checked(signal, bot.equip(available[0], 'hand'));
    await checked(signal, bot.lookAt(position.offset(.5, .5, .5), true));
    const fresh = bot.blockAt(position);
    if (!fresh || fresh.type !== block.type || !withinDigReach(bot, fresh)
      || position.equals(bot.entity.position.floored().offset(0, -1, 0)))
      throw failure('target_changed', '准备挖掘时目标或站位已改变，停止该候选。');
    await checked(signal, bot.dig(block, 'ignore'));
    if (!bot.blockAt(position) || bot.blockAt(position)?.type === block.type) throw failure('server_unconfirmed', '服务器未确认方块变化。');
    details.minedBlocks++; details.positions.push({ ...position });
    // Drops are never invented from the block type: approach only actual nearby item entities.
    await delay(150, undefined, { signal });
    const drops = (Object.values(bot.entities) as any[]).filter(entity => ['item', 'item_stack'].includes(entity.name) && entity.position &&
      entity.position.distanceTo(position.offset(.5, .5, .5)) < 3 && entity.position.distanceTo(bot.entity.position) < 8 && controls.entityVisible(bot, entity));
    for (const drop of drops.slice(0, 4)) {
      // Item entities often spend several ticks falling after an upper log is
      // broken. Their airborne y is not a request for the player to fly.
      const until = Date.now() + 800;
      while (bot.entities[drop.id] && bot.entities[drop.id].position.y > bot.entity.position.y + 1.4 && Date.now() < until) {
        await delay(100, undefined, { signal });
      }
      const current = bot.entities[drop.id];
      if (!current) continue;
      const horizontal = Math.hypot(current.position.x - bot.entity.position.x, current.position.z - bot.entity.position.z);
      if (horizontal > 1.25) {
        const landing = pickupLanding(bot, current.position);
        if (landing && landing.distanceTo(origin) <= proposal.maxDistance) {
          try { await controls.moveTo(bot, landing, signal, .8); }
          catch (error: any) {
            check(signal);
            (details.uncollectedDrops ??= []).push({ id: current.id, position: { ...current.position }, reason: error.message });
          } finally { bot.clearControlStates(); }
        } else (details.uncollectedDrops ??= []).push({ id: current.id, position: { ...current.position }, reason: '没有已知安全的拾取站位。' });
      } else if (current.position.y > bot.entity.position.y + 1.4) {
        (details.uncollectedDrops ??= []).push({ id: current.id, position: { ...current.position }, reason: '掉落物仍在高处，已停止等待，没有要求飞行。' });
      }
    }
    await delay(450, undefined, { signal });
  }
  return details;
}

async function syncCraftInventory(bot: any, signal: AbortSignal, details: any, phase: 'baseline' | 'batch') {
  check(signal);
  details.inventoryConfirmed = false; details.inventorySyncPhase = phase;
  await synchronizeCraftInventory(bot);
  details.inventoryConfirmed = true;
  details.craftingWindow = craftWindowState(bot);
  details.inventoryDeltaMeaning = '仅背包储存格变化；合成格/光标另列，不等于物品损失。';
  check(signal);
}

async function craft(bot: any, proposal: any, signal: AbortSignal, details: any) {
  const output = knownItem(bot, proposal.item);
  let table: any = null;
  if (proposal.table) {
    try { table = blockAtReach(bot, proposal.table, ['crafting_table']); }
    catch (error: any) { throw failure('missing_prerequisites', error.message, { prerequisite: 'reachable_crafting_table' }); }
  }
  details.requested = proposal.count; details.item = output.name; details.crafts = 0;
  const beforeCount = counts(bot).get(output.name) || 0;
  while ((counts(bot).get(output.name) || 0) - beforeCount < proposal.count) {
    check(signal);
    const recipes = bot.recipesFor(output.id, null, 1, table);
    if (!recipes.length) {
      details.prerequisites = craftPrerequisites(bot, output, table);
      throw failure('missing_prerequisites', '当前材料或工作台不足；根据回执中的配方要求补足条件，再重新规划。',
        { prerequisite: 'materials_or_crafting_table' });
    }
    const recipe = recipes[0], beforeInventory = counts(bot), before = beforeInventory.get(output.name) || 0;
    // One recipe batch at a time lets cancellation stop before starting the next batch.
    details.inventoryConfirmed = false; details.inventorySyncPhase = 'crafting';
    await checked(signal, bot.craft(recipe, 1, table));
    await syncCraftInventory(bot, signal, details, 'batch');
    const added = (counts(bot).get(output.name) || 0) - before;
    if (added <= 0) throw failure('server_unconfirmed', '合成调用结束，但没有观察到目标物品增加。');
    {
      const window = details.craftingWindow;
      if (window.cursor || window.inputs.some((entry: any) => entry.stack)) throw new Error('服务器合成格或光标仍有物品，停止后续批次；这些物品不应记为消耗或丢失。');
      const after = counts(bot);
      for (const entry of recipe.delta) {
        const name = bot.registry.items[entry.id]?.name;
        if (name && (after.get(name) || 0) - (beforeInventory.get(name) || 0) !== entry.count) {
          throw new Error('服务器确认的物品变化与本批配方不一致，停止后续批次，不自动重试。');
        }
      }
    }
    details.crafts++;
    details.produced = (counts(bot).get(output.name) || 0) - beforeCount;
    if (details.crafts >= 64) throw new Error('达到单次合成批次上限。');
  }
  return details;
}

async function container(bot: any, proposal: any, signal: AbortSignal, details: any) {
  check(signal);
  const block = blockAtReach(bot, proposal.position);
  let window: any;
  try {
    window = await (['furnace', 'blast_furnace', 'smoker'].includes(block.name) ? bot.openFurnace(block) : bot.openContainer(block));
    check(signal);
    details.position = { ...block.position }; details.operation = proposal.operation;
    details.contentsBefore = window.containerItems().map(compact);
    if (proposal.operation !== 'list') {
      const definition = knownItem(bot, proposal.item), before = counts(bot).get(definition.name) || 0;
      if (proposal.operation === 'deposit') item(bot, definition.name, proposal.count);
      else if (window.containerItems().filter((entry: any) => entry.name === definition.name).reduce((sum: number, entry: any) => sum + entry.count, 0) < proposal.count) throw new Error('容器内指定物品数量不足。');
      await checked(signal, window[proposal.operation](definition.id, null, proposal.count));
      details.transferred = ((counts(bot).get(definition.name) || 0) - before) * (proposal.operation === 'deposit' ? -1 : 1);
      if (details.transferred < proposal.count) throw new Error('容器操作未确认足够的背包数量变化。');
    }
    details.contentsAfter = window.containerItems().map(compact);
    return details;
  } finally { await closeWindow(bot, window); }
}

async function smelt(bot: any, proposal: any, signal: AbortSignal, details: any) {
  check(signal);
  const input = knownItem(bot, proposal.input), fuel = knownItem(bot, proposal.fuel);
  const block = blockAtReach(bot, proposal.position, ['furnace', 'blast_furnace', 'smoker']);
  details.position = { ...block.position }; details.requested = proposal.count; details.collected = 0; details.fuelAdded = 0;
  let furnace: any, propertyWindow: any, closed = false;
  const properties: Array<number | undefined> = Array(4).fill(undefined);
  // Mineflayer initializes normalized values to null; property 0 before 1 also
  // leaves fuel at a false zero. Observe only this open window's raw properties,
  // including packets delivered before openFurnace's promise resumes.
  const onProperty = (packet: any) => {
    const window = bot.currentWindow;
    if (signal.aborted || closed || !window || packet.windowId !== window.id
      || (furnace && window !== furnace) || (propertyWindow && window !== propertyWindow)
      || !Number.isInteger(packet.property) || packet.property < 0 || packet.property > 3
      || !Number.isInteger(packet.value) || packet.value < 0 || packet.value > 32767) return;
    propertyWindow = window; properties[packet.property] = packet.value;
  };
  const removeProperties = () => bot._client.removeListener('craft_progress_bar', onProperty);
  const onClose = () => { closed = true; removeProperties(); };
  const checkWindow = () => {
    check(signal);
    if (closed || bot.currentWindow !== furnace) throw failure('furnace_window_closed', '熔炉窗口已关闭或被替换，停止本轮熔炼。');
  };
  const started = Date.now();
  bot._client.on('craft_progress_bar', onProperty);
  signal.addEventListener('abort', removeProperties, { once: true });
  try {
    furnace = await bot.openFurnace(block); check(signal);
    furnace.once('close', onClose);
    const syncDeadline = Date.now() + 2000;
    checkWindow();
    if (furnace.inputItem() && furnace.inputItem().name !== input.name) throw new Error('熔炉输入槽已有其他材料；先用 container 检查或取走。');
    if (furnace.outputItem()) {
      details.preexistingOutput = compact(furnace.outputItem());
      await checked(signal, furnace.takeOutput()); checkWindow();
    }
    const queued = furnace.inputItem()?.count || 0, needed = Math.max(0, proposal.count - queued);
    if (needed) { const source = item(bot, input.name, needed); await checked(signal, furnace.putInput(source.type, source.metadata, needed)); checkWindow(); }
    details.queuedInput = compact(furnace.inputItem());
    if (!furnace.inputItem() || furnace.inputItem().name !== input.name) throw new Error('熔炉没有确认输入材料。');
    while (details.collected < proposal.count) {
      checkWindow();
      if (Date.now() - started > 40000) throw new Error('本轮熔炼等待已结束，剩余材料保留在熔炉；请稍后观察或继续。');
      const output = furnace.outputItem();
      if (output) {
        const outputName = output.name, before = counts(bot).get(outputName) || 0;
        await checked(signal, furnace.takeOutput()); checkWindow();
        const confirmed = (counts(bot).get(outputName) || 0) - before;
        if (confirmed <= 0) throw new Error('取出熔炼产物后没有确认背包增量。');
        details.collected += confirmed; details.output = outputName;
      }
      if (details.collected >= proposal.count) break;
      if (propertyWindow !== furnace || properties.some(value => value === undefined)) {
        if (Date.now() >= syncDeadline) throw failure('furnace_sync_timeout', '熔炉初始燃料和进度尚未同步，材料保留在炉内；请稍后观察。');
        await delay(Math.min(200, syncDeadline - Date.now()), undefined, { signal });
        continue; // Recheck actual output before trying fuel after a delayed update.
      }
      if (!furnace.fuelItem() && properties[0] === 0) {
        const source = item(bot, fuel.name);
        await checked(signal, furnace.putFuel(source.type, source.metadata, 1)); checkWindow(); details.fuelAdded++;
      }
      await delay(200, undefined, { signal });
    }
    return details;
  } finally {
    removeProperties(); signal.removeEventListener('abort', removeProperties);
    furnace?.removeListener('close', onClose);
    if (furnace) details.remaining = { input: compact(furnace.inputItem()), fuel: compact(furnace.fuelItem()), output: compact(furnace.outputItem()), progress: furnace.progress };
    await closeWindow(bot, furnace);
  }
}

export async function runSurvivalAction(bot: any, proposal: any, signal: AbortSignal, controls: SurvivalControls) {
  check(signal);
  if (proposal.type === 'scan') return scan(bot, proposal, controls);
  if (proposal.type === 'recipes') {
    const definition = knownItem(bot, proposal.item);
    // recipesAll only tests table truthiness; a truthy query context includes table
    // recipes without claiming that a table exists or sending a world interaction.
    const inventory = counts(bot), all = bot.recipesAll(definition.id, null, true).map((recipe: any) => recipeInfo(bot, recipe));
    const score = (recipe: any) => recipe.materials.reduce((sum: number, entry: any) => sum + Math.min(1, (inventory.get(entry.item) || 0) / entry.count), 0) / Math.max(1, recipe.materials.length);
    all.sort((a: any, b: any) => Number(b.hasMaterials) - Number(a.hasMaterials) || score(b) - score(a));
    return { item: definition.name, recipes: all.slice(0, 12), totalRecipes: all.length, omitted: Math.max(0, all.length - 12),
      note: '这是按当前背包匹配度排序的配方备选样本；hasMaterials 只检查一批材料，requiresTable 仍需真实工作台。未列出的树种/材料组合不表示不可用，craft以recipesFor实际结果为准。' };
  }
  if (bot.currentWindow) { await releaseUnmanagedWindow(bot); check(signal); }
  let before = counts(bot);
  const details: any = {};
  try {
    if (proposal.type === 'gather') await gather(bot, proposal, signal, controls, details);
    else if (proposal.type === 'craft') {
      const crafting = async () => {
        await syncCraftInventory(bot, signal, details, 'baseline');
        before = counts(bot);
        if (details.craftingWindow.cursor || details.craftingWindow.inputs.some((entry: any) => entry.stack)) {
          throw new Error('合成开始前光标或合成格已有物品，保留现场并停止；请先检查 craftingWindow。');
        }
        await craft(bot, proposal, signal, details);
      };
      if (proposal.table) await managedWindowOperation(bot, crafting); else await crafting();
    }
    else if (proposal.type === 'container') await managedWindowOperation(bot, () => container(bot, proposal, signal, details));
    else if (proposal.type === 'smelt') await managedWindowOperation(bot, () => smelt(bot, proposal, signal, details));
    else if (proposal.type === 'sleep') {
      if (!String(bot.game.dimension).includes('overworld')) throw new Error('当前维度不能用床睡觉。');
      const bed = blockAtReach(bot, proposal.position);
      if (!bot.isABed(bed)) throw new Error('目标不是床。');
      await checked(signal, bot.sleep(bed)); details.sleeping = bot.isSleeping;
      if (!details.sleeping) throw new Error('没有收到进入睡眠的确认。');
    } else throw new Error('不支持这个生存行动。');
    check(signal);
    details.inventoryDelta = delta(before, bot);
    if (proposal.type === 'gather') {
      details.pickupConfirmed = details.inventoryDelta.some((entry: any) => entry.change > 0);
      details.note = '挖掉方块不等于得到预期物品；只按实际 inventoryDelta 判断入包。';
    }
    return details;
  } catch (error: any) {
    if (error.inventoryUnconfirmed || error.details?.inventoryConfirmed === false) details.inventoryConfirmed = false;
    details.inventoryDelta = delta(before, bot);
    details.partial = details.inventoryDelta.length > 0 || details.minedBlocks > 0;
    // Preserve machine-readable causes through partial-result accounting. The
    // localized message remains diagnostic text rather than a retry classifier.
    if (error.details?.prerequisite) details.prerequisite = error.details.prerequisite;
    details.stoppedReason = signal.aborted ? 'cancelled' : error.details?.stoppedReason ?? error.message;
    details.reason = error.message;
    if (details.inventoryConfirmed === false) {
      details.partial = (details.crafts || 0) > 0;
      details.unconfirmedInventoryDelta = details.inventoryDelta;
      details.inventoryDelta = [];
      details.craftingWindow = craftWindowState(bot);
      details.note = '当前窗口仍可能含客户端预测；差异仅放在 unconfirmedInventoryDelta 供诊断，不能认定产物、消耗或损失。';
    }
    if (proposal.type === 'gather') details.pickupConfirmed = details.inventoryDelta.some((entry: any) => entry.change > 0);
    error.details = details;
    throw error;
  } finally {
    bot.clearControlStates();
    if (signal.aborted) { try { bot.stopDigging(); } catch {} }
  }
}
