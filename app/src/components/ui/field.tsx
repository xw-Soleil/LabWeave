import { Button } from "@/components/ui/button";
import { FileName } from "@/components/ui/file-name";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { emitResearchEvent } from "@/core/research/ResearchShell";
import { Settings, settingsSchema } from "@/core/service/Settings";
import { cn } from "@/utils/cn";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import _ from "lodash";
import { ChevronRight, Eye, EyeOff, FolderOpen, RotateCcw } from "lucide-react";
import React, { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

// 备份不写进研究文件夹，AutoSaveBackupService 忽略这两种「备份放在原文件旁边」的策略，选项也不显示
const hiddenOptions: Partial<Record<keyof Settings, string[]>> = {
  autoBackupStrategy: ["sideBySide", "subfolder"],
};

function RangeNumberInput({
  value,
  min,
  max,
  step,
  settingKey,
  onChange,
  className = "w-24",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  settingKey: keyof Settings;
  onChange: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    if (parsed < min) {
      toast.warning(`最小值为 ${min}，已自动修正`, { id: `field-clamp-${settingKey}`, duration: 2000 });
    } else if (parsed > max) {
      toast.warning(`最大值为 ${max}，已自动修正`, { id: `field-clamp-${settingKey}`, duration: 2000 });
    }
    const next = Math.min(max, Math.max(min, parsed));
    onChange(next);
    setDraft(String(next));
  };

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
    />
  );
}

