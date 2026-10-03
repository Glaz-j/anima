import type { ExamTask, Vec, Checkpoint, EnemySpec } from './types.ts';

const v = (x: number, y: number, z: number): Vec => ({ x, y, z });
const checkpoint = (x: number, y: number, z = 0.5, radius = 0.8): Checkpoint => ({ center: v(x, y, z), radius, grounded: true });
const terrain = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => ({ from: v(x1, y1, z1), to: v(x2, y2, z2), block });
const enemy = (tag: string, x: number, z: number): EnemySpec => ({ type: 'zombie', tag, position: v(x, 64, z) });
const base = (id: string, category: ExamTask['category'], title: string, instruction: string): ExamTask => ({
  id, revision: 1, stage: 1, category, title, instruction, timeoutMs: 90_000,
  required: ['isolated-world', 'server-player-nbt', 'server-statistics', 'server-entities', 'server-clock'],
  spawn: v(0.5, 64, 0.5), inventory: [], terrain: [], enemies: [], checkpoints: [], objective: {},
});
const logs = (count: number) => Array.from({ length: count }, (_, i) => terrain(4 + Math.floor(i / 2), 64, i % 2, 4 + Math.floor(i / 2), 64, i % 2, 'oak_log'));
const parkourWalls = () => [terrain(-1, 64, -2, 11, 68, -2, 'bedrock'), terrain(-1, 64, 2, 11, 68, 2, 'bedrock'), terrain(-1, 64, -2, -1, 68, 2, 'bedrock'), terrain(11, 64, -2, 11, 68, 2, 'bedrock')];

/** Stage one uses fixed, reviewable arenas. Random/held-out variants are stage two, not fabricated extra scores. */
export const STAGE_ONE_TASKS: readonly ExamTask[] = [
  { ...base('combat-single-01', 'combat-single', '单个僵尸', '击败场内指定僵尸并存活；不要离开考场。'),
    revision: 2,
    inventory: [{ item: 'iron_sword', count: 1 }], enemies: [enemy('exam_enemy_a', 7.5, 0.5)] },
  { ...base('combat-multiple-01', 'combat-multiple', '两个僵尸', '击败场内两个指定僵尸并存活；根据局面移动、反击。'),
    revision: 2,
    inventory: [{ item: 'iron_sword', count: 1 }], enemies: [enemy('exam_enemy_a', 7.5, -2.5), enemy('exam_enemy_b', 7.5, 3.5)] },
  { ...base('parkour-empty-01', 'parkour-empty', '空手连续跳跃', '空手沿黑色基岩平台跨越两段缺口，依次落稳在 x=3.5、x=6.5 的平台上。不放置、不破坏方块。'),
    revision: 2,
    terrain: [terrain(1, 60, -2, 8, 63, 2, 'air'), terrain(0, 63, 0, 0, 63, 0, 'bedrock'), terrain(3, 63, 0, 3, 63, 0, 'bedrock'), terrain(6, 63, 0, 6, 63, 0, 'bedrock'), ...parkourWalls()],
    checkpoints: [checkpoint(3.5, 64, 0.5, 0.55), checkpoint(6.5, 64, 0.5, 0.55)], objective: { minJumps: 2, maxPlaced: 0 } },
  { ...base('parkour-items-01', 'parkour-items', '有限材料搭桥并登高', '用最多 8 块圆石跨过缺口，先到达 x=6.5,y=64 的平台，再登上 x=9.5,y=66 的平台并落稳。'),
    revision: 2,
    inventory: [{ item: 'cobblestone', count: 8 }], timeoutMs: 120_000,
    terrain: [terrain(1, 60, -2, 5, 63, 2, 'air'), terrain(6, 63, -1, 7, 63, 1, 'bedrock'), terrain(8, 64, -1, 10, 65, 1, 'bedrock'), ...parkourWalls()],
    checkpoints: [checkpoint(6.5, 64), checkpoint(9.5, 66)], objective: { maxPlaced: 8, requirePlacement: true } },
  { ...base('craft-01', 'craft', '从原木合成木镐', '使用背包原木和场内工作台合成一把木镐；需要自行完成木板、木棍等中间步骤。'),
    inventory: [{ item: 'oak_log', count: 3 }], terrain: [terrain(2, 64, 0, 2, 64, 0, 'crafting_table')],
    objective: { item: 'wooden_pickaxe', count: 1, statistic: 'crafted_pickaxe' } },
  { ...base('gather-01', 'gather', '采集并拾取六根原木', '采集考场的 6 根橡木原木，确认全部进入自己的背包。'),
    inventory: [{ item: 'wooden_axe', count: 1 }], terrain: logs(6), objective: { item: 'oak_log', count: 6, statistic: 'mined_oak' } },
  { ...base('navigate-01', 'navigate', '绕墙抵达目标', '绕过正前方的基岩墙，先到 x=4.5,z=4.5，再到 x=8.5,z=0.5。不可拆墙。'),
    revision: 2,
    terrain: [terrain(3, 64, -4, 3, 67, 3, 'bedrock')], checkpoints: [checkpoint(4.5, 64, 4.5, 1.2), checkpoint(8.5, 64, 0.5, 1.2)] },
  { ...base('water-rescue-01', 'water-rescue', '水池自救上岸', '你在水池中。浮上水面并从东侧上岸，抵达 x=4.5,y=64,z=0.5 的安全地点。'),
    spawn: v(0.5, 61, 0.5), terrain: [terrain(-3, 60, -3, 3, 63, 3, 'bedrock'), terrain(-2, 61, -2, 2, 63, 2, 'water')],
    checkpoints: [checkpoint(4.5, 64, 0.5)], timeoutMs: 45_000 },
  { ...base('eat-resume-01', 'eat-resume', '进食后继续采集', '先吃背包里的熟牛肉恢复饥饿，再采集并拾取场内 2 根原木。'),
    inventory: [{ item: 'cooked_beef', count: 3 }, { item: 'wooden_axe', count: 1 }], terrain: logs(2),
    initialFood: { maximum: 12 }, objective: { item: 'oak_log', count: 2, statistic: 'mined_oak' } },
  { ...base('interrupt-resume-01', 'interrupt-resume', '遭遇敌人后恢复采集', '采集并拾取 8 根原木。途中如出现敌人，先击败敌人，再继续剩余采集任务。'),
    revision: 2,
    inventory: [{ item: 'iron_sword', count: 1 }, { item: 'wooden_axe', count: 1 }], terrain: logs(8), timeoutMs: 150_000,
    objective: { item: 'oak_log', count: 8, statistic: 'mined_oak' },
    perturbation: { when: 'first-resource', enemy: enemy('exam_enemy_interrupt', 7.5, 0.5) } },
];

