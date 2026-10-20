import * as React from "react";
import { ArrowClockwise, MagnifyingGlass, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SprChallenge } from "@/lib/api";
import { formatIC } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackLink, StepHeading } from "./shared";

const NOTICE: Partial<Record<SprChallenge["status"], string>> = {
  captcha_wrong: "Captcha tidak tepat. Sila cuba gambar baharu di bawah.",
  captcha_expired: "Captcha telah ditukar oleh portal SPR. Sila masukkan nombor dalam gambar baharu.",
  invalid_answer: "Masukkan nombor seperti dalam gambar.",
  refresh_limit: "Gambar tidak boleh ditukar lagi. Sila cuba gambar ini.",
};

/**
 * The portal's own CAPTCHA, shown to the voter as-is. We never read or solve it: the voter types
 * the digits and the portal checks them, exactly as on mysprsemak.spr.gov.my.
 */
export function CaptchaStep({
  ic,
  challenge,
  busy,
  error,
  onSubmit,
  onRefresh,
  onBack,
}: {
  ic: string;
  challenge: SprChallenge;
  busy: boolean;
  error: string | null;
  onSubmit: (answer: string) => void;
  onRefresh: () => void;
  onBack: () => void;
}) {
  const [answer, setAnswer] = React.useState("");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // A new image means the old digits are useless.
  React.useEffect(() => {
    setAnswer("");
    inputRef.current?.focus();
  }, [challenge.captcha]);

  const notice = challenge.status === "portal_message" ? challenge.message : NOTICE[challenge.status];
  const shownError = localError ?? error ?? notice ?? null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // one submission per press, even on a double tap
    if (answer.length < 3) {
      setLocalError("Sila masukkan nombor dalam gambar captcha.");
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    onSubmit(answer);
  }

  return (
    <>
      <BackLink onClick={onBack} label="Tukar nombor kad pengenalan" />
      <StepHeading
        title="Pengesahan Portal SPR"
        lead="Semakan dibuat terus di portal MySPR Semak. Masukkan nombor yang anda lihat dalam gambar untuk meneruskan."
      />

      <form onSubmit={handleSubmit} noValidate className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        <div className="grid gap-2 p-5 sm:p-7">
          <p className="text-base text-muted-foreground">
            Nombor kad pengenalan: <span className="font-mono font-bold text-foreground">{formatIC(ic)}</span>
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <img
              src={challenge.captcha}
              alt="Gambar captcha daripada portal SPR"
              className="h-20 w-auto min-w-40 rounded-xl border bg-white object-contain p-1 [image-rendering:pixelated] sm:h-24"
            />
            <Button type="button" variant="outline" size="lg" onClick={onRefresh} disabled={busy}>
              <ArrowClockwise size={22} weight="bold" />
              Gambar lain
            </Button>
          </div>

          <Label htmlFor="captcha" className="mt-4">
            Nombor dalam gambar
          </Label>
          <Input
            ref={inputRef}
            id="captcha"
            name="captcha"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="go"
            maxLength={6}
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value.replace(/\D/g, "").slice(0, 6));
              setLocalError(null);
            }}
            aria-invalid={!!shownError}
            aria-describedby={shownError ? "captcha-error" : undefined}
            className="h-[4.5rem] max-w-64 px-4 font-mono text-[1.8rem] font-bold tracking-[0.3em]"
          />

          <div className="flex min-h-7 items-start justify-between gap-3">
            {shownError ? (
              <p id="captcha-error" role="alert" className="flex gap-2 text-base font-bold text-destructive">
                <WarningCircle size={22} weight="fill" className="mt-0.5 shrink-0" />
                {shownError}
              </p>
            ) : (
              <span />
            )}
            <span className={cn("shrink-0 text-base text-muted-foreground tabular-nums")}>
              Cubaan berbaki: {challenge.attempts_left}
            </span>
          </div>

          <Button type="submit" size="lg" className="mt-3 w-full" disabled={busy} aria-busy={busy}>
            <MagnifyingGlass size={24} weight="bold" />
            {busy ? "Sedang menyemak di portal SPR..." : "Semak"}
          </Button>
        </div>

        <p className="flex gap-2.5 border-t bg-inset px-5 py-4 text-base text-muted-foreground sm:px-7">
          <ShieldCheck size={24} weight="duotone" className="mt-0.5 shrink-0 text-primary" />
          Captcha ini daripada portal SPR. Nombor kad pengenalan anda tidak disimpan dalam log, dan sesi semakan
          ditutup sebaik sahaja keputusan diterima.
        </p>
      </form>
    </>
  );
}