/** 紧凑设置行：左边标题和说明，右边控件 */
export function SettingRow({
  title,
  description = "",
  children,
  className,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("group/row flex min-h-[52px] items-center gap-4 px-4 py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-foreground text-[13px] leading-[18px] font-medium select-text">{title}</div>
        {description.trim() && <SettingRowDescription text={description.trim()} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** 说明最多显示两行；放不下时可以点「展开」看全文，悬停也能看到全文 */
function SettingRowDescription({ text }: { text: string }) {
  const { t } = useTranslation("research");
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="text-muted-foreground text-[12px] leading-[18px]">
      <p
        ref={ref}
        className={cn("break-words whitespace-pre-line select-text", !expanded && "line-clamp-2")}
        title={!expanded && overflowing ? text : undefined}
      >
        {text}
      </p>
      {(expanded || overflowing) && (
        <button
          type="button"
          className="hover:text-foreground underline-offset-2 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("settings.collapse") : t("settings.expand")}
        </button>
      )}
    </div>
  );
}

function settingSchemaInfo(settingKey: keyof Settings) {
  // 解包 ZodDefault 拿到 innerType 和 defaultValue（Zod v4 用 _def.type，值为小写，如 "boolean"/"number"/"string"/"union"）
  const schema = settingsSchema.shape[settingKey] as any;
  const innerType = schema._def.innerType;
  return {
    innerType,
    innerTypeName: (innerType._def.type ?? "") as string,
    bag: innerType._zod?.bag ?? {},
    defaultValue: schema._def.defaultValue as unknown,
  };
}

/**
 * 设置名和说明：有 researchTitle / researchDescription 就用它们
 * （title / description 提到了这里没有的东西，或者讲得不清楚时才写）
 */
export function researchSettingText(t: TFunction<"settings">, settingKey: string) {
  return {
    title: t(`${settingKey}.researchTitle`, { defaultValue: t(`${settingKey}.title`) }),
    description: t(`${settingKey}.researchDescription`, {
      defaultValue: t(`${settingKey}.description`, { defaultValue: "" }),
    }),
  };
}

const compactInputClass = "h-7 w-56 px-2 text-[13px] md:text-[13px]";

export function SettingField({ settingKey, extra }: { settingKey: keyof Settings; extra?: React.ReactNode }) {
  const { t } = useTranslation("settings");
  const { t: tr } = useTranslation("research");
  const [value, setValue] = useState<any>(Settings[settingKey]);
  // 同一项可能在别处被改（标题栏的浅色/深色切换、选择研究文件夹），这里跟着更新
  useEffect(() => Settings.watch(settingKey, setValue), [settingKey]);
  const update = (next: unknown) => {
    setValue(next);
    (Settings as unknown as Record<string, unknown>)[settingKey] = next;
  };

  const { innerType, innerTypeName, bag, defaultValue } = settingSchemaInfo(settingKey);
  const { title, description } = researchSettingText(t, settingKey);
  const canReset = settingKey !== "researchFolderPath";
  const isDefault = _.isEqual(value, defaultValue);

  let control: React.ReactNode;
  if (settingKey === "researchFolderPath") {
    control = <ResearchFolderPicker path={value} />;
  } else if (innerTypeName === "string") {
    control =
      settingKey === "aiCustomHeaders" ? (
        <Textarea
          value={value}
          onChange={(e) => update(e.target.value)}
          rows={3}
          className="w-56 px-2 font-mono text-[12px] md:text-[12px]"
        />
      ) : settingKey === "aiApiKey" ? (
        <SecretInput value={value} onChange={update} />
      ) : (
        <Input
          value={value}
          onChange={(e) => update(e.target.value)}
          spellCheck={false}
          className={compactInputClass}
        />
      );
  } else if (innerTypeName === "number" && bag.minimum !== undefined && bag.maximum !== undefined) {
    const step = bag.format === "safeint" ? 1 : 0.01;
    control = (
      <>
        <Slider
          value={[value]}
          onValueChange={([v]) => update(v)}
          min={bag.minimum}
          max={bag.maximum}
          step={step}
          className="w-32"
        />
        <RangeNumberInput
          value={value}
          min={bag.minimum}
          max={bag.maximum}
          step={step}
          settingKey={settingKey}
          onChange={update}
          className="h-7 w-16 px-2 text-[13px] md:text-[13px]"
        />
      </>
    );
  } else if (innerTypeName === "number") {
    control = (
      <Input
        value={value}
        onChange={(e) => update(e.target.valueAsNumber)}
        type="number"
        className="h-7 w-24 px-2 text-[13px] md:text-[13px]"
      />
    );
  } else if (innerTypeName === "boolean") {
    control = <Switch checked={value} onCheckedChange={update} />;
  } else if (innerTypeName === "union") {
    control = (
      <Select value={value} onValueChange={update}>
        <SelectTrigger size="sm" className="max-w-56 min-w-28 text-[13px] data-[size=sm]:h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {innerType._def.options.map((opt: any) => {
            const it = opt._def.values?.[0] ?? opt._def.value;
            if (hiddenOptions[settingKey]?.includes(it)) return null;
            return (
              <SelectItem key={it} value={it} className="text-[13px]">
                {t(`${settingKey}.options.${it}`)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    );
  } else if (innerTypeName === "tuple") {
    control = (
      <input
        type="color"
        value={`#${(value[0] as number).toString(16).padStart(2, "0")}${(value[1] as number).toString(16).padStart(2, "0")}${(value[2] as number).toString(16).padStart(2, "0")}`}
        onChange={(e) => {
          const hex = e.target.value;
          update([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
        }}
        className="border-border h-7 w-10 cursor-pointer rounded-[6px] border"
      />
    );
  } else {
    control = <span className="text-muted-foreground text-[12px]">unknown type</span>;
  }

  return (
    <SettingRow title={title} description={description}>
      {canReset && (
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="icon"
              aria-label={tr("settings.resetToDefault")}
              className={cn(
                "text-muted-foreground size-7 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                isDefault && "invisible",
              )}
              onClick={() => update(_.cloneDeep(defaultValue))}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tr("settings.resetToDefault")}</TooltipContent>
        </Tooltip>
      )}
      {extra}
      {control}
    </SettingRow>
  );
}

/** 密钥默认遮住，可以临时显示出来核对 */
function SecretInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation("research");
  const [visible, setVisible] = useState(false);
  const label = visible ? t("settings.hideKey") : t("settings.showKey");
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(compactInputClass, "pr-8")}
      />
      <Tooltip>
        <TooltipTrigger>
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            className="text-muted-foreground absolute top-0 right-0 size-7"
            onClick={() => setVisible((it) => !it)}
          >
            {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * 研究文件夹只能通过系统的选择框换：原来的文本框每敲一个字就会写设置，
 * 研究文件夹一变就会重新登记，半截路径也会被当成新文件夹。
 */
function ResearchFolderPicker({ path }: { path: string }) {
  const { t } = useTranslation("research");
  const folderName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return (
    <>
      <div className="bg-muted flex h-7 w-48 min-w-0 items-center overflow-hidden rounded-[6px] px-2 text-[13px]">
        {path ? (
          // 路径中间省略，结尾的文件夹名始终可见
          <FileName name={path} title={path} tailChars={Math.min(folderName.length + 1, 24)} />
        ) : (
          <span className="text-muted-foreground truncate">{t("settings.folderNotChosen")}</span>
        )}
      </div>
      <Button variant="outline" size="sm" className="h-7 text-[13px]" onClick={() => emitResearchEvent("chooseFolder")}>
        {t("settings.chooseFolder")}
      </Button>
      <Tooltip>
        <TooltipTrigger>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("settings.revealFolder")}
            className="size-7"
            disabled={!path}
            onClick={() => {
              shellOpen(path).catch((error) =>
                toast.error(t("settings.revealFolderFailed", { message: String(error) })),
              );
            }}
          >
            <FolderOpen />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("settings.revealFolder")}</TooltipContent>
      </Tooltip>
    </>
  );
}

export function ButtonField({
  title,
  description = "",
  label = "",
  disabled = false,
  onClick = () => {},
  icon = <></>,
}: {
  title: string;
  description?: string;
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <Field title={title} description={description} icon={icon}>
      <Button disabled={disabled} onClick={onClick}>
        {label}
      </Button>
    </Field>
  );
}

const fieldColors = {
  default: "hover:bg-field-group-hover-bg",
  celebrate: "border-2 border-green-500/20 hover:bg-green-500/25",
  danger: "border-2 border-red-500/20 hover:bg-red-500/25",
  warning: "border-2 border-yellow-500/20 hover:bg-yellow-500/25",
  thinking: "border-2 border-blue-500/20 hover:bg-blue-500/25",
  imaging: "border-2 border-purple-500/20 hover:bg-purple-500/25",
};

/**
 * 每一个设置段
 * @param param0
 * @returns
 */
export function Field({
  title = "",
  description = "",
  children = <></>,
  extra = <></>,
  color = "default",
  icon = <></>,
  className = "",
  style = {},
  onClick = () => {},
  titleExtra,
}: {
  title?: string;
  description?: string;
  children?: React.ReactNode;
  extra?: React.ReactNode;
  color?: "default" | "celebrate" | "danger" | "warning" | "thinking" | "imaging";
  icon?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  titleExtra?: React.ReactNode;
}) {
  return (
    <div
      className={cn("group/field flex w-full flex-col items-start gap-2 rounded-xl p-4", fieldColors[color], className)}
      style={style}
      onClick={onClick}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span>{icon}</span>
          <div className="flex flex-col">
            <span className="inline-flex items-center gap-1 select-text">
              {title}
              {titleExtra}
            </span>
            <span className="text-muted-foreground text-xs select-text">
              {description.split("\n").map((dd, ii) => (
                <p key={ii} className="text-xs">
                  {dd}
                </p>
              ))}
            </span>
          </div>
        </div>
        <div className="flex-1"></div>
        {children}
      </div>
      {extra}
    </div>
  );
}

/**
 * 用于给各种设置项提供一个分类组
 * @param param0
 * @returns
 */
export function FieldGroup({
  title = "",
  icon = null,
  children = null,
  className = "",
  description = "",
}: {
  title?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeight] = useState<number | string>(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [isAnimating, setAnimating] = useState(false);
  const [shouldMount, setShouldMount] = useState(isOpen);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (isOpen) setHeight(el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setHeight(0);
      return;
    }

    requestAnimationFrame(() => {
      const el = innerRef.current;
      if (el) setHeight(el.offsetHeight);
    });
  }, [isOpen]);

  const handleToggle = () => {
    setAnimating(true);
    const next = !isOpen;
    setIsOpen(next);

    if (next) {
      setShouldMount(true); // 展开：立即挂载
    } else {
      setTimeout(() => {
        // 折叠：动画后再卸载
        setShouldMount(false);
      }, 250);
    }
    setTimeout(() => setAnimating(false), 500);
  };

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      <div
        className="text-muted-foreground hover:text-foreground my-2 flex cursor-pointer items-center gap-2 pt-4 pl-4 text-sm"
        onClick={handleToggle}
      >
        <span>{icon}</span>
        <span>{title}</span>
        <ChevronRight className={cn(isOpen && "rotate-90")} />
      </div>

      {description && isOpen && <div className="text-muted-foreground pl-4 text-xs">{description}</div>}

      <div ref={contentRef} className="overflow-hidden rounded-xl transition-all" style={{ height }}>
        {shouldMount && (
          <div
            ref={innerRef}
            className={cn("transition-all", !isOpen && !isAnimating && "pointer-events-none opacity-0")}
          >
            <div className="bg-field-group-bg group/field-group">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}
