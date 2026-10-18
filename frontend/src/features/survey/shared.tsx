import * as React from "react";
import { ArrowLeft, Check, ShieldCheck } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export const STAGES = [
  { title: "Semak IC", desc: "Masukkan nombor kad pengenalan" },
  { title: "Maklumat", desc: "Sahkan maklumat pemilih" },
  { title: "Calon", desc: "Lihat calon di kawasan anda" },
  { title: "Tinjauan", desc: "Jawab 2 soalan ringkas" },
] as const;

/** Desktop: vertical step rail in a sticky sidebar. `current` = STAGES.length means all done. */
export function StepRail({ current }: { current: number }) {
  return (
    <div className="grid gap-6">
      <nav aria-label="Kemajuan">
        <ol className="grid">
          {STAGES.map((s, i) => {
            const state = i < current ? "done" : i === current ? "current" : "todo";
            const last = i === STAGES.length - 1;
            return (
              <li key={s.title} aria-current={state === "current" ? "step" : undefined} className="relative flex gap-4 pb-7 last:pb-0">
                {!last && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-11 bottom-1 left-[1.3rem] w-0.5 rounded-full transition-colors duration-500",
                      i < current ? "bg-primary" : "bg-border",
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative flex size-11 shrink-0 items-center justify-center rounded-full border-2 text-base font-bold transition-colors duration-300",
                    state === "done" && "border-primary bg-primary text-primary-foreground",
                    state === "current" && "border-primary bg-primary-soft text-foreground",
                    state === "todo" && "border-border bg-card text-muted-foreground",
                  )}
                >
                  {state === "done" ? <Check size={20} weight="bold" /> : i + 1}
                </span>
                <span className="pt-1.5">
                  <span className={cn("block text-lg leading-tight font-bold", state === "todo" && "text-muted-foreground")}>
                    {s.title}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{s.desc}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="flex gap-3 rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
        <ShieldCheck size={22} weight="duotone" className="shrink-0 text-primary" />
        <p>Maklumat anda hanya digunakan untuk semakan dan tinjauan ini.</p>
      </div>
    </div>
  );
}

/** Mobile/tablet: compact segmented progress above the content. */
export function MobileProgress({ current }: { current: number }) {
  const shown = Math.min(current, STAGES.length - 1);
  return (
    <nav aria-label="Kemajuan" className="mb-6">
      <div className="mb-2.5 flex items-baseline justify-between gap-3 text-base">
        <span className="font-bold">{STAGES[shown].title}</span>
        <span className="text-muted-foreground tabular-nums">
          Langkah {shown + 1} / {STAGES.length}
        </span>
      </div>
      <ol className="grid grid-cols-4 gap-1.5">
        {STAGES.map((s, i) => (
          <li key={s.title} aria-current={i === current ? "step" : undefined} aria-label={s.title}>
            <span className={cn("block h-1.5 rounded-full transition-colors duration-300", i <= current ? "bg-primary" : "bg-border")} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function BackLink({ onClick, label = "Kembali" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 mb-3 inline-flex h-11 items-center gap-2 rounded-xl px-2 text-lg font-bold text-primary transition-colors hover:bg-primary-soft"
    >
      <ArrowLeft size={22} weight="bold" />
      {label}
    </button>
  );
}

/** Step title that takes focus on mount so screen readers announce each new screen. */
export function StepHeading({
  title,
  lead,
  kicker,
  autoFocus = true,
}: {
  title: React.ReactNode;
  lead?: React.ReactNode;
  kicker?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const ref = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div className="mb-6 sm:mb-8">
      {kicker && <p className="mb-2 text-base font-bold text-primary">{kicker}</p>}
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-[1.75rem] leading-[1.15] font-bold tracking-[-0.015em] text-balance outline-none sm:text-[2.25rem]"
      >
        {title}
      </h1>
      {lead && <p className="mt-3 max-w-[58ch] text-lg text-pretty text-muted-foreground">{lead}</p>}
    </div>
  );
}

/**
 * Primary action. On phones it sticks to the bottom of the screen so the next step is always in
 * reach of the thumb; from `sm` up it sits inline after the content.
 */
export function StickyActions({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 mt-8 border-t bg-background/92 px-4 pt-3 pb-safe backdrop-blur-md sm:static sm:mx-0 sm:mt-10 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:items-center sm:justify-between sm:gap-6">
        {children}
        {hint && <p className="text-center text-base text-muted-foreground sm:text-left">{hint}</p>}
      </div>
    </div>
  );
}
