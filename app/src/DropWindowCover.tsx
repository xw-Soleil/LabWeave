import { cn } from "./utils/cn";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isMac, isWindows } from "./utils/platform";
import { DragFileIntoStageEngine } from "./core/service/dataManageService/dragFileIntoStageEngine/dragFileIntoStageEngine";
import { isMediaFilePath } from "./core/service/dataManageService/dragFileIntoStageEngine/dragFileIntoStageEngine";
import type { Project } from "./core/Project";
import { TextNode } from "./core/stage/stageObject/entity/TextNode";
import { CollisionBox } from "./core/stage/stageObject/collisionBox/collisionBox";
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { isResearchShell } from "./core/research/ResearchShell";
import {
  dropFilesAtClientPoint,
  dropTextAtClientPoint,
  findBoardAtClientPoint,
  screenToClientPoint,
  webviewDropPositionToClient,
  type ClientPoint,
  type ScreenOrigin,
} from "./core/research/ResearchDrop";

interface PgDragDropPayload {
  kind: "enter" | "over" | "leave" | "drop";
  paths: string[];
  text: string | null;
  x: number;
  y: number;
}

/**
 * 拖拽鼠标进入舞台时，覆盖一个提示区域。
 * 科研模式下不分三段：文件直接放到鼠标下面的白板上；关掉开关时和原版一样。
 */
export const DropWindowCover = ({ project }: { project?: Project }) => {
  if (isResearchShell()) return <ResearchDropCover />;
  return project ? <UpstreamDropCover project={project} /> : null;
};

/**
 * 用于提示用户在不同位置释放有不同的效果
 */
const UpstreamDropCover = ({ project }: { project: Project }) => {
  const fadeOutMs = 700;
  const [dropMouseLocation, setDropMouseLocation] = useState<"top" | "middle" | "bottom" | "notInWindowZone">(
    "notInWindowZone",
  );
  const [isFadingOut, setIsFadingOut] = useState(false);
  const isDraft = project.isDraft;

  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const cancelAnimation = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      hideTimerRef.current = null;
      rafRef.current = null;
    };

    const unlistenPromise = listen<PgDragDropPayload>("pg-drag-drop", async (event) => {
      const payload = event.payload;
      const size = await getCurrentWindow().outerSize();
      const scaleFactor = await getCurrentWindow().scaleFactor();
      const logicalHeight = isMac ? size.height / scaleFactor : size.height;
      const getDropLocation = (y: number) =>
        y <= logicalHeight / 3 ? "top" : y <= (logicalHeight / 3) * 2 ? "middle" : "bottom";

      if (payload.kind === "enter") {
        cancelAnimation();
        setIsFadingOut(false);
        setDropMouseLocation(getDropLocation(payload.y));
      } else if (payload.kind === "over") {
        cancelAnimation();
        setIsFadingOut(false);
        setDropMouseLocation(getDropLocation(payload.y));
      } else if (payload.kind === "leave") {
        cancelAnimation();
        setIsFadingOut(false);
        setDropMouseLocation("notInWindowZone");
      } else if (payload.kind === "drop") {
        cancelAnimation();
        const dropLocation = getDropLocation(payload.y);
        setIsFadingOut(false);
        setDropMouseLocation(dropLocation);
        rafRef.current = requestAnimationFrame(() => {
          setIsFadingOut(true);
        });
        hideTimerRef.current = setTimeout(() => {
          setDropMouseLocation("notInWindowZone");
          setIsFadingOut(false);
        }, fadeOutMs);

        if (payload.text && payload.text.trim().length > 0) {
          const worldPos = project.renderer.transformView2World(
            new Vector(payload.x / scaleFactor, payload.y / scaleFactor),
          );
          const textNode = new TextNode(project, {
            text: payload.text.trim(),
            collisionBox: new CollisionBox([new Rectangle(worldPos, new Vector(300, 150))]),
            sizeAdjust: "manual",
          });
          project.stageManager.add(textNode);
        } else if (payload.paths.length > 0) {
          if (dropLocation === "top") {
            DragFileIntoStageEngine.handleDrop(project, payload.paths);
          } else {
            const mediaPaths = payload.paths.filter(isMediaFilePath);
            const otherPaths = payload.paths.filter((p) => !isMediaFilePath(p));
            if (mediaPaths.length > 0) {
              DragFileIntoStageEngine.handleDrop(project, mediaPaths);
            }
            if (otherPaths.length > 0) {
              if (dropLocation === "middle") {
                DragFileIntoStageEngine.handleDropFileRelativePath(project, otherPaths);
              } else {
                DragFileIntoStageEngine.handleDropFileAbsolutePath(project, otherPaths);
              }
            }
          }
        }
      }
    });

    return () => {
      cancelAnimation();
      unlistenPromise.then((f) => f()).catch(() => {});
    };
  }, [project]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 left-0 z-5 flex h-screen w-full flex-col transition-opacity duration-700 ease-out",
        dropMouseLocation === "notInWindowZone" ? "opacity-0" : isFadingOut ? "opacity-0" : "opacity-100",
      )}
    >
      <div
        className={cn(
          "bg-card/80 flex flex-1 flex-col items-center justify-center text-xl",
          dropMouseLocation === "top" && "text-destructive bg-transparent",
        )}
      >
        <p>拖拽到这里：追加到舞台</p>
        <span className="text-sm">
          如果是图片文件（png/jpg/jpeg/webp）或音视频文件，则追加到舞台，如果是prg工程文件，则打开标签页
        </span>
      </div>
      <div
        className={cn(
          "bg-card/80 flex flex-1 flex-col items-center justify-center text-xl",
          dropMouseLocation === "middle" && !isDraft && "text-destructive bg-transparent",
          isDraft && "cursor-not-allowed opacity-40",
        )}
      >
        <p>
          拖拽到这里：以 <span className="text-3xl">相对路径</span> 生成文本节点到舞台
        </p>
        {isDraft && <span className="text-sm">（草稿文件无路径，无法使用相对路径）</span>}
      </div>
      <div
        className={cn(
          "bg-card/80 flex flex-1 flex-col items-center justify-center text-xl",
          dropMouseLocation === "bottom" && "text-destructive bg-transparent",
        )}
      >
        <p>
          拖拽到这里：以 <span className="text-3xl">绝对路径</span> 生成文本节点到舞台
        </p>

        <span className="text-sm">
          这样就可以构建外部文件链接，选中路径为内容的文本节点，直接调用系统默认方式打开此文件了
        </span>
      </div>
    </div>
  );
};

