import * as React from "react";
import { IdentificationCard, MagnifyingGlass, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatIC, onlyDigits } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StepHeading } from "./shared";

const SAMPLE_ICS = [
  { ic: "990123125571", who: "Pemilih muda" },
  { ic: "470621125137", who: "Warga emas" },
];

export function IcStep({
  initialIc,
  error,
  onSubmit,
}: {
  initialIc: string;
  error: string | null;
  onSubmit: (digits: string) => void;
}) {
  const [digits, setDigits] = React.useState(initialIc);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [serverErrorDismissed, setServerErrorDismissed] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const shownError = localError ?? (serverErrorDismissed ? null : error);
  const complete = digits.length === 12;

  function set(value: string) {
    setDigits(onlyDigits(value));
    setLocalError(null);
    setServerErrorDismissed(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete) {
      setLocalError(
        digits.length === 0
          ? "Sila masukkan nombor kad pengenalan anda."
          : `Nombor kad pengenalan mesti 12 digit. Anda telah masukkan ${digits.length} digit.`,
      );
      inputRef.current?.focus();
      return;
    }
    onSubmit(digits);
  }

  return (
    <>
      <StepHeading
        autoFocus={false}
        title="Semak Daftar Pemilih"
        lead="Masukkan nombor kad pengenalan anda untuk melihat tempat mengundi dan senarai calon di kawasan anda."
      />

      <form onSubmit={handleSubmit} noValidate className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        <div className="grid grid-cols-1 gap-2 p-5 sm:p-7">
          <Label htmlFor="ic">Nombor Kad Pengenalan (MyKad)</Label>
          <p id="ic-help" className="text-base text-muted-foreground">
            12 digit nombor. Contoh: <span className="font-mono">990123-12-5571</span>
          </p>

          <div className="relative mt-2 min-w-0">
            <IdentificationCard
              size={30}
              weight="duotone"
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 left-4 hidden -translate-y-1/2 transition-colors min-[400px]:block",
                complete ? "text-primary" : "text-muted-foreground",
              )}
            />
            <Input
              ref={inputRef}
              id="ic"
              name="ic"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="search"
              placeholder="000000-00-0000"
              value={formatIC(digits)}
              onChange={(e) => set(e.target.value)}
              aria-invalid={!!shownError}
              aria-describedby={shownError ? "ic-help ic-error" : "ic-help"}
              className="h-[4.5rem] px-4 font-mono text-[1.45rem] font-bold tracking-[0.06em] placeholder:font-normal placeholder:text-muted-foreground/70 min-[400px]:pl-14 min-[400px]:text-[1.6rem] sm:text-[1.8rem]"
            />
          </div>

          <div className="flex min-h-7 items-start justify-between gap-3">
            {shownError ? (
              <p id="ic-error" role="alert" className="flex gap-2 text-base font-bold text-destructive">
                <WarningCircle size={22} weight="fill" className="mt-0.5 shrink-0" />
                {shownError}
              </p>
            ) : (
              <span />
            )}
            <span
              className={cn("shrink-0 font-mono text-base tabular-nums", complete ? "font-bold text-primary" : "text-muted-foreground")}
              aria-live="polite"
            >
              {digits.length}/12
            </span>
          </div>

          <Button type="submit" size="lg" className="mt-3 w-full">
            <MagnifyingGlass size={24} weight="bold" />
            Semak Sekarang
          </Button>
        </div>

        <p className="flex gap-2.5 border-t bg-inset px-5 py-4 text-base text-muted-foreground sm:px-7 lg:hidden">
          <ShieldCheck size={24} weight="duotone" className="mt-0.5 shrink-0 text-primary" />
          Maklumat anda hanya digunakan untuk semakan dan tinjauan ini.
        </p>
      </form>

      <section aria-label="Nombor contoh" className="mt-6 rounded-2xl border border-dashed border-input/50 p-4 sm:p-5">
        <p className="text-base font-bold">Mod demo</p>
        <p className="mt-0.5 text-sm text-muted-foreground">Tekan salah satu nombor contoh untuk mencuba.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {SAMPLE_ICS.map((s) => (
            <button
              key={s.ic}
              type="button"
              onClick={() => set(s.ic)}
              className="flex min-h-14 flex-col items-start justify-center rounded-xl border-2 bg-card px-4 py-2 text-left transition-colors hover:border-input"
            >
              <span className="font-mono text-lg leading-tight font-bold whitespace-nowrap tabular-nums">{formatIC(s.ic)}</span>
              <span className="text-sm text-muted-foreground">{s.who}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
