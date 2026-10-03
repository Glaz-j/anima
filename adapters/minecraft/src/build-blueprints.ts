export type BuildKind = 'village-house' | 'railed-bridge' | 'courtyard-wall' | 'watchtower' | 'workshop' | 'garden-pavilion';
export type BuildCell = { x: number; y: number; z: number; item: string; phase: string };
export type BuildBlueprint = { kind: BuildKind; title: string; blocks: BuildCell[]; clear: {x:number;y:number;z:number}[];
  access: {x:number;y:number;z:number}[]; materials: Record<string,number>; bounds: {min:{x:number;y:number;z:number};max:{x:number;y:number;z:number}} };
export const BUILD_KINDS: readonly BuildKind[] = ['village-house','railed-bridge','courtyard-wall','watchtower','workshop','garden-pavilion'];
export const BUILD_PALETTES = Object.freeze({ oak: {base:'cobblestone',wood:'oak_planks',trim:'oak_log',glass:'glass'}, spruce:{base:'stone_bricks',wood:'spruce_planks',trim:'spruce_log',glass:'glass'} });
export const BUILD_LIMITS = Object.freeze({ blocks:512, sliceBlocks:12, sliceMs:45000, radius:24, height:10 });

/** Blueprint knowledge only; does not read terrain or any actor's inventory. */
export function describeBuild(options:any) {
  const plan=compileBuild(options.blueprint,options);
  return {blueprint:plan.kind,title:plan.title,origin:options.origin??{x:0,y:64,z:0},rotation:options.rotation??0,palette:options.palette??'oak',
    materials:plan.materials,blocks:plan.blocks.length,bounds:plan.bounds,access:plan.access,
    reservedAirCells:plan.clear.length,terrainVerified:false,inventoryVerified:false,
    requirements:'准备有真实支撑且蓝图目标为空的工地；保留室内与门洞。所有材料由自己的生存背包提供。origin是地基方块坐标，站立高度通常为origin.y+1。冲突方块不会自动拆除。',
    limits:BUILD_LIMITS};
}

