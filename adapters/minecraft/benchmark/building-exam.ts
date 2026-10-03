import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {loadExamServer} from './server.ts';
import {VanillaExamAdapter} from './adapter.ts';
import {LocalRcon} from './rcon.ts';
import {captureExamSource} from './runner.ts';
import {MinecraftWorld} from '../src/world.ts';
import {compileBuild,BUILD_KINDS,type BuildKind} from '../src/build-blueprints.ts';
import {runTask} from '../src/llm.ts';
import type {ExamTask,ExamSourceIdentity} from './types.ts';

type BuildingExamSpec={id:string;blueprint:BuildKind;palette:'oak'|'spruce';rotation:number;timeoutMs:number;terrain?:'water-gap'};
export const BUILDING_EXAMS:BuildingExamSpec[] = [...BUILD_KINDS.flatMap(kind=>[
  {id:`build-${kind}-oak-01`,blueprint:kind,palette:'oak' as const,rotation:0,timeoutMs:900000},
  {id:`build-${kind}-spruce-rotated-01`,blueprint:kind,palette:'spruce' as const,rotation:90,timeoutMs:900000},
]),
  {id:'build-river-bridge-oak-01',blueprint:'railed-bridge',palette:'oak',rotation:0,timeoutMs:900000,terrain:'water-gap'},
  {id:'build-river-bridge-spruce-rotated-01',blueprint:'railed-bridge',palette:'spruce',rotation:90,timeoutMs:900000,terrain:'water-gap'},
];
export function buildingExamTask(id:string):ExamTask {
  const spec=BUILDING_EXAMS.find(t=>t.id===id);if(!spec)throw new Error('Unknown building exam');
  const origin={x:spec.rotation===90?2:-5,y:64,z:-5};
  const plan=compileBuild(spec.blueprint,{origin,palette:spec.palette,rotation:spec.rotation});
  const inventory=Object.entries(plan.materials).flatMap(([item,n])=>{const result:{item:string;count:number}[]=[];while(n>0){result.push({item,count:Math.min(n,64)});n-=64;}return result;});
  // A broad moat prevents building the whole bridge from a nearby side bank.
  const gap=spec.rotation===90?{from:{x:plan.bounds.min.x,y:63,z:plan.bounds.min.z-4},to:{x:plan.bounds.max.x,y:63,z:plan.bounds.max.z+4}}
    :{from:{x:plan.bounds.min.x-4,y:63,z:plan.bounds.min.z},to:{x:plan.bounds.max.x+4,y:63,z:plan.bounds.max.z}};
  const banks=spec.rotation===90?
    [gap.from.x-1,gap.to.x+1].map(x=>({from:{x,y:64,z:gap.from.z},to:{x,y:64,z:gap.to.z},block:'bedrock'})):
    [gap.from.z-1,gap.to.z+1].map(z=>({from:{x:gap.from.x,y:64,z},to:{x:gap.to.x,y:64,z},block:'bedrock'}));
  const terrain=spec.terrain==='water-gap'?[{from:{...gap.from,y:62},to:{...gap.to,y:62},block:'bedrock'},{...gap,block:'water'},...banks]:[];
  return {id,revision:1,stage:2,category:'construct',title:plan.title,
    instruction:`建造${plan.title}。使用build蓝图${spec.blueprint}，地基origin=${JSON.stringify(origin)}，rotation=${spec.rotation}，palette=${spec.palette}。${spec.terrain==='water-gap'?'桥面下方是九格水沟，需要从岸边逐步延伸真实桥面。':''}材料已经放入生存背包：${JSON.stringify(plan.materials)}。所有目标方块、房间与门洞都必须完成；不能以接受计划或放了一部分方块宣称完成。`,
    timeoutMs:spec.timeoutMs,required:['isolated-world','server-player-nbt','server-blocks'],spawn:{x:-10.5,y:64,z:-9.5},inventory,terrain,enemies:[],checkpoints:[],objective:{}};
}

/** Separate suite: these tasks do not silently change the frozen ten-task
 * survival exam or pretend a reference executor is model planning ability. */
