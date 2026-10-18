import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/** shadcn-style Dialog: a bottom sheet on phones (thumb reach), a centred panel from `sm` up. */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;

function SheetContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px] data-[state=open]:animate-[eh-fade_200ms_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col bg-card text-card-foreground shadow-lift outline-none",
          "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t data-[state=open]:animate-[eh-sheet-up_260ms_cubic-bezier(0.16,1,0.3,1)]",
          "sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[80dvh] sm:w-[min(40rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:data-[state=open]:animate-[eh-fade_200ms_ease-out]",
          "motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto mt-2.5 h-1.5 w-12 shrink-0 rounded-full bg-border sm:hidden" />
        <div className="flex items-start justify-between gap-4 border-b px-5 pt-3 pb-4 sm:px-6 sm:pt-5">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-xl leading-snug font-bold break-words">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-base text-muted-foreground">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">Butiran</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-xl text-foreground hover:bg-muted" aria-label="Tutup">
            <X size={24} weight="bold" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-safe sm:px-6 sm:pb-6">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetTrigger, SheetContent };
