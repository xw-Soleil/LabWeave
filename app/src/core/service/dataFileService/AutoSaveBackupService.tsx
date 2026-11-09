import { Project, ProjectState, service } from "@/core/Project";
import { appCacheDir } from "@tauri-apps/api/path";
import { join } from "@tauri-apps/api/path";
import { exists, writeFile, readDir, stat, remove, mkdir } from "@tauri-apps/plugin-fs";
import { Settings } from "@/core/service/Settings";
import i18next from "i18next";
import { toast } from "sonner";
import { PathString } from "@/utils/pathString";
import { isTemporaryWorkspace } from "@/core/research/TemporaryWorkspace";

/** 最后一次编辑之后多久自动保存 */
export const SAVE_AFTER_EDIT_DELAY_MS = 5000;
/** 自动保存失败、又没有新编辑时，多久之后再试；之后每次翻倍，最长 10 分钟 */
export const SAVE_RETRY_FIRST_DELAY_MS = 30_000;
const SAVE_RETRY_MAX_DELAY_MS = 600_000;

/**
 * 自动保存与备份系统
 *
 * 自动备份：
 * 超过限制时删除老文件
 * 保存在 C:\Users\{userName}\AppData\Local\liren.project-graph\备份文件夹 下
 */
@service("autoSaveBackup")
export class AutoSaveBackupService {
  // 上次备份时间
  private lastBackupTime = 0;
  // 上次备份内容的哈希值
  private lastBackupHash = "";

  private lastSaveTime = 0;
  private isBackingUp = false;
  private saveAfterEditTimer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次看到的保存状态：只有真正变成未保存时才安排保存，isSaving 来回切换发的 state-change 不算 */
  private lastProjectState: ProjectState;
  /**
   * 自动保存连续失败的情况。没有新编辑（editRevision 没变）时，到 retryAt 之前不再重试，
   * 间隔逐次翻倍；有新编辑就照常保存。
   */
  private saveFailure: { revision: number; retryAt: number; delay: number } | undefined;

  constructor(private readonly project: Project) {
    this.lastBackupTime = Date.now();
    this.lastProjectState = project.projectState;
    this.project.on("stage-commit", this.scheduleSaveAfterEdit);
    this.project.on("history-change", this.scheduleSaveAfterEdit);
    this.project.on("state-change", this.onProjectStateChange);
  }

  dispose() {
    this.project.off("stage-commit", this.scheduleSaveAfterEdit);
    this.project.off("history-change", this.scheduleSaveAfterEdit);
    this.project.off("state-change", this.onProjectStateChange);
    clearTimeout(this.saveAfterEditTimer);
    this.saveAfterEditTimer = undefined;
  }

  /**
   * 编辑后停手约 5 秒就保存，用定时器而不是 tick：
   * 后台标签页（pauseRenderWhenTabUnfocused）和最小化的窗口不跑 requestAnimationFrame，tick 里的自动保存会停。
   */
  private readonly scheduleSaveAfterEdit = () => {
    clearTimeout(this.saveAfterEditTimer);
    this.saveAfterEditTimer = setTimeout(() => {
      this.saveAfterEditTimer = undefined;
      if (!Settings.autoSave) return;
      if (this.isBackingUp || this.project.isSaving) {
        this.scheduleSaveAfterEdit();
        return;
      }
      this.lastSaveTime = Date.now();
      void this.autoSave();
    }, SAVE_AFTER_EDIT_DELAY_MS);
  };

  /**
   * 撤销、重做发的是 history-change；这里接住其他直接把工程标成未保存的地方（比如附件窗口删附件）。
   * 保存失败时状态一直是未保存，isSaving 切换又会发 state-change，只看「变成」未保存，免得每 5 秒重试一次。
   */
  private readonly onProjectStateChange = (state: ProjectState) => {
    const previousState = this.lastProjectState;
    this.lastProjectState = state;
    if (state === ProjectState.Unsaved && previousState !== ProjectState.Unsaved) this.scheduleSaveAfterEdit();
  };

