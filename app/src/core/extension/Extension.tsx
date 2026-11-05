import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import KeyBind from "@/components/ui/key-bind";
import Markdown from "@/components/ui/markdown";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Themes } from "@/core/service/Themes";
import { PrgMetadata } from "@/types/metadata";
import { Decoder } from "@msgpack/msgpack";
import i18next from "i18next";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import {
  Blocks,
  Dot,
  Keyboard,
  KeyboardOff,
  Palette,
  SquareAsterisk,
  SquareRoundCorner,
  SquareStack,
} from "lucide-react";
import React, { useEffect, useReducer, useState } from "react";
import { toast } from "sonner";
import { URI } from "vscode-uri";
import { KeyBindsUI } from "../service/controlService/shortcutKeysEngine/KeyBindsUI";
import { Settings } from "../service/Settings";
import { Tab } from "../Tab";
import { ExtensionKeyBindManager } from "./ExtensionKeyBindManager";
import { ExtensionManager } from "./ExtensionManager";
import { getMimeType } from "./ExtensionUtils";

export class Extension extends Tab {
  public metadata: PrgMetadata = { version: "2.0.0" };
  public readmeContent: string = "";
  public code: string = "";
  /** 扩展图标的 blob URL，用于显示；加载失败或未配置时为 null */
  public iconBlobUrl: string | null = null;

  public stage: any[] = []; // 占位以防止部分 Service 访问报错
  private _uri: URI;
  private _component: React.ComponentType | null = null;

  constructor(uri: URI) {
    super({});
    this._uri = uri;
  }

  get uri() {
    return this._uri;
  }

  async init() {
    const fs = (this as any).fs;
    if (!fs) {
      console.error("Extension fs is not initialized");
      return;
    }

    const decoder = new Decoder();

    if (this.uri.path.endsWith(".prg")) {
      const fileContent = await fs.read(this.uri);
      const reader = new ZipReader(new Uint8ArrayReader(fileContent));
      const entries = await reader.getEntries();

      for (const entry of entries) {
        if (entry.directory) continue; // 跳过文件夹
        if (entry.filename === "metadata.msgpack") {
          const metadataRawData = await entry.getData!(new Uint8ArrayWriter());
          this.metadata = decoder.decode(metadataRawData) as PrgMetadata;
        } else if (entry.filename === "README.md") {
          const readmeRawData = await entry.getData!(new Uint8ArrayWriter());
          this.readmeContent = new TextDecoder().decode(readmeRawData);
        } else if (entry.filename === "extension.js") {
          const codeRawData = await entry.getData!(new Uint8ArrayWriter());
          this.code = new TextDecoder().decode(codeRawData);
        }
      }

      // 加载自定义图标（从 zip 包根目录读取 icon.png/svg/jpg/webp）
      const iconNames = ["icon.svg", "icon.webp", "icon.png", "icon.jpg"];
      const iconEntry = entries.find((e) => iconNames.includes(e.filename));
      if (iconEntry) {
        try {
          if (iconEntry.directory) throw new Error("图标不能是文件夹");
          const iconData = await iconEntry.getData!(new Uint8ArrayWriter());
          const mimeType = getMimeType(iconEntry.filename);
          this.iconBlobUrl = URL.createObjectURL(new Blob([iconData], { type: mimeType }));
        } catch (e) {
          console.warn("加载扩展图标失败（zip）", e);
        }
      }

      if (this.metadata.extension?.id ?? "" !== this.uri.path.split("/").slice(-1)[0].replace(".prg", "")) {
        const newUri = this.uri.with({
          path: this.uri.path.replace(/\/?[^/]*$/, `/${this.metadata.extension?.id || "unknown"}.prg`),
        });
        this.fs.rename(this.uri, newUri);
        this._uri = newUri;
        toast.warning("扩展包名称与实际扩展 ID 不一致，已自动重命名");
      }
    } else {
      // 直接读文件夹
      const codeUri = this.uri.with({ path: this.uri.path + "/extension.js" });
      const metadataUri = this.uri.with({ path: this.uri.path + "/metadata.msgpack" });
      const readmeUri = this.uri.with({ path: this.uri.path + "/README.md" });

      try {
        const [codeContent, metadataContent, readmeContent] = await Promise.all([
          fs.read(codeUri),
          fs.read(metadataUri),
          (await fs.exists(readmeUri)) ? fs.read(readmeUri) : "",
        ]);

        this.code = new TextDecoder().decode(codeContent);
        this.metadata = decoder.decode(metadataContent) as PrgMetadata;
        this.readmeContent = new TextDecoder().decode(readmeContent);
      } catch (e) {
        console.error("Failed to load extension from folder", e);
        toast.error("加载扩展失败，请检查文件结构是否正确");
      }

      // 加载自定义图标（从文件夹根目录读取 icon.png/svg/jpg/webp）
      const iconNames = ["icon.svg", "icon.webp", "icon.png", "icon.jpg"];
      for (const iconName of iconNames) {
        try {
          const iconUri = this.uri.with({ path: this.uri.path + "/" + iconName });
          const iconData = await fs.read(iconUri);
          const mimeType = getMimeType(iconName);
          this.iconBlobUrl = URL.createObjectURL(new Blob([iconData], { type: mimeType }));
          break;
        } catch {
          // 尝试下一个文件名
        }
      }

      if (this.metadata.extension?.id ?? "" !== this.uri.path.split("/").slice(-1)[0]) {
        const newUri = this.uri.with({
          path: this.uri.path.replace(/\/?[^/]*$/, `/${this.metadata.extension?.id || "unknown"}`),
        });
        this.fs.rename(this.uri, newUri);
        this._uri = newUri;
        toast.warning("扩展文件夹名称与实际扩展 ID 不一致，已自动重命名");
      }
    }
  }

