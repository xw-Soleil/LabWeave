import { Project, ProjectState, service } from "@/core/Project";
import { Settings } from "@/core/service/Settings";
import { serialize } from "@graphif/serializer";
import { deserializeStageObjects } from "@/core/research/LegacyMathCards";
import { cn } from "@udecode/cn";
import { Delta, diff, patch } from "jsondiffpatch";
import _ from "lodash";
import { toast } from "sonner";

abstract class HistoryManagerAbs {
  public abstract rewriteSnapshots(rewrite: (stage: unknown) => void): void;
  public abstract recordStep(): void;
  public abstract undo(): void;
  public abstract redo(): void;
  public abstract get(index: number): Record<string, any>[];
  public abstract clearHistory(): void;
}

class HistoryManagerTimeEfficient extends HistoryManagerAbs {
  rewriteSnapshots(rewrite: (stage: unknown) => void) {
    rewrite(this.initialStage);
    this.history.forEach(rewrite);
  }
  /**
   * 初始化的舞台数据
   */
  initialStage: Record<string, any>[] = [];

  /**
   * 存储完整序列化历史记录的数组
   * 每一项都是完整的舞台数据，不进行diff操作
   */
  history: Record<string, any>[] = [];

  /**
   * 历史记录指针
   */
  currentIndex = -1;

  // 在project加载完毕后调用
  constructor(private readonly project: Project) {
    super();
    this.initialStage = serialize(project.stage);
  }

  /**
   * 记录一步骤
   * 直接保存完整的舞台序列化数据，优先考虑时间效率
   */
  recordStep() {
    // 删除当前指针之后的所有历史记录
    this.history.splice(this.currentIndex + 1);

    // 保存当前舞台的完整序列化数据
    const currentStage = serialize(this.project.stage);
    this.history.push(currentStage);
    this.currentIndex = this.history.length - 1;

    // 当历史记录超过限制时，删除最旧的记录
    while (this.history.length > Settings.historySize) {
      this.history.shift();
      this.currentIndex--;
    }

    this.project.projectState = ProjectState.Unsaved;
  }

  /**
   * 估算历史记录的内存占用大小
   * @returns 格式化后的内存大小字符串
   */
  private estimateMemoryUsage(): string {
    try {
      // 将history数组序列化为JSON字符串，估算内存占用
      const jsonString = JSON.stringify(this.history);
      // 每个字符大约占用2字节（UTF-16编码）
      const bytes = jsonString.length * 2;

      // 格式化显示
      if (bytes < 1024) {
        return `${bytes} B`;
      } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
      } else {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      }
    } catch (error) {
      return "无法估算" + JSON.stringify(error);
    }
  }

  /**
   * 撤销
   */
  undo() {
    if (this.currentIndex >= 0) {
      this.currentIndex--;
      this.project.stage = this.get(this.currentIndex);
      this.project.stageManager.updateReferences();
    }

    // 显示toast信息，与memoryEfficient版本保持一致
    if (Settings.showDebug) {
      toast(
        <div className="flex text-sm">
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史位置</span>
            <span className={cn(this.currentIndex === -1 && "text-red-500")}>{this.currentIndex + 1}</span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史长度</span>
            <span className={cn(this.history.length === Settings.historySize && "text-yellow-500")}>
              {this.history.length}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>限定历史长度</span>
            <span className="opacity-50">{Settings.historySize}</span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>内存占用估算</span>
            <span className="text-blue-500">{this.estimateMemoryUsage()}</span>
          </span>
        </div>,
      );
    }
  }

  /**
   * 反撤销
   */
  redo() {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      this.project.stage = this.get(this.currentIndex);
      this.project.stageManager.updateReferences();
    }

    // 显示toast信息，与memoryEfficient版本保持一致
    if (Settings.showDebug) {
      toast(
        <div className="flex text-sm">
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史位置</span>
            <span className={cn(this.currentIndex === this.history.length - 1 && "text-green-500")}>
              {this.currentIndex + 1}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史长度</span>
            <span className={cn(this.history.length === Settings.historySize && "text-yellow-500")}>
              {this.history.length}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>限定历史长度</span>
            <span className="opacity-50">{Settings.historySize}</span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>内存占用估算</span>
            <span className="text-blue-500">{this.estimateMemoryUsage()}</span>
          </span>
        </div>,
      );
    }
  }

  /**
   * 获取指定索引的历史记录
   * @param index 历史记录索引
   * @returns 舞台对象
   */
  get(index: number) {
    // 处理边界情况：如果索引为负数，直接返回初始状态
    if (index < 0) {
      return deserializeStageObjects(_.cloneDeep(this.initialStage), this.project);
    }

    // 直接返回对应索引的历史记录，无需应用diff
    const historyData = _.cloneDeep(this.history[index]);
    return deserializeStageObjects(historyData, this.project);
  }

  /**
   * 清空历史记录
   * 保存文件时调用，将当前状态设为新的初始状态
   */
  clearHistory() {
    this.history = [];
    this.currentIndex = -1;
    this.initialStage = serialize(this.project.stage);
    this.project.projectState = ProjectState.Saved;
    if (Settings.showDebug) {
      toast("历史记录已清空");
    }
  }
}