export async function runBuildingExam(root:string,id:string,mode:'skill'|'agent'='skill',loadedSource?:ExamSourceIdentity) {
  const config=await loadExamServer(root);
  if(config.gamePort!==25575||config.rconPort!==25585)throw new Error('Building exams require the marked25575/25585 arena.');
  const spec=BUILDING_EXAMS.find(t=>t.id===id);if(!spec)throw new Error('Unknown building exam');
  const task=buildingExamTask(id), origin={x:spec.rotation===90?2:-5,y:64,z:-5};
  const plan=compileBuild(spec.blueprint,{origin,palette:spec.palette,rotation:spec.rotation});
  const runId='build-exam-'+randomUUID(),directory=join(root,'var/minecraft/build-exam',runId);
  await mkdir(directory,{recursive:true});const source=loadedSource??await captureExamSource(root);
  const world=new MinecraftWorld({host:'127.0.0.1',port:config.gamePort,version:config.version,logDirectory:join(directory,'candidate-events'),dualLoop:true});
  world.memoryNamespace=runId;
  const actor='BuildExam',record=world.add(actor,'你是生存模式的建筑师。只通过自己的身体与背包施工，诚实报告部分完成和失败。');
  const controller=new AbortController(),signal=controller.signal;
  const adapter=new VanillaExamAdapter(config),judge=new LocalRcon();
  let startedAt:number|undefined, modelError=false,agentJob:Promise<unknown>|undefined;
  const interrupt=()=>controller.abort(new Error('Building exam interrupted'));process.once('SIGINT',interrupt);
  const serverBlocks=async()=>{
    const missing:any[]=[],blockedPassages:any[]=[];
    for(const c of plan.blocks){signal.throwIfAborted();const answer=await judge.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:${c.item}`);if(!/Test passed/u.test(answer))missing.push(c);}
    for(const c of plan.clear){signal.throwIfAborted();const answer=await judge.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`);if(!/Test passed/u.test(answer))blockedPassages.push(c);}
    return {matched:plan.blocks.length-missing.length,total:plan.blocks.length,missing,blockedPassages};
  };
  const save=(name:string,value:any)=>writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n');
  try{
    const joinDeadline=Date.now()+30000;
    while(!record.ready||!record.inventorySynced){if(record.error||Date.now()>joinDeadline)throw new Error('Exam candidate failed to join');await delay(100);}
    const initial=await adapter.prepare(task,actor,signal);
    await judge.connect(config.rconPort,config.rconPassword);
    const initialBlocks=await serverBlocks();if(initialBlocks.matched!==0||initialBlocks.blockedPassages.length)throw new Error('Invalid building arena baseline');
    await save('manifest.json',{schemaVersion:1,runId,taskId:id,mode,source,serverId:config.serverId,gamePort:config.gamePort,task,blueprint:plan,initial,initialBlocks});
    await delay(300);startedAt=Date.now();
    const step={type:'build',blueprint:spec.blueprint,origin,palette:spec.palette,rotation:spec.rotation};
    if(mode==='skill')record.body!.submit({expectedVersion:record.body!.snapshot().version,steps:[step],reactions:['surface','eat','defend','flee'],ttlMs:300000,label:task.instruction});
    else agentJob=(async()=>{while(!signal.aborted){const result=await runTask(world,actor,task.instruction,root,{signal,bodyExecution:'dual',throughputOptimizations:true,worldId:runId});if(result.reason==='error'){modelError=true;break;}await delay(500,undefined,{signal});}})().catch(e=>{if(!signal.aborted)modelError=true;});
    let status='failed',reason='timeout',lastSample=initial,lastStatus:any,renewedAt=Date.now();
    const motion:any[]=[];
    try { while(Date.now()-startedAt<task.timeoutMs&&!signal.aborted){
      lastSample=await adapter.sample(signal);lastStatus=record.body!.snapshot();
      motion.push({time:Date.now(),position:{...record.bot.entity.position},velocity:{...record.bot.entity.velocity},onGround:record.bot.entity.onGround,
        controls:Object.fromEntries(['forward','back','left','right','jump','sneak'].map(k=>[k,record.bot.getControlState(k)]))});
      if(lastSample.actor.health<=0){reason='death';break;}
      if(modelError){status='infra-error';reason='model-error';break;}
      if(lastStatus.workCompleted){const evidence=await serverBlocks();await save('server-blocks.json',evidence);if(evidence.missing.length===0&&evidence.blockedPassages.length===0){status='passed';reason='server-confirmed-complete';}else reason='false-completion';break;}
      if(mode==='skill'&&lastStatus.replanRequired){reason=lastStatus.replanRequired.code;break;}
      if(mode==='skill'&&Date.now()-renewedAt>60000){record.body!.submit({expectedVersion:lastStatus.version,steps:[step],reactions:['surface','eat','defend','flee'],ttlMs:300000,label:task.instruction});renewedAt=Date.now();}
      await delay(500,undefined,{signal});
    } } catch(error) {
      status=signal.aborted?'cancelled':'infra-error';reason=signal.aborted?'interrupted':'sampling-error';
    }
    if(signal.aborted){status='cancelled';reason='interrupted';}
    controller.abort();await world.stop(record);await agentJob;
    await save('motion.json',motion);
    // Judge reads after stop do not change the world. Never heal, refill or place
    // expected cells during the scored trial.
    const finalSignal=new AbortController().signal;
    const final=await adapter.sample(finalSignal);
    const truth={matched:0,total:plan.blocks.length,missing:[] as any[],blockedPassages:[] as any[]};
    for(const c of plan.blocks){const answer=await judge.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:${c.item}`);if(/Test passed/u.test(answer))truth.matched++;else truth.missing.push(c);}
    for(const c of plan.clear){const answer=await judge.command(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`);if(!/Test passed/u.test(answer))truth.blockedPassages.push(c);}
    const materialAccounting=Object.fromEntries(Object.entries(plan.materials).map(([item,expected])=>[item,{expected,
      consumed:(initial.actor.inventory[item]??0)-(final.actor.inventory[item]??0)}]));
    if(status==='passed'&&Object.values(materialAccounting).some(v=>v.expected!==v.consumed)){status='failed';reason='material-accounting-mismatch';}
    const result={schemaVersion:1,runId,taskId:id,mode,execution:'real-server',source,status,reason,elapsedMs:Date.now()-startedAt,coverage:truth.matched/truth.total,serverEvidence:truth,materialAccounting,initialInventory:initial.actor.inventory,finalInventory:final.actor.inventory,damageTaken:final.statistics.damage-initial.statistics.damage,deaths:final.statistics.deaths-initial.statistics.deaths,finalControl:lastStatus};
    await save('result.json',result);console.log(JSON.stringify({runId,taskId:id,mode,status,reason,coverage:result.coverage,elapsedMs:result.elapsedMs,directory}));return result;
  }finally{controller.abort();await world.stop(record).catch(()=>{});await agentJob;world.close();await adapter.cleanup().catch(()=>{});adapter.close();judge.close();process.removeListener('SIGINT',interrupt);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),command=process.argv[2]??'list';
  if(command==='list')console.log(JSON.stringify(BUILDING_EXAMS.map(t=>({...t,materials:compileBuild(t.blueprint,{palette:t.palette}).materials})),null,2));
  else if(command==='run'){
    const option=(k:string,fallback:string)=>{const i=process.argv.indexOf('--'+k);return i<0?fallback:process.argv[i+1];};
    const mode=option('mode','skill');if(!['skill','agent'].includes(mode))throw new Error('Mode must be skill or agent');
    const ids=option('task','build-railed-bridge-oak-01');
    // A batch imports one executable revision. Later worktree edits cannot
    // relabel already-loaded modules as a newer implementation.
    const loadedSource=await captureExamSource(root);
    for(const id of ids==='all'?BUILDING_EXAMS.map(t=>t.id):ids.split(',')){const result=await runBuildingExam(root,id,mode as any,loadedSource);if(result.status!=='passed')process.exitCode=1;}
  }else throw new Error('Commands: list, run --task ID|all --mode skill|agent');
}