/** Public, finite architectural plans. No world reads or privileged commands. */
export function compileBuild(kind: BuildKind, options: {origin?:{x:number;y:number;z:number};rotation?:number;palette?:keyof typeof BUILD_PALETTES} = {}): BuildBlueprint {
  if(!BUILD_KINDS.includes(kind))throw new Error('Unknown building template');
  const origin=options.origin??{x:0,y:64,z:0}, rotation=options.rotation??0, p=BUILD_PALETTES[options.palette??'oak'];
  if(!p||![0,90,180,270].includes(rotation)||!['x','y','z'].every(k=>Number.isSafeInteger(origin[k as keyof typeof origin]))||Math.abs(origin.x)>29999960||Math.abs(origin.z)>29999960||origin.y< -54||origin.y>300)throw new Error('Invalid build origin, rotation or palette');
  const cells=new Map<string,BuildCell>(), empty=new Map<string,{x:number;y:number;z:number}>(), access:{x:number;y:number;z:number}[]=[];
  const key=(x:number,y:number,z:number)=>`${x},${y},${z}`;
  const add=(x:number,y:number,z:number,item:string,phase:string)=>{const k=key(x,y,z);if(empty.has(k))throw new Error('Plan fills reserved passage');cells.set(k,{x,y,z,item,phase});};
  const air=(x:number,y:number,z:number)=>{if(cells.has(key(x,y,z)))throw new Error('Plan obstructs reserved passage');empty.set(key(x,y,z),{x,y,z});};
  const floor=(w:number,d:number,item=p.base)=>{for(let x=0;x<w;x++)for(let z=0;z<d;z++)add(x,0,z,item,'foundation');};
  const ramp=(z:number,height:number)=>{for(let x=0;x<=height;x++){for(let y=0;y<=x;y++)add(x,y,z,p.base,'access');access.push({x:x+.5,y:x+1,z:z+.5});}};
  let title='';
  if(kind==='village-house'){
    title='村庄小屋：石基、木墙、窗户、入口与山墙屋顶';floor(7,7);
    for(let y=1;y<=2;y++)for(let x=0;x<7;x++)for(let z=0;z<7;z++)if(x===0||x===6||z===0||z===6){
      if(z===0&&x===3){air(x,y,z);continue;}
      const window=y===2&&((x===0||x===6)&&z===3||z===6&&x===3);
      add(x,y,z,window?p.glass:(x===0||x===6)&&(z===0||z===6)?p.trim:p.wood,'walls');
    }
    for(let x=1;x<6;x++)for(let z=1;z<6;z++)for(let y=1;y<=2;y++)air(x,y,z);
    for(let y=3;y<=6;y++)for(let x=y-3;x<=9-y;x++)for(let z=0;z<7;z++)add(x,y,z,p.wood,'roof');
    // Permanent rear maintenance stair, not a teleport or temporary scaffold.
    ramp(7,5);add(5,5,6,p.wood,'roof');access.push({x:3.5,y:1,z:.5},{x:3.5,y:1,z:3.5});
  }else if(kind==='railed-bridge'){
    title='景观桥：九格跨度、三格桥面、护栏和桥头柱';floor(3,9,p.wood);
    for(let z=0;z<9;z++)for(const x of [0,2])add(x,1,z,p.base,'rails');
    for(const x of [0,2])for(const z of [0,8])add(x,2,z,p.trim,'posts');
    for(let z=0;z<9;z++){air(1,1,z);air(1,2,z);access.push({x:1.5,y:1,z:z+.5});}
  }else if(kind==='courtyard-wall'){
    title='庭院围墙：石墙、门洞、城垛和角柱';floor(9,9);
    for(let y=1;y<=2;y++)for(let x=0;x<9;x++)for(let z=0;z<9;z++)if(x===0||x===8||z===0||z===8){if(z===0&&[4,5].includes(x)){air(x,y,z);continue;}add(x,y,z,p.base,'walls');}
    for(let i=0;i<9;i+=2)for(const [x,z] of [[i,0],[i,8],[0,i],[8,i]])add(x,3,z,p.base,'battlements');
    add(4,3,0,p.wood,'gate');add(5,3,0,p.wood,'gate');
    ramp(9,2); // Permanent access to the wall walk and battlements.
    for(let x=1;x<8;x++)for(let z=1;z<8;z++)for(let y=1;y<=2;y++)air(x,y,z);
    access.push({x:4.5,y:1,z:.5},{x:4.5,y:1,z:4.5});
  }else if(kind==='watchtower'){
    title='瞭望塔：高柱、观景平台、护栏与登塔阶梯';floor(5,5);
    for(const x of [0,4])for(const z of [0,4])for(let y=1;y<=5;y++)add(x,y,z,p.trim,'columns');
    for(let x=0;x<5;x++)for(let z=0;z<5;z++)add(x,5,z,p.wood,'platform');
    for(let x=0;x<5;x++)for(let z=0;z<5;z++)if(x===0||x===4||z===0||z===4){if(z===4&&x===4)continue;add(x,6,z,p.base,'rails');}
    ramp(5,4);access.push({x:2.5,y:6,z:2.5});
  }else if(kind==='workshop'){
    title='开放工坊：石地坪、立柱、木顶和工作台';floor(7,5);
    for(const x of [0,6])for(const z of [0,4])for(let y=1;y<=2;y++)add(x,y,z,p.trim,'columns');
    for(let x=0;x<7;x++)for(let z=0;z<5;z++)add(x,3,z,p.wood,'roof');
    add(1,1,3,'crafting_table','furniture');add(5,1,3,'furnace','furniture');ramp(5,2);
    for(let x=1;x<6;x++)for(let y=1;y<=2;y++)air(x,y,0);access.push({x:3.5,y:1,z:2.5});
  }else{
    title='花园凉亭：石台、四柱、挑檐顶和开放通道';floor(5,5);
    for(const x of [0,4])for(const z of [0,4])for(let y=1;y<=2;y++)add(x,y,z,p.trim,'columns');
    for(let x=-1;x<=5;x++)for(let z=-1;z<=5;z++)add(x,3,z,p.wood,'roof');
    for(let x=0;x<5;x++)for(let z=0;z<5;z++)add(x,4,z,p.wood,'roof');ramp(6,3);
    for(let y=1;y<=2;y++)for(let z=0;z<5;z++)air(2,y,z);access.push({x:2.5,y:1,z:2.5});
  }
  const transform=(v:{x:number;y:number;z:number})=>{const [x,z]=rotation===90?[-v.z,v.x]:rotation===180?[-v.x,-v.z]:rotation===270?[v.z,-v.x]:[v.x,v.z];return {x:origin.x+x,y:origin.y+v.y,z:origin.z+z};};
  const blocks=[...cells.values()].sort((a,b)=>a.y-b.y||a.z-b.z||a.x-b.x).map(v=>({...v,...transform(v)}));
  if(blocks.length>BUILD_LIMITS.blocks)throw new Error('Building exceeds block limit');
  const materials:Record<string,number>={};for(const b of blocks)materials[b.item]=(materials[b.item]??0)+1;
  const bounds={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
  for(const b of blocks)for(const k of ['x','y','z'] as const){bounds.min[k]=Math.min(bounds.min[k],b[k]);bounds.max[k]=Math.max(bounds.max[k],b[k]);}
  const transformStanding=(v:{x:number;y:number;z:number})=>{const t=transform({...v,x:v.x-.5,z:v.z-.5});return {...t,x:t.x+.5,z:t.z+.5};};
  return {kind,title,blocks,clear:[...empty.values()].map(transform),access:access.map(transformStanding),materials,bounds};
}
