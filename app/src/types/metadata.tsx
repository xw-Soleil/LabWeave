/**
 * 扩展（插件）的元数据
 */
export interface ExtensionMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string; // 格式: "name <email>"
}

/**
 * .prg 文件的元数据
 * 存储在 .prg 文件的 metadata.msgpack 中
 * 用于版本管理、数据升级、文件信息记录等
 */
export interface PrgMetadata {
  /**
   * 数据文件版本号（语义化版本格式，如 "2.0.0", "2.1.0"）
   * 用于判断是否需要数据升级
   * @required
   */
  version: string;

  /**
   * 扩展（插件）元数据，如果是插件类型的prg则包含此字段
   */
  extension?: ExtensionMetadata;

  /**
   * 科研工作台的工作区信息。原版软件会原样保留这个字段
   */
  workbench?: WorkbenchMetadata;
}

export interface WorkbenchMetadata {
  /** 工作区 id，文件改名、移动后不变，AI 对话记录靠它找回 */
  id: string;
  /** 上次保存时的视野（摄像机世界坐标中心 + 缩放） */
  camera?: { x: number; y: number; scale: number };
  /** .prg 相对研究文件夹的 POSIX 路径，用来在文件夹整体搬走后推出新的研究文件夹 */
  workspacePath?: string;
  /** 毫秒时间戳 */
  createdAt?: number;
}

/**
 * 读出 metadata.workbench；字段类型不对的丢掉，id 不是字符串时整个当作没有
 */
export function readWorkbenchMetadata(metadata: unknown): WorkbenchMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const workbench = (metadata as { workbench?: unknown }).workbench;
  if (!workbench || typeof workbench !== "object") return undefined;
  const { id, camera, workspacePath, createdAt } = workbench as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return undefined;
  const result: WorkbenchMetadata = { id };
  if (camera && typeof camera === "object") {
    const { x, y, scale } = camera as Record<string, unknown>;
    if (
      typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y) &&
      typeof scale === "number" &&
      Number.isFinite(scale) &&
      scale > 0
    ) {
      result.camera = { x, y, scale };
    }
  }
  if (typeof workspacePath === "string") result.workspacePath = workspacePath;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) result.createdAt = createdAt;
  return result;
}

/**
 * 创建默认的 metadata 对象
 * @param version 版本号，默认为最新版本
 */
export function createDefaultMetadata(version: string = "2.0.0"): PrgMetadata {
  return {
    version,
  };
}

/**
 * 验证 metadata 对象是否有效
 * @param metadata 待验证的 metadata
 * @returns 是否有效
 */
export function isValidMetadata(metadata: any): metadata is PrgMetadata {
  return metadata && typeof metadata === "object" && typeof metadata.version === "string";
}

/**
 * 合并 metadata，保留所有字段
 * @param base 基础 metadata
 * @param updates 更新的字段
 * @returns 合并后的 metadata
 */
export function mergeMetadata(base: PrgMetadata, updates: Partial<PrgMetadata>): PrgMetadata {
  return {
    ...base,
    ...updates,
  };
}