export function getExamTask(id: string): ExamTask {
  const task = STAGE_ONE_TASKS.find(task => task.id === id);
  if (!task) throw new Error(`Unknown skill exam: ${id}`);
  return structuredClone(task);
}

/** Design metadata only: deliberately not registered in STAGE_ONE_TASKS or getExamTask. */
const STAGE_TWO_GATE = '当前冻结源码/模型的agent组：一期全部10道当前版本题，各>=5次零额外延迟有效实测且各自成功率>=80%；另审控制权与延迟矩阵。首轮10/10不是准入证明。';
export const STAGE_TWO_PLAN = [
  {
    id: 'stage2-combat-mixed-01', status: 'design-only', category: 'combat', title: '近远程混合敌人与掩体', timeoutMs: 150000,
    mainLayer: '快速战斗/导航与大脑目标选择', gate: STAGE_TWO_GATE,
    initialConditions: ['32x32封闭夜间场地、满血饱食、铁剑1与皮革胸甲1，无食物或建材', '一只成年僵尸、一只持弓骷髅；固定基岩掩体，初始位置和装备写入manifest'],
    successEvidence: ['两个指定目标先活后死，并有本玩家对应的僵尸/骷髅击杀增量', '玩家存活、未出界；记录掩体利用、实际伤害和响应延迟作为诊断'],
    failureEvidence: ['死亡、超时、出界、未经授权物品；仅目标消失或敌人互杀不算胜利'],
    isolation: ['仅一名考生，禁自然刷怪，开题后不治疗或暂停；敌人正常AI，箭矢不能作为另一个敌人重复计数'],
    variants: ['冻结的90度旋转/镜像', '交换近远程敌人方位', '保持可达的掩体间距留出布局'],
  },
  {
    id: 'stage2-retreat-resume-01', status: 'design-only', category: 'survival', title: '有限装备退守后恢复采集', timeoutMs: 180000,
    mainLayer: '大脑风险策略、应急接管与进度恢复', gate: STAGE_TWO_GATE,
    initialConditions: ['满血、food=12、木剑1/木斧1/熟牛肉1，无护甲；六根原木与一处有掩体的退守区', '第一根原木真实入包后注入两只成年僵尸，规则公开、具体触发时刻不提前给候选'],
    successEvidence: ['注入后且威胁未解决前进入退守区至少250ms；真实进食统计、食物减少且饥饿提高', '击杀两只指定敌人；威胁解决后又有原木新入包，最终净获得六根'],
    failureEvidence: ['死亡、超时、出界、超出初始物资；未真正退守或战后没有恢复采集'],
    isolation: ['仅一名考生、关闭自然回血；退守区不是无敌区，裁判不阻挡追敌或补给'],
    variants: ['交换退守区方向', '改变公开物品预算但保持参考可达', '改变原木布局与两名敌人的相对方向'],
  },
  {
    id: 'stage2-parkour-turn-budget-01', status: 'design-only', category: 'parkour', title: '转向连跳与有限材料', timeoutMs: 150000,
    mainLayer: '运动技能组合、空间规划与累计材料预算', gate: STAGE_TWO_GATE,
    initialConditions: ['满血饱食、圆石4，无其他物品；单块平台、转弯和一格登高，外侧不能绕行', '参考脚部检查点：(3.5,64,0.5)、(3.5,64,3.5)、(7.5,64,3.5)、(7.5,65,5.5)，从(.5,64,.5)出发'],
    successEvidence: ['按序在全部检查点落稳至少250ms；至少两次真实跳跃、至少一次真实放置，累计放置<=4', '服务器最终位置、物品消耗与方块状态一致；重试不能补充预算'],
    failureEvidence: ['坠入失败平面、死亡、超时、错序绕行、放置>4或破坏原平台'],
    isolation: ['封闭独立场地，禁外部掉落物和建材补给；所有坐标变体先经真实参考控制器验证'],
    variants: ['整场旋转/镜像', '保持物理可达的缺口长度与转向组合', '冻结的材料预算边界实例'],
  },
  {
    id: 'stage2-furnace-container-01', status: 'design-only', category: 'crafting', title: '从容器取料、熔炼再制作', timeoutMs: 180000,
    mainLayer: '大脑工序规划、容器/库存确认与异步等待', gate: STAGE_TWO_GATE,
    initialConditions: ['考生空背包，源箱恰有粗铁3/煤炭1/木棍2；空熔炉、工作台与空目标箱各1', '设施位置、朝向、距离固定记录，场内没有铁锭或铁镐及额外矿物'],
    successEvidence: ['源箱扣料、炉内原矿消耗/产铁与燃料消耗有服务器时序证据', '本玩家合成铁镐统计增加，最终目标箱真实新增铁镐1；容器、背包、掉落物总账守恒'],
    failureEvidence: ['死亡、超时、非法补给/破坏设施、错误成品或只说已存入；证据不足单列infra-error'],
    isolation: ['仅一名考生，炉火继续按游戏tick运行；禁止快进、替候选取产物或裁判填充目标箱'],
    variants: ['交换设施位置与朝向', '公开替换等价燃料及预算', '留出容器间距和多段工序布局'],
  },
  {
    id: 'stage2-death-stale-plan-01', status: 'design-only', category: 'lifecycle', title: '死亡后新授权与迟到旧规划', timeoutMs: 120000,
    mainLayer: '大脑控制权、生命周期与取消收尾', gate: STAGE_TWO_GATE,
    initialConditions: ['安全封闭场地、原目标为移动；固定复活点、keepInventory=false', '可信runner在原目标执行且一个携带旧version的模型回复被延迟时注入一次公开约定的死亡；重生后等待新授权'],
    successEvidence: ['服务器死亡统计恰好+1并真实重生；旧目标/旧回复被拒绝且未恢复输入', '新观察后的显式授权成功，NPC抵达新目标；任意时刻该NPC最多一个native owner'],
    failureEvidence: ['第二次死亡、超时、旧版本接受、停止确认后旧操作重新发出输入、重生后无新授权却自主恢复'],
    isolation: ['独立生命周期题，不能套用一期死亡即失败；只允许声明的一次死亡注入，重生后不传送或补给'],
    variants: ['固定延迟2/10/20秒', '旧回复在重生前后到达', '同一等待步骤的人工stop与TTL到期控制变体'],
  },
  {
    id: 'stage2-coop-handoff-01', status: 'design-only', category: 'cooperation', title: '两NPC资源交接与共同制作', timeoutMs: 180000,
    mainLayer: '多脑协商、私有记忆隔离与物品交接', gate: STAGE_TWO_GATE,
    initialConditions: ['仅A/B两名考生，满血饱食；A背包铁锭3，B背包木棍2，无其他资源', '相隔8格、真实通信范围内；共享工作台、空交接箱和空目标箱；共同目标为制作并交付铁镐1'],
    successEvidence: ['至少一次真实跨玩家物资流转：双方背包与交接箱/掉落实体的服务器时序相互印证', '参与者合成铁镐统计增加且目标箱新增铁镐1；双方存活、总账守恒，无重复计入或同时占有'],
    failureEvidence: ['任一死亡、超时、额外物资、重复记账、仅口头承诺没有交付；不得读取对方私有记忆或隐形背包'],
    isolation: ['每人独立模型上下文/记忆/授权/身体，裁判全知不进入任一NPC上下文；禁旁观者帮助和全局共享计划'],
    variants: ['互换资源持有者与出生方位', '移动交接箱或使用真实丢弃拾取', '只延迟一个模型10秒，验证另一个仍能行动'],
  },
] as const;