class HistorymanagerMemoryEfficient extends HistoryManagerAbs {
  rewriteSnapshots(rewrite: (stage: unknown) => void) {
    let data = _.cloneDeep(this.initialStage);
    const snapshots = this.deltas.map((delta) => {
      data = patch(data, _.cloneDeep(delta)) as typeof data;
      return _.cloneDeep(data);
    });
    rewrite(this.initialStage);
    snapshots.forEach(rewrite);
    this.deltas = snapshots.map((snapshot, index) =>
      diff(index === 0 ? this.initialStage : snapshots[index - 1], snapshot),
    );
  }
  /**
   * 历史记录列表数组
   * 每一项都是变化的delta，不是完整的舞台数据！
   */
  deltas: Delta[] = [];
  /**
   * 历史记录列表数组上的一个指针
   *
   * []
   * -1      一开始数组为空时，指针指向 -1
   *
   * [a]
   *  0
   *
   * [a, b]
   *     1
   */
  currentIndex = -1;

  /**
   * 初始化的舞台数据
   */
  initialStage: Record<string, any>[] = [];

  // 在project加载完毕后调用
  constructor(private readonly project: Project) {
    super();
    this.initialStage = serialize(project.stage);
  }

  /**
   * 记录一步骤
   * @param file
   */
  recordStep() {
    // console.trace("recordStep");
    // this.deltas = this.deltas.splice(this.currentIndex + 1);
    this.deltas.splice(this.currentIndex + 1);
    // 上面一行的含义：删除从 currentIndex + 1 开始的所有元素。
    // [a, b, c, d, e]
    //  0  1  2  3  4
    //        ^
    //  currentIndex = 2，去掉 3 4
    // 变成
    // [a, b, c]
    //  0  1  2
    //        ^

    // 也就是撤回了好几步(两步)之后再做修改，后面的曾经历史就都删掉了，相当于重开了一个分支。
    this.currentIndex++;
    // [a, b, c]
    //  0  1  2  3
    //           ^
    const prev = serialize(this.get(this.currentIndex - 1)); // [C stage]
    const current = serialize(this.project.stage); // [D stage]
    const patch_ = diff(prev, current); // [D stage] - [C stage] = [d]
    if (!patch_) {
      this.currentIndex--; // 没有变化，当指针回退到当前位置
      return;
    }

    this.deltas.push(patch_);
    // [a, b, c, d]
    //  0  1  2  3
    //           ^
    while (this.deltas.length > Settings.historySize) {
      // 当历史记录超过限制时，需要删除最旧的记录
      // 但是不能简单删除，因为get方法依赖于从initialStage开始应用所有delta
      // 所以我们需要将第一个delta合并到initialStage中，然后删除这个delta
      const firstDelta = _.cloneDeep(this.deltas[0]);
      this.initialStage = patch(_.cloneDeep(this.initialStage), firstDelta) as any;
      this.deltas.shift(); // 删除第一个delta [a]
      // [b, c, d]
      //  0  1  2  3
      //           ^

      this.currentIndex--;
      // [b, c, d]
      //  0  1  2
      //        ^
    }
    // 检测index是否越界
    if (this.currentIndex >= this.deltas.length) {
      this.currentIndex = this.deltas.length - 1;
    }
    this.project.projectState = ProjectState.Unsaved;
  }

  /**
   * 撤销
   */
  undo() {
    // currentIndex 最小为 -1
    if (this.currentIndex >= 0) {
      this.currentIndex--;
      this.project.stage = this.get(this.currentIndex);
      this.project.stageManager.updateReferences();
    }
    if (Settings.showDebug) {
      toast(
        <div className="flex text-sm">
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史位置</span>
            <span className={cn(this.currentIndex === -1 && "text-red-500")}>{this.currentIndex + 1}</span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史长度</span>
            <span className={cn(this.deltas.length === Settings.historySize && "text-yellow-500")}>
              {this.deltas.length}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>限定历史长度</span>
            <span className="opacity-50">{Settings.historySize}</span>
          </span>
        </div>,
      );
    }
  }

  /**
   * 反撤销
   */
  redo() {
    if (this.currentIndex < this.deltas.length - 1) {
      this.currentIndex++;
      this.project.stage = this.get(this.currentIndex);
      this.project.stageManager.updateReferences();
    }
    if (Settings.showDebug) {
      toast(
        <div className="flex text-sm">
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史位置</span>
            <span className={cn(this.currentIndex === this.deltas.length - 1 && "text-green-500")}>
              {this.currentIndex + 1}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>当前历史长度</span>
            <span className={cn(this.deltas.length === Settings.historySize && "text-yellow-500")}>
              {this.deltas.length}
            </span>
          </span>
          <span className="m-2 flex flex-col justify-center">
            <span>限定历史长度</span>
            <span className="opacity-50">{Settings.historySize}</span>
          </span>
        </div>,
      );
    }
  }

