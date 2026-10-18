import * as React from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { m, useReducedMotion } from "motion/react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { StepHeading } from "./shared";

export const LOADING_MIN_MS = 2400;

const TASKS = [
  { label: "Mengesahkan nombor kad pengenalan", at: 600 },
  { label: "Mencari daftar pemilih anda", at: 1400 },
  { label: "Menyediakan senarai calon", at: 2200 },
];

export function LoadingStep() {
  const reduce = useReducedMotion();
  const [done, setDone] = React.useState(0);

  React.useEffect(() => {
    const timers = TASKS.map((t, i) => setTimeout(() => setDone(i + 1), reduce ? 150 * (i + 1) : t.at));
    return () => timers.forEach(clearTimeout);
  }, [reduce]);

  return (
    <div aria-busy="true">
      <StepHeading title="Sedang menyemak maklumat anda" lead="Sila tunggu sebentar. Jangan tutup halaman ini." />

      <div className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        {/* Determinate bar: tells the user how far along the check is. */}
        <div className="h-1.5 bg-primary-soft">
          <m.div
            className="h-full origin-left bg-primary"
            initial={{ scaleX: 0.04 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: reduce ? 0.4 : LOADING_MIN_MS / 1000, ease: [0.3, 0.6, 0.4, 1] }}
          />
        </div>
        <ol className="grid gap-5 p-5 sm:p-7">
          {TASKS.map((task, i) => {
            const state = i < done ? "done" : i === done ? "active" : "pending";
            return (
              <li key={task.label} className="flex items-center gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center">
                  {state === "done" ? (
                    <m.span
                      initial={reduce ? false : { scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 420, damping: 22 }}
                      className="text-primary"
                    >
                      <CheckCircle size={34} weight="fill" />
                    </m.span>
                  ) : (
                    <Circle
                      size={30}
                      weight={state === "active" ? "bold" : "regular"}
                      className={cn(state === "active" ? "animate-pulse text-primary motion-reduce:animate-none" : "text-input/60")}
                    />
                  )}
                </span>
                <span className={cn("text-lg", state === "pending" ? "text-muted-foreground" : "font-bold")}>{task.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="sr-only" aria-live="polite">
        {done < TASKS.length ? TASKS[done].label : "Hampir siap"}
      </p>

      {/* Skeleton in the shape of the voter card that comes next */}
      <div className="mt-5 rounded-2xl border bg-card p-5 sm:p-7" aria-hidden>
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="grid flex-1 gap-2.5">
            <Skeleton className="h-6 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </div>
    </div>
  );
}
