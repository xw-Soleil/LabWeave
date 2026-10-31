import { isResearchShell } from "@/core/research/ResearchShell";
import { fetch } from "@tauri-apps/plugin-http";

export namespace AssetsRepository {
  const repo = "https://assets.graphif.dev";

  /**
   * @param path 开头不能是`/`
   */
  export async function fetchFile<T extends string>(path: T extends `/${string}` ? never : T): Promise<Uint8Array> {
    if (isResearchShell()) {
      throw new Error("科研工作台只在本机工作，不会联网下载教程或音效素材。");
    }
    const r = await fetch(AssetsRepository.getGuideFileUrl(path));
    if (!r.ok) throw new Error(`Failed to fetch asset: ${r.status} ${r.statusText}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  export function getGuideFileUrl<T extends string>(path: T extends `/${string}` ? never : T) {
    return `${repo}/${path}`;
  }
}
