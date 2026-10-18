import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-xl font-bold transition-[transform,background-color,border-color,color] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-soft hover:bg-primary-hover",
        soft: "bg-primary-soft text-foreground hover:bg-primary-line/60",
        outline: "border-2 border-input/70 bg-card text-foreground hover:border-input hover:bg-inset",
        ghost: "text-foreground hover:bg-muted",
        link: "text-primary underline underline-offset-4 hover:no-underline",
      },
      size: {
        default: "h-14 px-6 text-lg",
        lg: "h-16 px-8 text-xl",
        sm: "h-11 px-4 text-base",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