  get(index: number) {
    // 处理边界情况：如果索引为负数，直接返回初始状态
    if (index < 0) {
      return deserializeStageObjects(_.cloneDeep(this.initialStage), this.project);
    }

    // 先获取从0到index（包含index）的所有patch
    const deltas = _.cloneDeep(this.deltas.slice(0, index + 1));
    // 从initialStage开始应用patch，得到在index时刻的舞台序列化数据
    // const data = deltas.reduce((acc, delta) => {
    //   return patch(_.cloneDeep(acc), _.cloneDeep(delta)) as any;
    // }, _.cloneDeep(this.initialStage));
    let data = _.cloneDeep(this.initialStage); // 迭代这个data
    for (const delta of deltas) {
      data = patch(data, _.cloneDeep(delta)) as any;
    }
    // 反序列化得到舞台对象
    const stage = deserializeStageObjects(data, this.project);
    return stage;
  }

  /**
   * 清空历史记录
   * 保存文件时调用，将当前状态设为新的初始状态
   */
  clearHistory() {
    this.deltas = [];
    this.currentIndex = -1;
    this.initialStage = serialize(this.project.stage);
    this.project.projectState = ProjectState.Saved;
    if (Settings.showDebug) {
      toast("历史记录已清空");
    }
  }
}

/**
 * 专门管理历史记录
 * 负责撤销、反撤销、重做等操作
 * 具有直接更改舞台状态的能力
 */
@service("historyManager")
export class HistoryManager extends HistoryManagerAbs {
  public rewriteSnapshots(rewrite: (stage: unknown) => void): void {
    this.memoryEfficient.rewriteSnapshots(rewrite);
    this.timeEfficient.rewriteSnapshots(rewrite);
  }
  private batchDepth = 0;
  private batchChanged = false;

  /** A pointer gesture can invoke several stage commands but is one undo step. */
  public batch<T>(action: () => T): T {
    this.batchDepth++;
    try {
      return action();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchChanged) {
        this.batchChanged = false;
        this.recordStep();
      }
    }
  }
  private memoryEfficient: HistoryManagerAbs;
  private timeEfficient: HistoryManagerAbs;
  private readonly unwatchHistoryManagerMode: () => void;

  // 当前使用的历史管理器实例
  private currentManager: HistoryManagerAbs;

  constructor(private readonly project: Project) {
    super();
    this.memoryEfficient = new HistorymanagerMemoryEfficient(project);
    this.timeEfficient = new HistoryManagerTimeEfficient(project);

    // 根据设置初始化历史记录管理器模式
    const initialMode = Settings.historyManagerMode;
    this.currentManager = initialMode === "memoryEfficient" ? this.memoryEfficient : this.timeEfficient;

    // 监听设置变化
    this.unwatchHistoryManagerMode = Settings.watch("historyManagerMode", (newMode) => {
      this.switchMode(newMode === "timeEfficient");
    });
  }

  dispose(): void {
    this.unwatchHistoryManagerMode();
  }

  /**
   * 记录一步骤
   */
  public recordStep(): void {
    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }
    this.currentManager.recordStep();
    this.project.emit("stage-commit");
  }

  /**
   * 撤销
   */
  public undo(): void {
    const stageBefore = this.project.stage;
    this.currentManager.undo();
    this.afterHistoryMove(stageBefore);
  }

  /**
   * 反撤销
   */
  public redo(): void {
    const stageBefore = this.project.stage;
    this.currentManager.redo();
    this.afterHistoryMove(stageBefore);
  }

  /**
   * 撤销、重做真的换了舞台内容时，要把工程标成未保存并通知自动保存：
   * 自动保存之后再撤销，恢复出来的内容不能只留在内存里。
   * 不复用 stage-commit，协作服务会把它当成一次新编辑同步出去。
   */
  private afterHistoryMove(stageBefore: unknown) {
    if (this.project.stage === stageBefore) return;
    this.project.projectState = ProjectState.Unsaved;
    this.project.emit("history-change");
  }

  /**
   * 获取指定索引的历史记录
   * @param index 历史记录索引
   * @returns 舞台对象
   */
  public get(index: number): Record<string, any>[] {
    return this.currentManager.get(index);
  }

  /**
   * 清空历史记录
   */
  public clearHistory(): void {
    this.currentManager.clearHistory();
  }

  /**
   * 切换历史记录管理器模式
   * @param useTimeEfficient 是否使用时间效率优先的管理器
   */
  public switchMode(useTimeEfficient: boolean): void {
    // 保存当前舞台状态
    // const currentStage = this.get();

    // 清空两个管理器的历史记录
    this.timeEfficient.clearHistory();
    this.memoryEfficient.clearHistory();

    // 切换到指定的管理器
    this.currentManager = useTimeEfficient ? this.timeEfficient : this.memoryEfficient;

    // 将当前状态记录为新管理器的初始状态
    // if (currentStage.length > 0) {
    //   this.recordStep(currentStage);
    // }
  }
}