  /**
   * 高频率调用的tick函数，内部实现降频操作
   */
  tick() {
    const now = Date.now();

    // 检查是否达到备份间隔时间（转换为毫秒）
    if (Settings.autoBackup && !this.isBackingUp && !this.project.isSaving) {
      if (now - this.lastBackupTime >= Settings.autoBackupInterval * 1000) {
        this.lastBackupTime = now;
        void this.runAutoBackup();
      }
    }
    if (Settings.autoSave && !this.isBackingUp && !this.project.isSaving) {
      if (now - this.lastSaveTime >= Settings.autoSaveInterval * 1000) {
        this.lastSaveTime = now;
        this.autoSave();
      }
    }
  }

  private async autoSave() {
    if (!this.project.uri || this.project.isDraft || this.project.isCollab || this.project.isSaving) {
      // 临时草稿先不备份
      return;
    }
    if (this.project.projectState !== ProjectState.Unsaved) return;
    const revision = this.project.editRevision;
    const failure = this.saveFailure;
    if (failure && failure.revision === revision && Date.now() < failure.retryAt) return;
    try {
      await this.project.save({ includeThumbnail: false });
    } catch (error) {
      const delay = failure ? Math.min(failure.delay * 2, SAVE_RETRY_MAX_DELAY_MS) : SAVE_RETRY_FIRST_DELAY_MS;
      this.saveFailure = { revision, retryAt: Date.now() + delay, delay };
      // 同一串失败只提示一次；保存成功后收起
      if (!failure) {
        toast.error(
          i18next.t("workspace.save.autoSaveFailed", {
            ns: "research",
            error: String(error),
            interpolation: { escapeValue: false },
          }),
          { id: this.saveFailureToastId(), duration: Infinity },
        );
      }
      return;
    }
    if (failure) {
      this.saveFailure = undefined;
      toast.dismiss(this.saveFailureToastId());
    }
    // 写盘期间又有编辑时 Project 不会标成已保存；那次编辑若没发 stage-commit，这里补排一轮
    if (this.project.projectState === ProjectState.Unsaved && this.saveAfterEditTimer === undefined) {
      this.scheduleSaveAfterEdit();
    }
  }

  private saveFailureToastId() {
    return `research-autosave-failed:${this.project.uri.toString()}`;
  }

  private async runAutoBackup() {
    this.isBackingUp = true;
    try {
      await this.autoBackup();
    } finally {
      this.isBackingUp = false;
    }
  }

  /**
   * 执行自动备份操作
   */
  private async autoBackup() {
    const currentHash = this.project.stageHash;
    if (currentHash === this.lastBackupHash) {
      return;
    }

    // 备份不写进研究文件夹，也不看备份策略：先试自定义路径，都不行就放应用缓存目录
    // 临时白板只备份到应用缓存，避免自定义备份路径恰好在它所在的文件夹里。
    const temporary = isTemporaryWorkspace(this.project);
    const primaryCustomPath = temporary ? "" : (Settings.autoBackupCustomPath?.trim() ?? "");
    const secondaryCustomPath = temporary ? "" : (Settings.autoBackupCustomPath2?.trim() ?? "");

    const candidates: Array<{ kind: "custom"; path: string } | { kind: "default" }> = [];
    if (primaryCustomPath) {
      candidates.push({ kind: "custom", path: primaryCustomPath });
    }
    if (secondaryCustomPath && secondaryCustomPath !== primaryCustomPath) {
      candidates.push({ kind: "custom", path: secondaryCustomPath });
    }
    candidates.push({ kind: "default" });

    for (const candidate of candidates) {
      const backupDir = await this.resolveAutoBackupDir(candidate);
      if (!backupDir) {
        continue;
      }
      const ok = await this.tryBackupToDir(backupDir);
      if (ok) {
        this.lastBackupHash = currentHash;
        await this.manageBackupFiles(backupDir);
        return;
      }
    }

    toast.error("自动备份失败：所有备份路径均不可用");
  }

  public async manualBackup() {
    try {
      const backupDir = await join(await appCacheDir(), "manual-backup-v2");
      await this.backupCurrentProject(backupDir);
    } catch (err) {
      toast.error("备份过程中发生错误:" + err);
    }
  }

