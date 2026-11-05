"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/utils/cn";

// 外层已有 TooltipProvider 时就共用它，这样在相邻按钮之间移动时不用每个都再等一次延迟
const TooltipProviderContext = React.createContext(false);

function TooltipProvider({ delayDuration = 500, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderContext.Provider value={true}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
    </TooltipProviderContext.Provider>
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(TooltipProviderContext);
  if (hasProvider) {
    return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
  }
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" asChild {...props} />;
}

/** 白底卡片，贴在触发元素旁边（side / align 生效），不跟随鼠标 */
function TooltipContent({
  className,
  side = "bottom",
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        // index.css 里有条规则会去掉提示框外层 Radix 定位用的 transform，靠这个属性把这里排除在外
        data-pg-tooltip="anchored"
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        hideWhenDetached
        className={cn(
          "bg-popover text-popover-foreground border-border animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 pointer-events-none z-50 w-max max-w-80 rounded-[6px] border px-2 py-1 text-[12px] leading-4 break-words shadow-md",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
