import { GripHorizontal, GripVertical } from "lucide-react";
import * as React from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";

import { cn } from "../../lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof PanelGroup>) => (
  <PanelGroup className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)} {...props} />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  handleDirection = "horizontal",
  ...props
}: React.ComponentProps<typeof PanelResizeHandle> & {
  withHandle?: boolean;
  handleDirection?: "horizontal" | "vertical";
}) => (
  <PanelResizeHandle
    className={cn(
      "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      "data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
      className,
    )}
    {...props}
  >
    {withHandle ? (
      <div
        className={cn(
          "z-10 flex items-center justify-center rounded-full border border-border bg-card",
          handleDirection === "vertical" ? "h-3 w-8" : "h-8 w-3",
        )}
      >
        {handleDirection === "vertical" ? <GripHorizontal className="h-4 w-4" /> : <GripVertical className="h-4 w-4" />}
      </div>
    ) : null}
  </PanelResizeHandle>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
