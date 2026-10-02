import { CameraSession } from './camera-session.js';

const $ = id => document.getElementById(id);
const names = { Sheldon: '谢耳朵', Sherlock: '福尔摩斯', Deadpool: '死侍', HuYifei: '胡一菲' };
const actions = { goto: '移动', move: '移动', look: '观察方向', say: '说话', broadcast: '世界频道', dig: '挖掘', place: '放置', wait: '等待', stop: '停止', attack: '近战攻击', shoot: '射击', equip: '装备', consume: '进食', use_item: '使用物品', interact: '交互', toss: '交付物品', scan: '观察资源', recipes: '查找配方', craft: '制作', gather: '采集', smelt: '冶炼', container: '整理容器', sleep: '睡觉' };
const stages = { starting: '刚刚出生', resources: '取得资源', smelting: '取得铁锭', nether: '到达下界', end: '进入末地', victory: '完成屠龙' };
const outcomes = { completed: '已执行', failed: '失败', cancelled: '已中断' };
let token, sessionPromise, refreshBusy = false, operationBusy = false, experimentBusy = false;
let currentBots = [], currentExperiment = {}, observations = new Map();
let experience = {}, playBusy = false;
const camera = new CameraSession({
  visible: document.visibilityState !== 'hidden',
  onState: cameraState,
  mount(url, npc) {
    // Replacing the browsing context avoids a stalled navigation retaining the old
    // renderer/socket while the surrounding UI already names a different NPC.
    const frame = document.createElement('iframe');
    frame.id = 'world-view'; frame.title = `${names[npc] || npc} · 第三人称实时画面`;
    frame.allow = 'fullscreen'; frame.src = url;
    $('viewport').prepend(frame);
    return { window: frame.contentWindow, remove: () => frame.remove() };
  },
});

function selectNpc(name) {
  $('bot').value = name;
  renderSelected(); renderCast();
}
function cameraState(status, message) {
  $('viewer-state').textContent = ({ live: '实时画面', connecting: '连接画面', loading: '加载区块', waiting: '等待角色', disconnected: '画面已断开', error: '画面暂不可用' })[status] || '加载画面';
  $('viewer-state').dataset.phase = status === 'live' ? 'running' : 'stopped';
  $('viewer-message').textContent = message || '正在接收真实世界画面…';
  $('viewer-placeholder').hidden = status === 'live';
  $('viewer-retry').hidden = !['error', 'disconnected'].includes(status);
}
function renderCamera() {
  const selected = $('bot').value;
  if ([...$('camera-tabs').children].map(node => node.dataset.npc).join(',') !== currentBots.map(bot => bot.name).join(',')) {
    $('camera-tabs').replaceChildren(...currentBots.map(bot => {
      const button = element('button', names[bot.name] || bot.name);
      button.dataset.npc = bot.name;
      button.onclick = () => selectNpc(bot.name);
      return button;
    }));
  }
  for (const button of $('camera-tabs').children) button.setAttribute('aria-pressed', String(button.dataset.npc === selected));
  const base = experience.viewer?.url;
  const next = base && selected ? `${base}/?npc=${encodeURIComponent(selected)}&parentOrigin=${encodeURIComponent(location.origin)}` : '';
  camera.select(base, selected);
  $('camera-open').hidden = !next;
  if (next) $('camera-open').href = next;
  $('camera-reset').disabled = !next;
  $('camera-fullscreen').disabled = !next;
  $('camera-caption').textContent = `${names[selected] || 'NPC'} · 第三人称跟随 · 拖动旋转 · 滚轮缩放`;
}
function renderPlay() {
  const play = experience.play;
  $('play-game').disabled = playBusy || !play?.available;
  $('play-game').textContent = playBusy ? '正在打开游戏…' : play?.state === 'client-running' ? '游戏已打开 ↗' : '进入游戏 ↗';
  $('play-status').textContent = play?.connected ? '已进入当前世界 · AnimaObserver 在线' : play?.message || '正在检查本机客户端…';
  $('play-version').textContent = `Minecraft Java ${experience.version || '1.21.4'}`;
  $('play-address').textContent = play?.serverAddress || experience.serverAddress || '127.0.0.1:25565';
}
window.addEventListener('message', event => camera.receive(event));
let cameraIntersects = true;
const syncCameraVisibility = () => camera.setVisible(document.visibilityState !== 'hidden' && cameraIntersects);
document.addEventListener('visibilitychange', syncCameraVisibility);
// Chromium can throttle an offscreen cross-origin iframe independently of the
// parent document. Keep that pause out of the camera's connection watchdog.
const cameraVisibility = new IntersectionObserver(entries => {
  const entry = entries.find(item => item.target === $('viewport'));
  if (!entry) return;
  cameraIntersects = entry.isIntersecting && entry.intersectionRatio > 0;
  syncCameraVisibility();
});
cameraVisibility.observe($('viewport'));
window.addEventListener('pagehide', () => camera.release());

async function renewSession() {
  if (!sessionPromise) {
    sessionPromise = fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then(response => { if (!response.ok) throw new Error('无法读取本机会话。'); return response.json(); })
      .then(session => { token = session.token; })
      .finally(() => { sessionPromise = undefined; });
  }
  return sessionPromise;
}
async function api(path, input, canRenew = true) {
  const response = await fetch('/api/' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(input === undefined ? 8000 : 115000),
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  // A restarted local service creates a new token. A rejected request has not
  // executed, so it can safely be retried once after refreshing this session.
  if (response.status === 401 && canRenew) { await renewSession(); return api(path, input, false); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function coordinates(position) {
  return position && ['x', 'y', 'z'].every(key => Number.isFinite(position[key]))
    ? `X ${position.x.toFixed(1)} / Y ${position.y.toFixed(1)} / Z ${position.z.toFixed(1)}` : '等待位置观测';
}
function dimensionName(value) {
  return ({ overworld: '主世界', 'minecraft:overworld': '主世界', the_nether: '下界', nether: '下界', 'minecraft:the_nether': '下界', the_end: '末地', end: '末地', 'minecraft:the_end': '末地' })[value] || value || '等待维度观测';
}
function inventoryText(inventory) {
  if (!Array.isArray(inventory)) return '等待背包观测';
  if (!inventory.length) return '背包为空';
  return inventory.slice(0, 6).map(item => `${item.name} ×${item.count}`).join(' · ') + (inventory.length > 6 ? ` · 另 ${inventory.length - 6} 种` : '');
}
function readableEvent(event) {
  if (event.type === 'heard') return `${event.channel === 'broadcast' ? '[世界] ' : ''}${names[event.speaker] || event.speaker}：${event.message}`;
  if (event.type === 'said') return `${event.channel === 'broadcast' ? '[世界] ' : ''}我说：${event.message}`;
  if (event.type === 'hurt') return `受到伤害 · 生命 ${event.healthBefore} → ${event.health}`;
  if (event.type === 'action') return `${actions[event.action?.type] || event.action?.type || '行动'} · ${outcomes[event.status] || event.status}${event.error ? ' · ' + event.error : ''}`;
  if (event.type === 'task-finished') return event.reply || '这一轮思考已结束。';
  if (event.type === 'task-started') return '正在观察世界并思考下一步。';
  if (event.type === 'task-failed') return `思考中断：${event.message || '等待下次重试'}`;
  return ({ spawn: '进入世界', death: '角色死亡', disconnected: '与世界断开连接', error: '世界连接异常' })[event.type] || event.type;
}
function renderExperiment() {
  const { scenario, scheduler } = currentExperiment;
  const survival = scenario?.kind === 'survival';
  const progress = scenario?.progress;
  const enteredEnd = survival ? Boolean(progress?.milestones?.end) : Boolean(scenario?.observedDragon);
  const running = scheduler?.phase === 'running';
  const phase = scenario?.complete ? 'victory' : scheduler?.phase === 'stopping' ? 'stopping' : running ? 'running' : scenario ? (scenario.phase === 'preparing' ? 'preparing' : 'stopped') : 'sandbox';
  $('phase').textContent = ({ victory: survival ? '生存目标已完成' : '旧测试已结束', stopping: '正在暂停', running: '自主协作中', preparing: '环境准备中', stopped: '已暂停', sandbox: '自由观察世界' })[phase];
  $('phase').dataset.phase = phase;
  $('experiment-title').textContent = survival ? '从空手开始，一起生存。' : scenario ? '旧末地战斗测试' : 'Minecraft 自由观察';
  $('progress-stage').textContent = survival ? stages[progress?.stage] || '等待出生' : '非完整生存';
  $('progress-description').textContent = survival ? '已达到的里程碑只记录进展，不代替完整生存目标。' : '旧末地测试不计作随机世界生存目标完成。';
  const checks = Object.values(progress?.initialInventory || {});
  $('initial-check').textContent = survival ? `${checks.filter(check => check.empty).length} / 4` : '未适用';
  $('initial-description').textContent = progress?.initialEmptyVerified ? '首次空手已核验；读档后保留已有物资' : checks.some(check => !check.empty) ? '发现初始物品，不能作为空手开局' : '等待四名角色的真实背包检查';
  $('milestones').replaceChildren(...['resources', 'smelting', 'nether', 'end', 'victory'].map(stage => {
    const reached = progress?.milestones?.[stage];
    const item = element('span', stages[stage], reached ? 'reached' : '');
    if (reached) item.title = `${names[reached.actor] || reached.actor} · ${reached.evidence}`;
    return item;
  }));
  const health = scenario?.dragonHealth;
  $('dragon-summary').textContent = '末地与最终完成证据 · ' + (enteredEnd ? (scenario?.complete ? '服务器已确认' : '已进入末地') : '尚未进入末地');
  $('dragon-health').textContent = !enteredEnd ? '未进入末地' : Number.isFinite(health) ? `${Number(health.toFixed(1))} / ${scenario.rules?.dragonHealth || 200}` : '尚未观测';
  $('dragon-progress').hidden = !enteredEnd || !Number.isFinite(health);
  $('dragon-progress').max = scenario?.rules?.dragonHealth || 200;
  $('dragon-progress').value = Number.isFinite(health) ? Math.max(0, health) : 0;
  $('crystals').textContent = !enteredEnd ? '未进入末地' : Number.isFinite(scenario?.crystals) ? String(scenario.crystals) : '—';
  $('dragon-phase').textContent = !enteredEnd ? '等待真实末地经历' : scenario?.dragonPresent === 0 ? '世界当前未检测到龙实体' : Number.isFinite(scenario?.dragonPhase) ? `龙行为阶段 ${scenario.dragonPhase}` : '等待世界观测';
  $('active-tasks').textContent = scheduler ? `${scheduler.activeTasks} / ${scheduler.maxConcurrent}` : '—';
  $('cadence').textContent = scheduler ? `空闲间隔约 ${Math.round(scheduler.intervalMs / 1000)} 秒 · ${scheduler.pendingEvents} 条待处理事件` : '本实例未启用持续协作';
  $('scenario-description').textContent = survival ? (scenario.complete ? '本次随机世界的完整生存目标已由服务器自然屠龙证据确认。' : scenario.objective) : scenario ? '旧版末地战斗测试含预置装备和传送，不计入“随机新世界空手生存”的完成结果。' : '观察角色在真实世界中的行动与对话。';
  $('experiment-start').disabled = experimentBusy || !scenario || running || phase === 'stopping' || scenario.complete || (survival && !progress?.initialEmptyVerified) || currentBots.filter(bot => bot.ready).length < 4;
  $('experiment-start').textContent = phase === 'stopped' ? '继续协作' : '开始协作';
  $('experiment-stop').disabled = experimentBusy || !scenario || (!running && !scheduler?.activeTasks);
  const evidence = [
    [Boolean(scenario?.observedDragon), '曾实际观测到存活的龙'],
    [Boolean(scenario?.victories?.length), `服务器屠龙成就${scenario?.victories?.length ? '：' + scenario.victories.map(name => names[name] || name).join('、') : ''}`],
    [scenario?.dragonPresent === 0, '龙实体已消失'],
  ];
  $('evidence').replaceChildren(...evidence.map(([confirmed, label]) => element('span', label, confirmed ? 'confirmed' : '')));
  $('rules-text').textContent = survival ? '随机地图、普通生存、简单难度。昼夜、天气、怪物、饥饿和死亡掉落正常运行。没有赠送装备、传送、持续效果或要塞定位；四人在同一自然出生区自行获取资源并协作。资源里程碑与攻击动作都不等于最终胜利。' : scenario ? '这是旧版的末地战斗测试，环境包含预置物资与辅助设置，请切换到独立的普通生存世界。' : '当前是自由观察实例，可以查看角色和下达单次任务。';
  $('run-id').textContent = scenario ? `运行 ${scenario.runId}${scenario.worldId ? ' · 世界 ' + scenario.worldId : ''}${scenario.updatedAt ? ' · 最近保存 ' + new Date(scenario.updatedAt).toLocaleString() : ''}` : '';
}
function renderCast() {
  const { scenario, scheduler } = currentExperiment;
  $('cast').replaceChildren(...currentBots.map(bot => {
    const schedule = scheduler?.actors?.find(actor => actor.name === bot.name);
    const observation = observations.get(bot.name) || scenario?.progress?.actors?.[bot.name];
    const card = element('article', undefined, 'npc-card' + (bot.name === $('bot').value ? ' selected' : ''));
    const title = element('div', undefined, 'npc-heading');
    const name = element('button', names[bot.name] || bot.name, 'npc-name');
    name.onclick = () => selectNpc(bot.name);
    const state = !bot.ready ? '未在线' : schedule?.failures ? `退避 ${Math.ceil(schedule.nextRunInMs / 1000)} 秒` : schedule?.phase === 'running' ? '思考 / 行动中' : bot.busy ? '执行任务中' : scheduler?.phase === 'running' ? `${Math.ceil((schedule?.nextRunInMs || 0) / 1000)} 秒后思考` : '等待任务';
    title.append(name, element('span', state, 'npc-state'));
    card.append(title, element('p', `${dimensionName(observation?.dimension || bot.dimension)} · ${coordinates(observation?.position || bot.position)}`, 'npc-location'));
    const vitals = element('div', undefined, 'npc-vitals');
    for (const [label, value] of [['生命', observation?.health ?? bot.health], ['饥饿', observation?.food ?? bot.food]]) {
      const item = element('span'); item.append(element('small', label), element('strong', Number.isFinite(value) ? `${value} / 20` : '—')); vitals.append(item);
    }
    const inventoryUnconfirmed = observation?.inventoryConfirmed === false || bot.inventoryConfirmed === false;
    card.append(vitals, element('p', inventoryUnconfirmed ? '背包状态待重新同步' : inventoryText(observation?.inventory || bot.inventory), 'npc-inventory'));
    const events = observation?.recentEvents || [];
    const latest = events.filter(event => event.type === 'action' || event.type === 'said' || event.type === 'heard').at(-1);
    const thought = events.filter(event => event.type === 'task-finished' && event.reply).at(-1);
    card.append(element('p', latest ? readableEvent(latest) : '等待新的对话与行动回执。', 'npc-action'));
    if (thought) card.append(element('p', '最近想法：' + String(thought.reply).slice(0, 220), 'npc-plan'));
    const counts = element('div', undefined, 'npc-counts');
    for (const [label, value] of [['行动回执', scenario?.actions?.[bot.name] || 0], ['攻击执行', scenario?.attacks?.[bot.name] || 0], ['死亡', scenario?.deaths?.[bot.name] || 0]]) {
      const cell = element('div'); cell.append(element('span', label), element('strong', String(value))); counts.append(cell);
    }
    card.append(counts);
    const error = bot.error || schedule?.lastError;
    if (error) card.append(element('p', String(error), 'npc-error'));
    return card;
  }));
  if (!currentBots.length) $('cast').append(element('p', '等待角色进入世界…', 'empty'));
}
function renderSelected() {
  renderCamera();
  const bot = currentBots.find(item => item.name === $('bot').value);
  const autoRunning = currentExperiment.scheduler?.phase === 'running';
  for (const id of ['task', 'say', 'move']) $(id).disabled = operationBusy || !bot?.ready || bot.busy || autoRunning;
  $('stop').disabled = !bot?.ready || !bot.busy;
  if (!bot) return;
  $('persona').textContent = bot.persona;
  const observation = observations.get(bot.name);
  $('position').textContent = bot.ready ? `${coordinates(bot.position)} · 生命 ${observation?.health ?? bot.health ?? '—'} · 饥饿 ${observation?.food ?? bot.food ?? '—'} · ${dimensionName(observation?.dimension || bot.dimension)}` : bot.error || '角色正在进服…';
  $('viewer-link').hidden = !bot.viewer;
  if (bot.viewer) $('viewer-link').href = bot.viewer;
  const events = observations.get(bot.name)?.recentEvents || [];
  $('events').replaceChildren(...events.slice(-14).reverse().map(event => {
    const row = element('div', undefined, 'event' + (event.status === 'failed' || event.type === 'task-failed' ? ' failed' : ''));
    row.append(element('time', event.time ? new Date(event.time).toLocaleTimeString() : '—'), element('span', readableEvent(event)));
    return row;
  }));
  if (!events.length) $('events').append(element('p', bot.ready ? '还没有新的经历。' : '角色目前未在线。', 'empty'));
}
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    const [botsResult, experiment, liveExperience] = await Promise.all([api('bots'), api('experiment'), api('experience')]);
    experience = liveExperience;
    if (currentExperiment.scenario?.worldId !== experiment.scenario?.worldId) observations.clear();
    currentBots = botsResult.bots; currentExperiment = experiment;
    const selected = $('bot').value;
    if ([...$('bot').options].map(option => option.value).join(',') !== currentBots.map(bot => bot.name).join(',')) {
      $('bot').replaceChildren(...currentBots.map(bot => { const option = element('option', names[bot.name] || bot.name); option.value = bot.name; return option; }));
      if (currentBots.some(bot => bot.name === selected)) $('bot').value = selected;
    }
    const available = currentBots.filter(bot => bot.ready).slice(0, 4);
    const results = await Promise.allSettled(available.map(bot => api(`bots/${encodeURIComponent(bot.name)}/observe`)));
    for (let index = 0; index < results.length; index += 1) {
      if (results[index].status === 'fulfilled') observations.set(available[index].name, results[index].value);
    }
    $('health').textContent = `本地世界 · ${available.length} 个角色在线`;
    renderExperiment(); renderCast(); renderSelected(); renderPlay();
  } catch (error) {
    $('health').textContent = '连接中断 · ' + error.message;
    for (const id of ['task', 'say', 'move', 'experiment-start']) $(id).disabled = true;
  } finally { refreshBusy = false; }
}
async function operate(endpoint, input) {
  if (operationBusy) return;
  const name = $('bot').value;
  if (!name) return;
  operationBusy = true; renderSelected(); $('result').textContent = '角色正在执行…';
  try {
    const result = await api(`bots/${encodeURIComponent(name)}/${endpoint}`, input);
    $('result').textContent = result.reply ? result.reply + '\n\n' + JSON.stringify(result.actions, null, 2) : JSON.stringify(result, null, 2);
  } catch (error) { $('result').textContent = error.message; }
  finally { operationBusy = false; await refresh(); renderSelected(); }
}
async function experiment(action) {
  if (experimentBusy) return;
  experimentBusy = true; renderExperiment();
  $('experiment-result').textContent = action === 'start' ? '正在唤醒四名角色…' : '正在结束当前思考与行动…';
  try {
    await api(`experiment/${action}`, {});
    $('experiment-result').textContent = action === 'start' ? '持续协作已开始。真实世界达到目标后会自动结束。' : '已暂停 NPC 持续调度。世界与已有记录保留。';
  } catch (error) { $('experiment-result').textContent = error.message; }
  finally { experimentBusy = false; await refresh(); renderExperiment(); }
}
$('experiment-start').onclick = () => experiment('start');
$('experiment-stop').onclick = () => experiment('stop');
$('task').onclick = () => operate('tasks', { instruction: $('instruction').value });
$('stop').onclick = async () => {
  const name = $('bot').value;
  if (!name) return;
  $('stop').disabled = true;
  try { await api(`bots/${encodeURIComponent(name)}/stop`, {}); $('result').textContent = '已请求中断当前一轮。'; }
  catch (error) { $('result').textContent = error.message; }
  finally { await refresh(); }
};
$('say').onclick = () => operate('actions', { type: 'say', message: $('message').value });
$('message').onkeydown = event => { if (event.key === 'Enter' && !$('say').disabled) $('say').click(); };
$('move').onclick = () => {
  if (['x', 'y', 'z'].some(id => !$(id).value.trim())) { $('result').textContent = '请填写完整的 X、Y、Z 坐标。'; return; }
  void operate('actions', { type: 'goto', x: Number($('x').value), y: Number($('y').value), z: Number($('z').value) });
};
$('bot').onchange = () => { renderSelected(); renderCast(); };
$('viewer-retry').onclick = () => camera.select(experience.viewer?.url, $('bot').value, { force: true });
$('camera-reset').onclick = () => camera.select(experience.viewer?.url, $('bot').value, { force: true });
$('camera-fullscreen').onclick = async () => {
  try { await $('viewport').requestFullscreen(); }
  catch { $('world-view')?.contentWindow?.focus(); $('camera-caption').textContent = '当前浏览器不支持全屏，可以使用「独立窗口」。'; }
};
$('copy-address').onclick = async () => {
  try { await navigator.clipboard.writeText($('play-address').textContent); $('copy-address').textContent = '已复制'; }
  catch { $('play-status').textContent = '请复制服务器地址：' + $('play-address').textContent; }
};
$('camera-exit').onclick = () => { if (document.fullscreenElement) void document.exitFullscreen(); };
$('play-game').onclick = async () => {
  if (playBusy) return;
  playBusy = true; renderPlay();
  try { experience.play = await api('play/launch', {}); }
  catch (error) { experience.play = { ...experience.play, state: 'failed', message: error.message }; }
  finally { playBusy = false; renderPlay(); }
};
renewSession()
  .then(() => { void refresh(); setInterval(refresh, 2500); })
  .catch(error => { $('health').textContent = error.message; });
