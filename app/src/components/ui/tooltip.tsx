"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { isResearchShell } from "@/core/research/ResearchShell";
import { cn } from "@/utils/cn";

// 科研模式下外层已有 TooltipProvider 时就共用它，这样在相邻按钮之间移动时不用每个都再等一次延迟
const TooltipProviderContext = React.createContext(false);

function TooltipProvider({
  delayDuration = isResearchShell() ? 500 : 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipProviderContext.Provider value={true}>
      <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
    </TooltipProviderContext.Provider>
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(TooltipProviderContext);
  if (isResearchShell() && hasProvider) {
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

function TooltipContent(props: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return isResearchShell() ? <AnchoredTooltipContent {...props} /> : <CursorTooltipContent {...props} />;
}

/** 科研模式：白底卡片，贴在触发元素旁边（side / align 生效），不跟随鼠标 */
function AnchoredTooltipContent({
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
        // index.css 里给跟随鼠标的提示框去掉了 Radix 的定位 transform，靠这个属性把这里排除在外
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

function CursorTooltipContent({
  className,
  sideOffset = 24,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [offset, setOffset] = React.useState({ left: 0, top: 0 });

  React.useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const x = event.clientX;
      const y = event.clientY;

      if (contentRef.current) {
        const { width, height } = contentRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = x + sideOffset;
        let top = y + sideOffset;

        if (left + width > viewportWidth) {
          left = x - width - sideOffset;
        }

        if (top + height > viewportHeight) {
          top = y - height - sideOffset;
        }

        // Final boundary checks
        left = Math.max(0, Math.min(left, viewportWidth - width));
        top = Math.max(0, Math.min(top, viewportHeight - height));

        setOffset({ left, top });
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [sideOffset]);

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={contentRef}
        data-slot="tooltip-content"
        hideWhenDetached
        className={cn(
          "bg-primary/75 border-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 pointer-events-none fixed z-50 w-max rounded-md border px-3 py-1.5 text-xs text-balance",
          className,
        )}
        style={{
          ...props.style,
          left: offset.left,
          top: offset.top,
        }}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
