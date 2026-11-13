import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { Settings } from "@/core/service/Settings";
import { store, tabsAtom } from "@/state";
import i18next from "i18next";
import { Library } from "lucide-react";
import { lazy, Suspense, type ComponentType } from "react";
import { URI } from "vscode-uri";

/** 文献库页的代码读好之后放在这里（见 warmLibrary） */
let loadedView: ComponentType | undefined;
const loadView = () =>
  import("./LibraryView").then((module) => {
    loadedView = module.default;
    return module;
  });
const LibraryView = lazy(loadView);

/**
 * 程序启动后空闲时调一次：先把文献库页的代码和内容都读好。
 * 不然第一次点开要现加载这一页的代码、再读一遍库，会先看到一个空的文献库。
 */
export function warmLibrary() {
  void loadView();
  const root = Settings.literatureLibraryPath;
  if (root) void import("./Library").then((library) => library.preloadLibrary(root));
}

/** 文献库页：整个程序只开一个，放在文档区 */
export class LibraryTab extends Tab {
  // 带 uri 才算「资源标签」，和白板、文档一样开在中间的主区域，不会被塞进当前选中的侧栏
  readonly uri = URI.parse("labweave:library");
  // 代码已经读好就直接画。走懒加载的话，即使代码早就在了，也要先空一拍再画，
  // 而且那一遍画到一半会被别的界面更新打断重来，实测白白多出一两百毫秒
  private readonly component = () => {
    const View = loadedView;
    return View ? (
      <View />
    ) : (
      <Suspense fallback={null}>
        <LibraryView />
      </Suspense>
    );
  };

  constructor() {
    super({});
    this.closeOnEscape = false;
  }

  override get title() {
    return i18next.t("library.title", { ns: "research" });
  }
  override get icon() {
    return Library;
  }
  getComponent() {
    return this.component;
  }
}

export function openLibraryTab() {
  const existing = store.get(tabsAtom).find((tab) => tab instanceof LibraryTab && !tab.closing);
  if (existing) TabWorkspace.focus(existing.id);
  else TabWorkspace.open(new LibraryTab());
}
