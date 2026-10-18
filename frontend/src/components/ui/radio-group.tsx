import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { CheckCircle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-3", className)} {...props} />;
}

/** Whole-card radio: the entire row is the tap target (min 72px tall). */
function RadioCard({
  className,
  letter,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & { letter: string }) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-card"
      className={cn(
        "group flex min-h-[4.5rem] w-full items-center gap-4 rounded-xl border-2 border-border bg-card px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150",
        "hover:border-input active:scale-[0.99]",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary-soft",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-input text-lg font-bold transition-colors group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground"
      >
        {letter}
      </span>
      <span className="flex-1 text-lg leading-snug font-bold sm:text-xl">{children}</span>
      <RadioGroupPrimitive.Indicator className="text-primary">
        <CheckCircle weight="fill" size={30} />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioCard };
