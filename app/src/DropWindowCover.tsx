import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { isWindows } from "./utils/platform";
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

/** 拖着文件进入窗口时框出放下的位置：文件直接放到鼠标下面的白板上 */
export const DropWindowCover = () => {
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
