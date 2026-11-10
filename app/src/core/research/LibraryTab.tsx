import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import { store, tabsAtom } from "@/state";
import i18next from "i18next";
import { Library } from "lucide-react";
import { lazy, Suspense } from "react";

const LibraryView = lazy(() => import("./LibraryView"));

/** 文献库页：整个程序只开一个，放在文档区 */
export class LibraryTab extends Tab {
  private readonly component = () => (
    <Suspense fallback={null}>
      <LibraryView />
    </Suspense>
  );

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
