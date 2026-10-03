/** Original classic-arm Minecraft skins. Deterministic UV painting, no external assets. */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../../adapters/minecraft/viewer/skins/', import.meta.url));
const skins = [
  { name: 'Sheldon', skin: '#e9b78f', hair: '#422d26', shirt: '#346c43', trousers: '#654536', shoes: '#292d30', accent: '#f5db75' },
  { name: 'Sherlock', skin: '#e1b698', hair: '#261e1d', shirt: '#2d3440', trousers: '#252832', shoes: '#18191f', accent: '#9f674d' },
  { name: 'Deadpool', skin: '#a82e39', hair: '#932b36', shirt: '#b63140', trousers: '#9c2633', shoes: '#252731', accent: '#232530' },
  { name: 'HuYifei', skin: '#f2c49f', hair: '#25202c', shirt: '#dfd8c4', trousers: '#344151', shoes: '#743438', accent: '#bd4655' },
];
const rgba = hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)).concat(255);
function png(width,height,pixels) {
  function chunk(type,data) {
    const name=Buffer.from(type), payload=Buffer.concat([name,data]);let crc=0xffffffff;
    for(const byte of payload){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const size=Buffer.alloc(4),tail=Buffer.alloc(4);size.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,payload,tail]);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)pixels.copy(rows,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
await mkdir(directory,{recursive:true});
for(const s of skins){
  const pixels=Buffer.alloc(64*64*4);
  function rect(x,y,w,h,color){const c=rgba(color);for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){const i=((y+dy)*64+x+dx)*4;c.forEach((v,k)=>pixels[i+k]=v);}}
  function part(u,v,w,h,d,color){rect(u+d,v,w,d,color);rect(u+d+w,v,w,d,color);rect(u,v+d,2*(w+d),h,color);}
  part(0,0,8,8,8,s.skin);part(16,16,8,12,4,s.shirt);
  for(const [u,v] of [[40,16],[32,48]]){part(u,v,4,12,4,s.shirt);rect(u,v+12,16,4,s.skin);}
  for(const [u,v] of [[0,16],[16,48]]){part(u,v,4,12,4,s.trousers);rect(u,v+13,16,3,s.shoes);}
  rect(8,0,8,8,s.hair);rect(0,8,32,2,s.hair);rect(24,10,8,6,s.hair);
  rect(9,11,2,1,'#ffffff');rect(13,11,2,1,'#ffffff');rect(10,11,1,1,'#293747');rect(13,11,1,1,'#293747');rect(11,14,2,1,'#9c6758');
  rect(20,30,8,2,s.trousers);
  if(s.name==='Sheldon'){rect(23,22,2,5,s.accent);rect(22,25,2,2,s.accent);rect(24,23,2,2,s.accent);rect(20,20,8,1,'#d2c7b6');}
  if(s.name==='Sherlock'){rect(20,20,2,10,'#242a34');rect(26,20,2,10,'#242a34');rect(22,20,4,2,s.accent);rect(24,22,2,5,s.accent);rect(23,28,1,1,'#b3ac9f');}
  if(s.name==='Deadpool'){rect(8,10,3,4,s.accent);rect(13,10,3,4,s.accent);rect(9,11,2,1,'#eeeeef');rect(13,11,2,1,'#eeeeef');rect(20,20,2,10,s.accent);rect(26,20,2,10,s.accent);rect(20,28,8,2,s.accent);rect(23,29,2,1,'#d8a26b');}
  if(s.name==='HuYifei'){rect(8,8,8,2,s.hair);rect(8,10,1,6,s.hair);rect(15,10,1,6,s.hair);rect(22,20,4,10,s.accent);rect(22,20,1,3,'#ffffff');rect(25,20,1,3,'#ffffff');}
  await writeFile(directory+s.name+'.png',png(64,64,pixels));
}
await writeFile(directory+'manifest.json',JSON.stringify({format:'Minecraft Java classic 64x64 RGBA',license:'CC0-1.0',creator:'Anima',skins:skins.map(s=>({name:s.name,file:s.name+'.png'}))},null,2)+'\n');
console.log('Generated four original 64x64 classic skins.');
