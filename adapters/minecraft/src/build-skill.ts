import { Vec3 } from 'vec3';
import { compileBuild, BUILD_KINDS, BUILD_PALETTES, BUILD_LIMITS, type BuildKind, type BuildCell } from './build-blueprints.ts';
import { checkSignal, runNativeAction, haltNative, nativeWalkTo, placementFace } from './native-actions.ts';
import { planBuildRoute } from './build-navigation.ts';
import { runBridgeSkill, BRIDGE_MATERIALS } from './bridge-skill.ts';
import { assertInventorySessionUsable, synchronizeServerQueue } from './craft-sync.ts';
import { setTimeout as delay } from 'node:timers/promises';

export type BuildAction = {type:'build';blueprint:BuildKind;origin:{x:number;y:number;z:number};rotation?:number;palette?:keyof typeof BUILD_PALETTES;batchBlocks?:number};
const AIR=new Set(['air','cave_air','void_air']);
const HAZARDS=new Set(['lava','water','fire','soul_fire','magma_block','cactus','campfire','powder_snow']);
const point=(v:{x:number;y:number;z:number})=>new Vec3(v.x,v.y,v.z);
const failure=(code:string,message:string,details:any={})=>Object.assign(new Error(message),{details:{...details,stoppedReason:code}});
export function validateBuild(raw:any):BuildAction {
  if(!raw||raw.type!=='build'||!BUILD_KINDS.includes(raw.blueprint))throw new Error('build requires a known blueprint');
  if(!raw.origin)throw new Error('build requires explicit foundation coordinates');
  compileBuild(raw.blueprint,{origin:raw.origin,rotation:raw.rotation,palette:raw.palette});
  const batchBlocks=raw.batchBlocks??BUILD_LIMITS.sliceBlocks;
  if(!Number.isInteger(batchBlocks)||batchBlocks<1||batchBlocks>BUILD_LIMITS.sliceBlocks)throw new Error('build batchBlocks must be1–12');
  return {type:'build',blueprint:raw.blueprint,origin:{x:raw.origin.x,y:raw.origin.y,z:raw.origin.z},rotation:raw.rotation??0,palette:raw.palette??'oak',batchBlocks};
}

/** Server-synchronized bounded construction. Each resumed slice derives progress
 * from loaded blocks, so interruptions cannot duplicate already finished cells. */