  getComponent(): React.ComponentType {
    if (this._component) return this._component;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this._component = function ExtensionComponent() {
      const [, forceUpdate] = useReducer((x) => x + 1, 0);
      const [installed, setInstalled] = useState(false);
      const [disabledExtensions, setDisabledExtensions] = Settings.use("disabledExtensions");
      const disabled = disabledExtensions.includes(self.metadata.extension?.id || "");
      // 响应式快捷键列表：安装插件后自动刷新
      const extensionKeyBinds = KeyBindsUI.use((kb) => kb.id.startsWith(`ext:${self.metadata.extension?.id || ""}:`));

      useEffect(() => {
        (async () => {
          const extensions = await ExtensionManager.getExtensions();
          console.log("已安装的扩展", extensions);
          setInstalled(
            extensions.includes((self.metadata.extension?.id || "") + ".prg") ||
              extensions.includes(self.metadata.extension?.id || ""),
          );
        })();
      }, []);

      return (
        <div className="mx-auto h-full max-w-4xl space-y-6 overflow-auto p-16">
          <div className="flex items-start justify-between border-b pb-6">
            <div className="space-y-2">
              <div className="flex items-center gap-4">
                {self.iconBlobUrl ? (
                  <img src={self.iconBlobUrl} className="size-12 shrink-0 object-contain" alt="扩展图标" />
                ) : (
                  <Blocks className="size-12 shrink-0 opacity-40" />
                )}
                <h1 className="text-4xl font-bold">{self.metadata.extension?.name || "未知扩展"}</h1>
              </div>
              <div className="text-muted-foreground space-x-4 text-sm">
                <span>ID: {self.metadata.extension?.id}</span>
                <span>版本: {self.metadata.extension?.version}</span>
                <span>作者: {self.metadata.extension?.author}</span>
              </div>
              <p className="text-muted-foreground text-lg">{self.metadata.extension?.description}</p>
            </div>
            <div className="flex gap-2">
              {installed ? (
                <>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (await Dialog.confirm("确认卸载", "将彻底删除此扩展，无法恢复。请确认是否继续。")) {
                        const extId = self.metadata.extension?.id || "";
                        ExtensionKeyBindManager.unregisterAll(extId);
                        // 终止 Worker 并清除缓存，使重新安装时能创建新 Runtime
                        ExtensionManager.unload(extId);
                        await self.fs.remove(URI.file(await join(await appDataDir(), "extensions", extId)));
                        setDisabledExtensions(disabledExtensions.filter((id) => id !== extId));
                        setInstalled(false);
                        toast.success("扩展已卸载");
                      }
                    }}
                  >
                    卸载
                  </Button>
                  {disabled ? (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        setDisabledExtensions(disabledExtensions.filter((id) => id !== self.metadata.extension?.id));
                        toast.success("扩展已启用");
                      }}
                    >
                      启用
                    </Button>
                  ) : (
                    <Button
                      onClick={async () => {
                        ExtensionKeyBindManager.unregisterAll(self.metadata.extension?.id || "");
                        setDisabledExtensions([...disabledExtensions, self.metadata.extension?.id || ""]);
                        toast.success("扩展已禁用");
                      }}
                    >
                      禁用
                    </Button>
                  )}
                </>
              ) : (
                // ExtensionManager 不运行扩展，装上也用不了，所以不给安装按钮
                <span className="text-muted-foreground text-sm">
                  {i18next.t("shell.extensionsDisabled", { ns: "research" })}
                </span>
              )}
            </div>
          </div>

          <Tabs defaultValue="readme" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="readme">README</TabsTrigger>
              {installed && (
                <>
                  <TabsTrigger value="settings">设置</TabsTrigger>
                  <TabsTrigger value="keybinds">快捷键</TabsTrigger>
                  <TabsTrigger value="themes">
                    <Palette />
                    主题
                  </TabsTrigger>
                </>
              )}
            </TabsList>
            <TabsContent value="readme">
              {self.readmeContent.trim() === "" ? (
                <p className="text-muted-foreground">此扩展没有 README 文件</p>
              ) : (
                <div className="prose max-w-none">
                  <Markdown source={self.readmeContent} />
                </div>
              )}
            </TabsContent>
            {installed && (
              <>
                <TabsContent value="settings">
                  <div className="space-y-4">
                    {Object.entries(Settings.extensionSettings[self.metadata.extension?.id || ""] || {}).length ===
                    0 ? (
                      <p className="text-muted-foreground">该扩展没有设置项</p>
                    ) : (
                      Object.entries(Settings.extensionSettings[self.metadata.extension?.id || ""] || {}).map(
                        ([key, value]) => (
                          <Field key={key} title={key} description={`扩展 ${self.metadata.extension?.name} 的设置项`}>
                            {typeof value === "boolean" ? (
                              <Switch
                                checked={value}
                                onCheckedChange={(checked) => {
                                  const extensionId = self.metadata.extension?.id || "";
                                  const current = Settings.extensionSettings[extensionId] ?? {};
                                  Settings.extensionSettings = {
                                    ...Settings.extensionSettings,
                                    [extensionId]: {
                                      ...current,
                                      [key]: checked,
                                    },
                                  };
                                }}
                              />
                            ) : (
                              <Input
                                value={String(value)}
                                onChange={(e) => {
                                  const extensionId = self.metadata.extension?.id || "";
                                  const current = Settings.extensionSettings[extensionId] ?? {};
                                  Settings.extensionSettings = {
                                    ...Settings.extensionSettings,
                                    [extensionId]: {
                                      ...current,
                                      [key]: e.target.value,
                                    },
                                  };
                                }}
                              />
                            )}
                          </Field>
                        ),
                      )
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="themes">
                  <div className="space-y-2">
                    {(() => {
                      const extensionId = self.metadata.extension?.id || "";
                      const themes = Themes.getExtensionThemesByExtensionId(extensionId);
                      if (themes.length === 0) {
                        return <p className="text-muted-foreground">该扩展没有注册主题</p>;
                      }
                      return themes.map((theme) => (
                        <div
                          key={theme.metadata.id}
                          className="border-border flex items-center justify-between rounded-lg border p-3"
                        >
                          <div className="flex flex-col gap-1">
                            <span className="font-medium">{theme.metadata.name}</span>
                            {theme.metadata.description && (
                              <span className="text-muted-foreground text-sm">{theme.metadata.description}</span>
                            )}
                            <span className="text-muted-foreground text-xs">
                              {theme.metadata.type === "light" ? "浅色" : "深色"}
                            </span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              Settings.theme = theme.metadata.id;
                            }}
                          >
                            应用
                          </Button>
                        </div>
                      ));
                    })()}
                  </div>
                </TabsContent>
                <TabsContent value="keybinds">
                  <div className="space-y-1">
                    {extensionKeyBinds.length === 0 ? (
                      <p className="text-muted-foreground">该扩展没有注册快捷键</p>
                    ) : (
                      extensionKeyBinds.map((kb) => {
                        const prefix = `ext:${self.metadata.extension?.id || ""}:`;
                        const getKeyBindIcon = () => {
                          if (kb.icon) {
                            const IconComponent = kb.icon;
                            return <IconComponent />;
                          }
                          if (!kb.key || kb.key.trim() === "") return <Dot />;
                          if (!kb.isEnabled) return <KeyboardOff />;
                          if (kb.isContinuous) return <SquareAsterisk />;
                          const keyParts = kb.key.trim().split(" ");
                          if (keyParts.length > 1) return <SquareStack />;
                          return kb.key.includes("-") ? <Keyboard /> : <SquareRoundCorner />;
                        };

                        return (
                          <Field
                            key={kb.id}
                            icon={getKeyBindIcon()}
                            title={kb.id.replace(prefix, "")}
                            description={`快捷键 ID: ${kb.id}`}
                            className="border-accent border-b"
                          >
                            <div className="flex items-center gap-2">
                              <KeyBind
                                defaultValue={kb.key}
                                isContinuous={kb.isContinuous}
                                onChange={(value) => {
                                  KeyBindsUI.changeOneUIKeyBind(kb.id, value);
                                }}
                              />
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground text-sm">启用</span>
                                <Switch
                                  checked={kb.isEnabled}
                                  onCheckedChange={async () => {
                                    await KeyBindsUI.toggleEnabled(kb.id);
                                    forceUpdate();
                                    toast.info("状态已更新");
                                  }}
                                />
                              </div>
                            </div>
                          </Field>
                        );
                      })
                    )}
                  </div>
                </TabsContent>
              </>
            )}
          </Tabs>
        </div>
      );
    };

    return this._component;
  }

  render(): React.ReactNode {
    const Component = this.getComponent();
    return <Component />;
  }

  get icon() {
    if (this.iconBlobUrl) {
      const url = this.iconBlobUrl;
      return function ExtensionIcon({ className }: { className?: string }) {
        return <img src={url} className={className} style={{ objectFit: "contain" }} alt="" />;
      };
    }
    return Blocks;
  }
  get title() {
    return this.metadata.extension?.name || "扩展包";
  }
}
