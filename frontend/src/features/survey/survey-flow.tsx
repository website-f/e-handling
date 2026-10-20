import * as React from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { AppShell } from "@/components/app-shell";
import { api, ApiError, type Answers, type AppConfig, type LookupResult, type SprChallenge, type SubmitResult } from "@/lib/api";
import { sleep } from "@/lib/utils";
import { MobileProgress, StepRail } from "./shared";
import { IcStep } from "./step-ic";
import { CaptchaStep } from "./step-captcha";
import { LoadingStep, LOADING_MIN_MS } from "./step-loading";
import { DetailsStep } from "./step-details";
import { CandidatesStep } from "./step-candidates";
import { QuestionStep } from "./step-question";
import { DoneStep } from "./step-done";

type Phase =
  | { name: "ic" }
  | { name: "loading" }
  | { name: "captcha" }
  | { name: "details" }
  | { name: "candidates" }
  | { name: "question"; index: number }
  | { name: "done" };

const STAGE_OF: Record<Phase["name"], number> = {
  ic: 0, loading: 0, captcha: 0, details: 1, candidates: 2, question: 3, done: 4,
};

export function SurveyFlow() {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = React.useState<Phase>({ name: "ic" });
  const [ic, setIc] = React.useState("");
  const [icError, setIcError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<LookupResult | null>(null);
  const [answers, setAnswers] = React.useState<Answers>({});
  const [result, setResult] = React.useState<SubmitResult | null>(null);
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [challenge, setChallenge] = React.useState<SprChallenge | null>(null);
  const [captchaBusy, setCaptchaBusy] = React.useState(false);
  const [captchaError, setCaptchaError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api.config().then(setConfig, () => setConfig({ voter_source: "demo", demo: true }));
  }, []);

  // A portal session holds one of a limited number of browser slots: give it back as soon as the
  // voter leaves the CAPTCHA screen (Back button, start over) or closes the tab.
  const openJob = phase.name === "captcha" ? challenge?.job_id : undefined;
  const liveJob = React.useRef<string | undefined>(undefined);
  liveJob.current = challenge?.job_id; // cleared when the lookup ends (record shown or error)
  React.useEffect(() => {
    if (!openJob) return;
    const onHide = () => api.sprCancel(openJob, true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      // Left the captcha screen while the session is still open (Back, start over): cancel it.
      if (liveJob.current === openJob) api.sprCancel(openJob);
    };
  }, [openJob]);

  // Forward moves push a history entry so the phone's Back button walks back one screen
  // instead of leaving the site.
  const forward = React.useCallback((next: Phase) => {
    window.history.pushState({ eh: true }, "");
    setPhase(next);
  }, []);
  const back = React.useCallback(() => window.history.back(), []);

  React.useEffect(() => {
    const onPop = () =>
      setPhase((p) => {
        switch (p.name) {
          case "captcha": return { name: "ic" };
          case "details": return { name: "ic" };
          case "candidates": return { name: "details" };
          case "question": return p.index === 0 ? { name: "candidates" } : { name: "question", index: p.index - 1 };
          case "done": return { name: "ic" };
          default: return p;
        }
      });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [phase]);

  function showRecord(res: LookupResult) {
    setData(res);
    setAnswers(res.previous_response?.answers ?? {});
    setResult(null);
    setChallenge(null);
    forward({ name: "details" });
  }

  function failToIc(err: unknown) {
    setIcError(err instanceof ApiError ? err.message : "Ralat tidak dijangka. Sila cuba lagi.");
    setChallenge(null);
    setPhase({ name: "ic" });
  }

  // SPR mode: open the portal for this IC, then show the voter the portal's CAPTCHA.
  // `refresh`: the voter asked to re-check on the portal instead of using their stored record.
  async function sprStart(digits: string, refresh = false) {
    setIc(digits);
    setIcError(null);
    setCaptchaError(null);
    setPhase({ name: "loading" });
    try {
      const res = await api.sprStart(digits, refresh);
      if ("voter" in res) {
        showRecord(res); // confirmed on an earlier visit: no CAPTCHA needed
        return;
      }
      setChallenge(res);
      forward({ name: "captcha" });
    } catch (err) {
      failToIc(err);
    }
  }

  async function sprAnswer(answer: string) {
    if (!challenge || captchaBusy) return;
    setCaptchaBusy(true);
    setCaptchaError(null);
    try {
      const res = await api.sprAnswer(challenge.job_id, answer);
      if ("voter" in res) showRecord(res);
      else setChallenge(res);
    } catch (err) {
      // Terminal outcomes (not registered, expired, portal changed...) end this attempt.
      if (err instanceof ApiError && (err.code === "invalid_answer" || err.code === "in_progress")) {
        setCaptchaError(err.message);
      } else {
        failToIc(err);
      }
    } finally {
      setCaptchaBusy(false);
    }
  }

  async function sprRefresh() {
    if (!challenge || captchaBusy) return;
    setCaptchaBusy(true);
    setCaptchaError(null);
    try {
      setChallenge(await api.sprRefresh(challenge.job_id));
    } catch (err) {
      failToIc(err);
    } finally {
      setCaptchaBusy(false);
    }
  }

  async function lookup(digits: string) {
    const cfg = config ?? (await api.config().catch(() => null));
    if (cfg?.voter_source === "spr") return sprStart(digits);
    setIc(digits);
    setIcError(null);
    setPhase({ name: "loading" });
    try {
      const [res] = await Promise.all([api.lookup(digits), sleep(reduceMotion ? 600 : LOADING_MIN_MS)]);
      setData(res);
      setAnswers(res.previous_response?.answers ?? {});
      setResult(null);
      forward({ name: "details" });
    } catch (err) {
      setIcError(err instanceof ApiError ? err.message : "Ralat tidak dijangka. Sila cuba lagi.");
      setPhase({ name: "ic" });
    }
  }

  function startOver() {
    setData(null);
    setAnswers({});
    setResult(null);
    setIc("");
    setIcError(null);
    setChallenge(null);
    setPhase({ name: "ic" });
  }

  let screen: React.ReactNode;
  switch (phase.name) {
    case "ic":
      screen = <IcStep initialIc={ic} error={icError} onSubmit={lookup} demo={config?.demo ?? false} />;
      break;
    case "captcha":
      screen = (
        <CaptchaStep
          ic={ic}
          challenge={challenge!}
          busy={captchaBusy}
          error={captchaError}
          onSubmit={sprAnswer}
          onRefresh={sprRefresh}
          onBack={back}
        />
      );
      break;
    case "loading":
      screen = <LoadingStep />;
      break;
    case "details":
      screen = (
        <DetailsStep
          voter={data!.voter}
          reused={!!data!.reused}
          onRecheck={() => sprStart(ic, true)}
          onNext={() => forward({ name: "candidates" })}
          onBack={back}
        />
      );
      break;
    case "candidates":
      screen = (
        <CandidatesStep
          voter={data!.voter}
          contests={data!.contests}
          contestsError={data!.contests_error}
          questionCount={data!.questions.length}
          onContests={(contests) => setData((d) => (d ? { ...d, contests, contests_error: "" } : d))}
          onNext={() => forward({ name: "question", index: 0 })}
          onBack={back}
        />
      );
      break;
    case "question": {
      const qs = data!.questions;
      const isLast = phase.index === qs.length - 1;
      screen = (
        <QuestionStep
          key={qs[phase.index].id}
          question={qs[phase.index]}
          index={phase.index}
          total={qs.length}
          value={answers[qs[phase.index].id]}
          hadPrevious={!!data!.previous_response}
          isLast={isLast}
          onChange={(v) => setAnswers((a) => ({ ...a, [qs[phase.index].id]: v }))}
          onBack={back}
          onNext={async () => {
            if (!isLast) return forward({ name: "question", index: phase.index + 1 });
            const res = await api.submit(ic, answers, data!.voter_token);
            setResult(res);
            forward({ name: "done" });
          }}
        />
      );
      break;
    }
    case "done":
      screen = <DoneStep voter={data!.voter} questions={data!.questions} answers={answers} result={result!} onFinish={startOver} />;
      break;
  }

  const key = phase.name === "question" ? `q${phase.index}` : phase.name;
  const stage = STAGE_OF[phase.name];

  return (
    <AppShell>
      <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
        <aside className="hidden lg:block">
          <div className="sticky top-28">
            <StepRail current={stage} />
          </div>
        </aside>

        <div className="min-w-0 lg:max-w-3xl">
          <div className="lg:hidden">
            <MobileProgress current={stage} />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={key}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduceMotion ? 0.1 : 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              {screen}
            </m.div>
          </AnimatePresence>
        </div>
      </div>
    </AppShell>
  );
}
