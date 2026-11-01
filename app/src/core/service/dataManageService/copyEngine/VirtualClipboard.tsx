/**
 * 独立于系统剪贴板之外的虚拟剪贴板
 * 因为tauri的剪贴板插件用的是arboard
 * 而arboard不能写入自定义mime type的数据
 * 所以复制舞台对象要用虚拟剪贴板
 */
export namespace VirtualClipboard {
  let data: any = null;
  /** 复制完成那一刻系统剪贴板里的文字，null 表示还没记下来 */
  let systemClipboardText: string | null = null;
  let copyGeneration = 0;

  /** 返回这次复制的编号，记系统剪贴板文字时用来认出是不是同一次复制 */
  export function copy(newData: any): number {
    data = newData;
    systemClipboardText = null;
    return ++copyGeneration;
  }
  export function paste() {
    return data;
  }
  export function clear() {
    data = null;
    systemClipboardText = null;
  }
  export function hasData() {
    return data !== null;
  }

  /** 复制是异步的，写系统剪贴板期间可能又复制了一次，旧的那次读到的文字不能盖掉新的 */
  export function rememberSystemClipboardText(generation: number, text: string) {
    if (generation !== copyGeneration || data === null) return;
    systemClipboardText = text;
  }

  /** 系统剪贴板和复制时不一样了，说明用户之后在别处复制了新东西，应该改贴新的 */
  export function isOutdatedBy(currentSystemClipboardText: string): boolean {
    return data !== null && systemClipboardText !== null && currentSystemClipboardText !== systemClipboardText;
  }
}
