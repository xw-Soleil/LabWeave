/*
 * React 19 的开发版会给每次组件更新写一条性能记录（performance.measure），里面带着前后两份 props 的逐项对比。
 * 标签栏、状态条这些组件的 props 里有整块白板，换一块白板它就把两块白板从头比到尾：
 * 30 来张卡片时一次就冻住界面近 10 秒（回看切节点卡住就是这个原因），写下的记录还一直留在内存里。
 * React 载入的那一刻看有没有 console.timeStamp 来决定记不记，所以要赶在它前面拿掉。打包版的 React 本来就不记。
 *
 * 必须是 main.tsx 的第一条 import。
 */
if (import.meta.env.DEV) Object.assign(console, { timeStamp: undefined });

export {};