  private async resolveAutoBackupDir(
    candidate: { kind: "custom"; path: string } | { kind: "default" },
  ): Promise<string | null> {
    try {
      if (candidate.kind === "custom") {
        return await join(candidate.path, PathString.fileNameSafity(this.getOriginalFileName()));
      }
      return await join(await appCacheDir(), "auto-backup-v2", PathString.fileNameSafity(this.getOriginalFileName()));
    } catch (err) {
      toast.error(`生成备份路径失败: ${err}`);
      return null;
    }
  }

  private async tryBackupToDir(backupDir: string): Promise<boolean> {
    try {
      return await this.backupCurrentProject(backupDir);
    } catch {
      return false;
    }
  }

  private async backupCurrentProject(backupDir: string): Promise<boolean> {
    // 确保备份目录存在
    if (!(await exists(backupDir))) {
      try {
        // 创建备份目录（recursive: true 确保父目录也会被一并创建）
        await mkdir(backupDir, { recursive: true });
      } catch (err) {
        toast.error(`创建备份目录失败: ${err}`);
        return false;
      }
    }

    // 生成备份文件名
    const fileName = this.generateBackupFileName();
    const backupFilePath = await join(backupDir, fileName);

    // 创建备份文件
    await this.createBackupFile(backupFilePath);
    return true;
  }

  /**
   * 生成备份文件名
   */
  private generateBackupFileName(): string {
    const originalFileName = this.getOriginalFileName();
    return `${originalFileName}-${this.generateTimestamp()}.prg`;
  }

  /**
   * 生成时间戳字符串
   */
  private generateTimestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
  }

  /**
   * 获取原始文件名（不包含扩展名）
   */
  private getOriginalFileName(): string {
    if (!this.project.uri || this.project.isDraft) {
      return "Draft";
    }
    try {
      const uriStr = decodeURI(this.project.uri.toString());
      const nameWithoutExt = PathString.getFileNameFromPath(uriStr);
      return nameWithoutExt || "unnamed";
    } catch {
      return "unnamed";
    }
  }

  /**
   * 创建备份文件
   */
  private async createBackupFile(backupFilePath: string): Promise<void> {
    try {
      // 复制项目保存逻辑，但写入到备份文件路径
      const fileContent = await this.project.getFileContent({ includeThumbnail: false });

      // 写入备份文件
      await writeFile(backupFilePath, fileContent);
      toast.success(`备份成功：${backupFilePath}`);
    } catch (err) {
      toast.error("创建备份文件失败:" + err);
      throw err;
    }
  }

  /**
   * 管理备份文件数量，删除过旧的备份文件
   */
  private async manageBackupFiles(backupDir: string): Promise<void> {
    try {
      // 获取备份目录中的所有文件
      const files = await readDir(backupDir);

      // 过滤出.prg文件并获取文件信息
      const prgFiles = [];
      for (const file of files) {
        if (file.name.endsWith(".prg")) {
          try {
            const fileStat = await stat(await join(backupDir, file.name));
            prgFiles.push({
              name: file.name,
              mtime: fileStat.mtime,
            });
          } catch {
            // 忽略无法获取状态的文件
          }
        }
      }

      // 按修改时间排序（最新的在前）
      prgFiles.sort((a, b) => {
        const dateA = a.mtime ? new Date(a.mtime).getTime() : 0;
        const dateB = b.mtime ? new Date(b.mtime).getTime() : 0;
        return dateB - dateA;
      });

      // 获取设置的备份数量限制
      const maxBackupCount = Settings.autoBackupLimitCount;

      // 删除超出限制的旧备份
      if (prgFiles.length > maxBackupCount) {
        const filesToDelete = prgFiles.slice(maxBackupCount);
        for (const fileToDelete of filesToDelete) {
          try {
            await remove(await join(backupDir, fileToDelete.name));
          } catch (err) {
            toast.error(`删除旧备份文件 ${fileToDelete.name} 失败: ${err}`);
            // 继续尝试删除其他文件
          }
        }
      }
    } catch (err) {
      toast.error(`管理备份文件失败: ${err}`);
    }
  }
}