async function readScreenOrigin(): Promise<ScreenOrigin> {
  const currentWindow = getCurrentWindow();
  const [position, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
  return { x: position.x, y: position.y, scaleFactor };
}

interface DropFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 鼠标下面有白板就框住这块白板的画布，否则框住整个窗口（文件会放到当前白板的视野中心） */
function dropFrameAt(point: ClientPoint): DropFrame {
  const rect = findBoardAtClientPoint(point.x, point.y)?.canvas.element.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function sameFrame(a: DropFrame | null, b: DropFrame) {
  return a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

const ResearchDropCover = () => {
  const { t } = useTranslation("research");
  const [frame, setFrame] = useState<DropFrame | null>(null);

  useEffect(() => {
    const show = (point: ClientPoint) => {
      const next = dropFrameAt(point);
      setFrame((previous) => (sameFrame(previous, next) ? previous : next));
    };
    const hide = () => setFrame(null);
    const drop = (paths: string[], text: string | null, point: ClientPoint) => {
      hide();
      if (paths.length > 0) {
        dropFilesAtClientPoint(paths, point.x, point.y).catch((error: unknown) => {
          toast.error(
            t("drop.failed", {
              message: error instanceof Error ? error.message : String(error),
              interpolation: { escapeValue: false },
            }),
          );
        });
      } else if (text) {
        dropTextAtClientPoint(text, point.x, point.y);
      }
    };

    let unlistenPromise: Promise<UnlistenFn>;
    if (isWindows) {
      // Windows 上 custom_drag_drop.rs 接管了 WebView2 的拖放，Tauri 自己的拖放事件不会来。
      // 坐标换算要等异步的窗口位置；换算期间来了 leave/drop 的话，这次结果作废，免得提示框松手后又冒出来。
      let session = 0;
      let origin: Promise<ScreenOrigin> | null = null;
      unlistenPromise = listen<PgDragDropPayload>("pg-drag-drop", async ({ payload }) => {
        if (payload.kind === "leave") {
          session++;
          hide();
          return;
        }
        if (payload.kind === "enter" || !origin) {
          session++;
          origin = readScreenOrigin();
        }
        const current = session;
        const point = screenToClientPoint(payload, await origin);
        if (current !== session) return;
        if (payload.kind === "drop") {
          session++;
          drop(payload.paths, payload.text, point);
        } else {
          show(point);
        }
      });
    } else {
      // 页面内部拖文字等也会触发 enter，只是没有文件路径；这种不显示提示
      let draggingFiles = false;
      unlistenPromise = getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          draggingFiles = false;
          hide();
          return;
        }
        if (payload.type === "drop") {
          draggingFiles = false;
          const point = webviewDropPositionToClient(payload.position, false, window.devicePixelRatio);
          if (payload.paths.length > 0) drop(payload.paths, null, point);
          else hide();
          return;
        }
        if (payload.type === "enter") draggingFiles = payload.paths.length > 0;
        if (draggingFiles) show(webviewDropPositionToClient(payload.position, false, window.devicePixelRatio));
      });
    }

    return () => {
      hide();
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [t]);

  if (!frame) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      <div
        className="border-primary bg-primary/5 absolute flex items-center justify-center rounded-md border-2 border-dashed"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <div className="bg-card/95 text-card-foreground flex flex-col items-center gap-1 rounded-lg border px-5 py-3 shadow-lg">
          <p className="text-base font-medium">{t("drop.hint")}</p>
          <p className="text-muted-foreground text-xs">{t("drop.hintDetail")}</p>
        </div>
      </div>
    </div>
  );
};
