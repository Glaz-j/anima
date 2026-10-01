// 在 anima 目录运行：node examples/hello.ts
// 也可以传入名字：node examples/hello.ts 小雨
// 这是普通 TypeScript 示例，人物台词由代码指定。

type Npc = {
  name: string;
  energy: number;
};

const npc: Npc = {
  name: process.argv[2] ?? "林澈",
  energy: 80,
};

function say(character: Npc, message: string): void {
  console.log(`[${character.name}] ${message}`);
}

say(npc, "你好，我的第一个 TypeScript 程序跑起来了！");
say(npc, "你好，我的第一个 TypeScript 程序跑起来了！");
console.log("当前精力：", npc.energy);

npc.energy -= 10;
console.log("散步后的精力：", npc.energy);
