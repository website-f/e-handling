import * as React from "react";
import {
  ArrowClockwise, ArrowRight, CaretDown, ClockCounterClockwise, Database, Trophy, WarningCircle,
} from "@phosphor-icons/react";
import { m, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type BallotEntry, type Contest, type Voter } from "@/lib/api";
import { electionLabel, fmtInt, fmtPct, isWin, RESULT_LABEL, splitSeat } from "@/lib/election";
import { cn } from "@/lib/utils";
import { BackLink, StepHeading, StickyActions } from "./shared";

const INITIAL_VISIBLE = 4;

// Loaded on first "Rekod penuh" tap so the dialog code stays out of the first page load.
const CandidateSheet = React.lazy(() => import("./candidate-sheet").then((m) => ({ default: m.CandidateSheet })));

export function CandidatesStep({
  voter,
  contests,
  contestsError,
  questionCount,
  onContests,
  onNext,
  onBack,
}: {
  voter: Voter;
  contests: Contest[] | null;
  contestsError: string;
  questionCount: number;
  onContests: (c: Contest[]) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [active, setActive] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const [error, setError] = React.useState(contestsError);

  async function retry() {
    setRetrying(true);
    setError("");
    try {
      onContests(await api.contests(voter));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Senarai calon tidak dapat dimuatkan. Sila cuba lagi.");
    } finally {
      setRetrying(false);
    }
  }

  const list = contests ?? [];
  const contest = list[Math.min(active, list.length - 1)];

  return (
    <>
      <BackLink onClick={onBack} />
      <StepHeading
        title="Calon di Kawasan Anda"
        lead="Calon yang bertanding pada pilihan raya terkini bagi kerusi Parlimen dan DUN anda."
      />

      {retrying ? (
        <ContestSkeleton />
      ) : list.length === 0 ? (
        <div role="alert" className="rounded-2xl border bg-card p-6 text-center shadow-soft sm:p-8">
          <WarningCircle size={40} weight="duotone" className="mx-auto text-destructive" />
          <p className="mt-3 text-xl font-bold">Senarai calon belum dapat dipaparkan</p>
          <p className="mx-auto mt-2 max-w-[42ch] text-lg text-muted-foreground">{error || "Sila cuba lagi sebentar."}</p>
          <Button variant="outline" onClick={retry} className="mt-5">
            <ArrowClockwise size={22} weight="bold" />
            Cuba lagi
          </Button>
        </div>
      ) : (
        <>
          {list.length > 1 && (
            <div role="tablist" aria-label="Jenis kerusi" className="mb-5 grid grid-cols-2 gap-1.5 rounded-2xl border bg-card p-1.5 shadow-soft">
              {list.map((c, i) => {
                const seat = splitSeat(c.seat);
                const selected = i === active;
                return (
                  <button
                    key={c.level}
                    type="button"
                    role="tab"
                    id={`tab-${c.level}`}
                    aria-selected={selected}
                    aria-controls="contest-panel"
                    onClick={() => setActive(i)}
                    className={cn(
                      "flex min-h-[4.25rem] flex-col items-start justify-center rounded-xl px-3 py-2 text-left transition-colors sm:px-4",
                      selected ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
                    )}
                  >
                    <span className={cn("text-sm font-bold", selected ? "opacity-85" : "text-muted-foreground")}>
                      {c.level === "parlimen" ? "Parlimen" : "DUN"} {seat.code}
                    </span>
                    <span className="text-lg leading-tight font-bold break-words">{seat.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div id="contest-panel" role="tabpanel" aria-labelledby={list.length > 1 ? `tab-${contest.level}` : undefined}>
            <ContestView key={contest.level} contest={contest} />
          </div>

          <p className="mt-5 flex items-start gap-2 text-sm text-muted-foreground">
            <Database size={18} className="mt-0.5 shrink-0" />
            Sumber: ElectionData.MY (data awam, CC0). Calon bagi pilihan raya akan datang hanya diketahui selepas hari penamaan calon.
          </p>
        </>
      )}

      <StickyActions hint={`Seterusnya: ${questionCount} soalan ringkas, kurang 1 minit.`}>
        <Button size="lg" onClick={onNext} className="w-full sm:w-auto">
          Jawab Soalan Tinjauan
          <ArrowRight size={22} weight="bold" />
        </Button>
      </StickyActions>
    </>
  );
}

function ContestView({ contest }: { contest: Contest }) {
  const reduce = useReducedMotion();
  const [showAll, setShowAll] = React.useState(false);
  const [selected, setSelected] = React.useState<BallotEntry | null>(null);

  const visible = showAll ? contest.ballot : contest.ballot.slice(0, INITIAL_VISIBLE);
  const hidden = contest.ballot.length - visible.length;
  const uncontested = contest.ballot.length === 1 && contest.ballot[0].result === "won_uncontested";

  const stats = [
    { label: "Pengundi berdaftar", value: fmtInt(contest.voters_total) },
    { label: "Keluar mengundi", value: fmtPct(contest.voter_turnout_perc) },
    { label: "Majoriti undi", value: uncontested ? "-" : fmtInt(contest.majority) },
  ];

  return (
    <>
      <section aria-label="Ringkasan keputusan" className="mb-4 overflow-hidden rounded-2xl border bg-card shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-inset px-4 py-3 sm:px-5">
          <p className="text-base font-bold">{electionLabel(contest.election, contest.state, contest.date)}</p>
          <p className="text-sm text-muted-foreground">
            {contest.ballot.length} orang calon
          </p>
        </div>
        <dl className="grid grid-cols-3 divide-x">
          {stats.map((s) => (
            <div key={s.label} className="px-3 py-3 sm:px-5">
              <dt className="text-sm leading-tight text-muted-foreground">{s.label}</dt>
              <dd className="mt-1 text-lg font-bold tabular-nums sm:text-xl">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <ol className="grid gap-3" aria-label={`Calon ${contest.seat}`}>
        {visible.map((b, i) => (
          <m.li
            key={`${b.name}-${b.party}`}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 6) * 0.04, duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <CandidateCard entry={b} onOpen={() => setSelected(b)} />
          </m.li>
        ))}
      </ol>

      {hidden > 0 && (
        <Button variant="outline" onClick={() => setShowAll(true)} className="mt-3 w-full">
          <CaretDown size={20} weight="bold" />
          Tunjuk {hidden} calon lagi
        </Button>
      )}

      {selected && (
        <React.Suspense fallback={null}>
          <CandidateSheet entry={selected} onClose={() => setSelected(null)} />
        </React.Suspense>
      )}
    </>
  );
}

/** Party acronyms run from "PH" to "ANAK-NEGERI"; size the tile text so each fits without mid-word breaks. */
function partyTileSize(acronym: string) {
  const longest = Math.max(...acronym.split("-").map((p) => p.length));
  if (longest <= 4) return "text-sm sm:text-base";
  if (longest <= 6) return "text-[0.7rem] sm:text-xs";
  return "text-[0.6rem] sm:text-[0.68rem]";
}

function CandidateCard({ entry, onOpen }: { entry: BallotEntry; onOpen: () => void }) {
  const won = isWin(entry.result);
  const pct = entry.votes_perc ?? (won ? 100 : 0);
  return (
    <article
      className={cn(
        "rounded-2xl border bg-card p-4 shadow-soft sm:p-5",
        won && "border-primary/60 ring-1 ring-primary/30",
      )}
    >
      <div className="flex items-start gap-3.5 sm:gap-4">
        {entry.photo_url ? (
          <img
            src={entry.photo_url}
            alt={`Foto ${entry.name}`}
            width={72}
            height={72}
            loading="lazy"
            decoding="async"
            className={cn(
              "size-16 shrink-0 rounded-xl bg-inset object-cover sm:size-[4.5rem]",
              won ? "ring-2 ring-primary" : "ring-1 ring-border",
            )}
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-16 shrink-0 items-center justify-center rounded-xl px-1 text-center leading-[1.05] font-bold tracking-tight break-normal sm:size-[4.5rem]",
              partyTileSize(entry.party),
              won ? "bg-primary text-primary-foreground" : "bg-inset text-foreground ring-1 ring-border",
            )}
          >
            {/* allow a line break only after a hyphen: "ANAK-" / "NEGERI" */}
            {entry.party.replace(/-/g, "-​")}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-bold",
                won ? "bg-primary-soft text-primary" : entry.result === "lost_deposit" ? "border text-muted-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {won && <Trophy size={15} weight="fill" />}
              {RESULT_LABEL[entry.result]}
            </span>
            {/* With a photo in the tile, the party acronym moves up here. */}
            {entry.photo_url && (
              <span className="rounded-full border px-2.5 py-0.5 text-sm font-bold">{entry.party}</span>
            )}
          </div>
          <h3 className="mt-1.5 text-lg leading-snug font-bold break-words sm:text-xl">{entry.name}</h3>
          <p className="mt-0.5 text-base text-muted-foreground">
            {entry.party_name || entry.party}
            {entry.coalition && (
              <>
                {" "}
                <span className="whitespace-nowrap">({entry.coalition_name || entry.coalition})</span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Vote share: one bar per candidate on a 0-100% scale, no track; winner in the accent. */}
      {entry.result !== "won_uncontested" && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-base">
              <strong className="text-lg tabular-nums">{fmtInt(entry.votes)}</strong> undi
            </span>
            <span className="text-lg font-bold tabular-nums">{fmtPct(entry.votes_perc)}</span>
          </div>
          <div className="mt-1.5 h-2.5">
            <div
              className={cn("h-full rounded-r-[4px]", won ? "bg-primary" : "bg-input/45")}
              style={{ width: `${Math.max(pct, 1)}%` }}
            />
          </div>
        </div>
      )}

      {entry.record && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-base text-muted-foreground">
            Bertanding <strong className="text-foreground">{entry.record.contests}</strong> kali, menang{" "}
            <strong className="text-foreground">{entry.record.won}</strong>
          </p>
          <Button variant="soft" size="sm" onClick={onOpen}>
            <ClockCounterClockwise size={20} weight="bold" />
            Rekod penuh
          </Button>
        </div>
      )}
    </article>
  );
}

function ContestSkeleton() {
  return (
    <div aria-busy="true" aria-label="Memuatkan senarai calon" className="grid gap-3">
      <Skeleton className="h-[4.75rem] rounded-2xl" />
      <Skeleton className="h-28 rounded-2xl" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-44 rounded-2xl" />
      ))}
    </div>
  );
}