export async function runBuildSkill(bot:any, raw:BuildAction, signal:AbortSignal, emit:(type:string,data:any)=>void=()=>{}) {
  const action=validateBuild(raw), plan=compileBuild(action.blueprint,action);
  assertInventorySessionUsable(bot);checkSignal(signal);
  if(bot.game?.gameMode!=='survival')throw failure('not_survival','建筑施工要求真实生存物品消耗。');
  const owner=bot.entity, own=new AbortController(), active=AbortSignal.any([signal,own.signal]);
  const details:any={blueprint:action.blueprint,total:plan.blocks.length,matched:0,placed:0,reached:false,inventoryConfirmed:true,placements:[],missingMaterials:{}};
  const stop=()=>{try{haltNative(bot);}catch{}};
  let sliceExpired=false;
  const timer=setTimeout(()=>{sliceExpired=true;own.abort(new Error('建筑施工时间片结束。'));},BUILD_LIMITS.sliceMs);
  const lost=()=>own.abort(new Error('施工身体失效。'));
  for(const event of ['death','respawn','end','kicked'])bot.on(event,lost);
  active.addEventListener('abort',stop,{once:true});
  const get=(v:Vec3)=>{
    const b=bot.blockAt(v);
    if(!b)throw failure('build_unknown_cell','施工范围有未加载地形；需要重新观察。',{cell:{...v}});
    return b;
  };
  const check=()=>{
    checkSignal(active);
    if(bot.entity!==owner)throw failure('body_replaced','施工身体已更换。');
    if(Math.hypot(bot.entity.position.x-action.origin.x,bot.entity.position.z-action.origin.z)>BUILD_LIMITS.radius)
      throw failure('build_range_limit','身体越过建筑施工范围。');
  };
  const inventory=(item:string)=>bot.inventory.items().filter((s:any)=>s.name===item).reduce((n:number,s:any)=>n+s.count,0);
  const settle=async()=>{
    // A failed walk may leave the body partway through a jump. Never seed a
    // new collision route from that transient air cell.
    stop();const until=Date.now()+2000;
    while(bot.entity.onGround!==true){check();if(Date.now()>until)throw failure('build_unsettled','施工身体尚未稳定着地，请重新观察。');await delay(50,undefined,{signal:active});}
  };
  const refresh=()=>{
    check();const pending:BuildCell[]=[];details.matched=0;details.missingMaterials={};
    for(const c of plan.blocks){const block=get(point(c));if(block.name===c.item){details.matched++;continue;}
      if(!AIR.has(block.name))throw failure('build_conflict','蓝图位置已有不同方块，施工不会自动拆除。',{cell:c,actual:block.name});
      pending.push(c);details.missingMaterials[c.item]=(details.missingMaterials[c.item]??0)+1;
    }
    return pending;
  };
  const supports=(c:BuildCell)=>[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>{
    const b=bot.blockAt(point(c).offset(x,y,z));return b?.boundingBox==='block'&&!HAZARDS.has(b.name);
  });
  function stances(c:BuildCell){
    const result:Vec3[]=[];
    for(let x=c.x-3;x<=c.x+3;x++)for(let z=c.z-3;z<=c.z+3;z++)for(let y=Math.max(action.origin.y-1,c.y-4);y<=c.y+1;y++){
      const floor=bot.blockAt(new Vec3(x,y-1,z)),feet=bot.blockAt(new Vec3(x,y,z)),head=bot.blockAt(new Vec3(x,y+1,z));
      if(!floor||floor.boundingBox!=='block'||HAZARDS.has(floor.name)||!feet||!head||!AIR.has(feet.name)||!AIR.has(head.name))continue;
      const p=new Vec3(x+.5,y,z+.5);
      if(p.offset(0,1.62,0).distanceTo(point(c).offset(.5,.5,.5))>4.15)continue;
      if(Math.hypot(p.x-action.origin.x,p.z-action.origin.z)>BUILD_LIMITS.radius)continue;
      if(x===c.x&&z===c.z&&(y===c.y||y+1===c.y))continue;
      if(!placementFace(bot,point(c),p))continue;
      result.push(p);
    }
    return result.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position));
  }
  function edgeStances(c:BuildCell){
    if(!(BRIDGE_MATERIALS as readonly string[]).includes(c.item))return [];
    return [[1,0],[-1,0],[0,1],[0,-1]].flatMap(([x,z])=>{
      const reference=point(c).offset(x,0,z),block=bot.blockAt(reference);
      if(block?.boundingBox!=='block'||HAZARDS.has(block.name))return [];
      if(!AIR.has(bot.blockAt(reference.offset(0,1,0))?.name)||!AIR.has(bot.blockAt(reference.offset(0,2,0))?.name))return [];
      return [reference.offset(.5,1,.5)];
    });
  }
  try{
    let pending=refresh();
    while(pending.length&&details.placed<action.batchBlocks!){
      check();let placed=false,lastError:any;
      // Build the permanent access first, then prefer interior fixtures and
      // lower structural work. A high reachable support can unlock a platform
      // even while a remote lower column is still out of reach.
      const priority=(c:BuildCell)=>c.phase==='access'?0:c.phase==='foundation'?1:c.phase==='furniture'?2:3;
      const layer=[...pending].sort((a,b)=>priority(a)-priority(b)||a.y-b.y||a.z-b.z||a.x-b.x);
      for(const c of layer){
        if(!supports(c))continue;
        if(!inventory(c.item))throw failure('build_missing_material','缺少本层所需建筑材料，请补给后续建。',{item:c.item,needed:details.missingMaterials[c.item]});
        const edges=edgeStances(c),edgeKeys=new Set(edges.map(p=>p.toString()));
        let candidates=[...stances(c),...edges];
        if(!candidates.length&&!placementFace(bot,point(c)))continue;
        for(let attempt=0;attempt<9;attempt++){
          check();
          try{
            let useEdge=false;
            if(attempt>0){
              await settle();
              const path=planBuildRoute(bot,candidates,action.origin);
              if(!path)break;
              candidates=candidates.filter(p=>!p.equals(path.destination));
              for(const waypoint of path.route){check();await nativeWalkTo(bot,waypoint,active,.25);}
              useEdge=edgeKeys.has(path.destination.toString());
            }
            check();
            if(useEdge){
              // Reuse the existing body-owned peek/place/walk motor for exactly
              // this blueprint cell. It cannot place an unplanned scaffold.
              const result=await runBridgeSkill(bot,{type:'bridge',x:c.x+.5,z:c.z+.5,item:c.item,maxBlocks:1,
                origin:{...bot.entity.position}},active,emit);
              if(result.placed!==1||result.spent!==1||!result.inventoryConfirmed)throw failure('build_unconfirmed','未确认一块蓝图桥面及其物品消耗。');
            }else await runNativeAction(bot,{type:'place',x:c.x,y:c.y,z:c.z,item:c.item},active,emit);
            check();if(get(point(c)).name!==c.item)throw failure('build_unconfirmed','放置后的真实方块与蓝图不一致。');
            details.placed++;details.matched++;details.placements.push(c);
            if(--details.missingMaterials[c.item]===0)delete details.missingMaterials[c.item];
            // Vanilla block acknowledgement can precede slot updates. Drain
            // the server queue before checking materials for the next cell.
            try { await synchronizeServerQueue(bot); } catch(e:any) { details.inventoryConfirmed=false;throw e; }
            check();emit('build-progress',{blueprint:action.blueprint,placed:details.placed,cell:c});placed=true;break;
          }catch(e:any){check();assertInventorySessionUsable(bot);lastError=e;}
        }
        if(placed)break;
      }
      if(!placed)throw failure('build_unreachable','本层没有可确认的施工站位或附着面，请重新规划。',{cause:String(lastError?.message??'no_support'),movement:lastError?.details?.movement,layer:pending[0].y});
      pending=refresh();
    }
    if(pending.length===0){
      for(const c of plan.clear){if(!AIR.has(get(point(c)).name))throw failure('build_passage_blocked','建筑通道或室内空间被占用。',{cell:c});}
      details.reached=true;
    }
    details.stoppedReason=details.reached?'build_complete':'build_slice_complete';return details;
  }catch(error:any){
    if(sliceExpired&&!signal.aborted&&bot.entity===owner&&details.placed>0&&details.inventoryConfirmed){
      assertInventorySessionUsable(bot);
      details.reached=false;details.stoppedReason='build_slice_time_limit';return details;
    }
    error.details={...details,...error.details};throw error;
  }
  finally{clearTimeout(timer);active.removeEventListener('abort',stop);for(const event of ['death','respawn','end','kicked'])bot.removeListener(event,lost);stop();}
}
