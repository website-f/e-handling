import * as React from "react";
import { ArrowRight, Info, PaperPlaneTilt, WarningCircle } from "@phosphor-icons/react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { ApiError, type Question } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BackLink, StepHeading, StickyActions } from "./shared";

export function QuestionStep({
  question,
  index,
  total,
  value,
  hadPrevious,
  isLast,
  onChange,
  onNext,
  onBack,
}: {
  question: Question;
  index: number;
  total: number;
  value: string | undefined;
  hadPrevious: boolean;
  isLast: boolean;
  onChange: (key: string) => void;
  onNext: () => Promise<void> | void;
  onBack: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const promptId = `prompt-${question.id}`;

  async function next() {
    if (!value || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onNext();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Jawapan tidak dapat dihantar. Sila cuba lagi.");
      setBusy(false);
    }
  }

  return (
    <>
      {!busy && <BackLink onClick={onBack} />}
      <StepHeading
        kicker={
          <span className="flex items-center gap-3">
            Soalan {index + 1} daripada {total}
            <span aria-hidden className="flex gap-1.5">
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={cn("h-2 rounded-full transition-all", i === index ? "w-6 bg-primary" : i < index ? "w-2 bg-primary" : "w-2 bg-border")} />
              ))}
            </span>
          </span>
        }
        title={<span id={promptId}>{question.prompt}</span>}
        lead="Pilih satu jawapan."
      />

      {hadPrevious && index === 0 && (
        <Alert variant="warning" className="mb-5">
          <Info size={24} weight="fill" />
          <span>Anda pernah menjawab tinjauan ini. Jawapan lama anda telah dipilih. Jawapan baharu akan menggantikannya.</span>
        </Alert>
      )}

      <RadioGroup value={value ?? ""} onValueChange={onChange} aria-labelledby={promptId} disabled={busy} className="md:grid-cols-2 md:auto-rows-fr">
        {question.options.map((o) => (
          <RadioCard key={o.key} value={o.key} letter={o.key}>
            {o.label}
          </RadioCard>
        ))}
      </RadioGroup>

      {error && (
        <Alert variant="destructive" className="mt-5">
          <WarningCircle size={24} weight="fill" />
          <span>{error}</span>
        </Alert>
      )}

      <StickyActions hint={value ? undefined : "Pilih satu jawapan untuk teruskan."}>
        <Button size="lg" onClick={next} disabled={!value || busy} className="w-full sm:w-auto">
          {isLast ? (busy ? "Sedang menghantar..." : "Hantar Jawapan") : "Seterusnya"}
          {isLast ? <PaperPlaneTilt size={22} weight="bold" /> : <ArrowRight size={22} weight="bold" />}
        </Button>
      </StickyActions>
    </>
  );
}
