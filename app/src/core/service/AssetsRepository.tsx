export namespace AssetsRepository {
  const repo = "https://assets.graphif.dev";

  /**
   * @param _path 开头不能是`/`
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export async function fetchFile<T extends string>(_path: T extends `/${string}` ? never : T): Promise<Uint8Array> {
    throw new Error("科研工作台只在本机工作，不会联网下载教程或音效素材。");
  }

  export function getGuideFileUrl<T extends string>(path: T extends `/${string}` ? never : T) {
    return `${repo}/${path}`;
  }
}
