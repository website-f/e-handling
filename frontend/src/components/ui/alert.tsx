import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("flex gap-3 rounded-xl px-4 py-3 text-base leading-snug [&_svg]:mt-0.5 [&_svg]:shrink-0", {
  variants: {
    variant: {
      info: "bg-muted text-foreground",
      success: "bg-primary-soft text-foreground [&_svg]:text-primary",
      warning: "bg-warning-soft text-warning-foreground",
      destructive: "bg-destructive-soft text-foreground [&_svg]:text-destructive",
    },
  },
  defaultVariants: { variant: "info" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role={variant === "destructive" ? "alert" : "status"} className={cn(alertVariants({ variant }), className)} {...props} />;
}

export { Alert };
