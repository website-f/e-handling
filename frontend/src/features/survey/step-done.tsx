import { CheckCircle } from "@phosphor-icons/react";
import { m, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import type { Answers, Question, SubmitResult, Voter } from "@/lib/api";
import { formatDateTimeMs } from "@/lib/format";
import { StepHeading } from "./shared";

export function DoneStep({
  voter,
  questions,
  answers,
  result,
  onFinish,
}: {
  voter: Voter;
  questions: Question[];
  answers: Answers;
  result: SubmitResult;
  onFinish: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <m.div
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 18 }}
          className="flex size-20 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary ring-8 ring-primary-soft/40"
        >
          <CheckCircle size={56} weight="fill" />
        </m.div>
        <StepHeading
          title="Terima kasih"
          lead={
            <>
              <strong className="text-foreground">{voter.full_name}</strong>,{" "}
              {result.updated ? "jawapan anda telah dikemas kini." : "jawapan anda telah disimpan."}
            </>
          }
        />
      </div>

      <section aria-label="Ringkasan jawapan" className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b bg-inset px-5 py-4 sm:px-6">
          <h2 className="text-sm font-bold tracking-wide">RINGKASAN JAWAPAN</h2>
          <p className="text-sm text-muted-foreground">
            No. rujukan <strong className="font-mono text-base text-foreground">{result.id.slice(0, 8).toUpperCase()}</strong>
          </p>
        </div>
        <dl className="grid gap-3 p-4 sm:p-5">
          {questions.map((q, i) => {
            const opt = q.options.find((o) => o.key === answers[q.id]);
            return (
              <div key={q.id} className="rounded-xl bg-inset px-4 py-3.5">
                <dt className="text-base text-muted-foreground">
                  Soalan {i + 1}. {q.prompt}
                </dt>
                <dd className="mt-2 flex items-center gap-3 text-lg font-bold">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-base text-primary-foreground">
                    {opt?.key}
                  </span>
                  {opt?.label}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="border-t px-5 py-3.5 text-sm text-muted-foreground sm:px-6">Dihantar pada {formatDateTimeMs(result.submitted_at)}</p>
      </section>

      <div className="mt-8">
        <Button size="lg" onClick={onFinish} className="w-full sm:w-auto sm:min-w-56">
          Selesai
        </Button>
      </div>
    </>
  );
}
