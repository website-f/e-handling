import * as React from "react";
import { ArrowClockwise, Trophy } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type BallotEntry, type HistoryEntry } from "@/lib/api";
import { electionLabel, fmtPct, isWin, RESULT_LABEL } from "@/lib/election";
import { cn } from "@/lib/utils";

function hostOf(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.endsWith("wikipedia.org") ? "Wikipedia" : host;
  } catch {
    return url;
  }
}

/** Full electoral record for one candidate, loaded when the sheet opens. */
export function CandidateSheet({ entry, onClose }: { entry: BallotEntry | null; onClose: () => void }) {
  const uid = entry?.record?.uid;
  const [history, setHistory] = React.useState<HistoryEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    setHistory(null);
    setError(null);
    api
      .candidateHistory(uid)
      .then((h) => !cancelled && setHistory(h))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Rekod calon tidak dapat dimuatkan."));
    return () => {
      cancelled = true;
    };
  }, [uid, attempt]);

  const rec = entry?.record;

  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      {entry && (
        <SheetContent
          title={entry.name}
          description={rec ? `Bertanding ${rec.contests} kali: menang ${rec.won}, kalah ${rec.lost}` : undefined}
        >
          {entry.photo_url && (
            <figure className="mb-4 flex items-center gap-4">
              <img
                src={entry.photo_url}
                alt={`Foto ${entry.name}`}
                width={112}
                height={112}
                className="size-28 shrink-0 rounded-2xl bg-inset object-cover ring-1 ring-border"
              />
              <figcaption className="min-w-0 text-sm text-muted-foreground">
                <span className="block text-base font-bold text-foreground">
                  {entry.party_name || entry.party}
                </span>
                {entry.photo_page && (
                  <a href={entry.photo_page} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-primary underline underline-offset-2 [overflow-wrap:anywhere]">
                    Sumber foto: {hostOf(entry.photo_page)}
                  </a>
                )}
              </figcaption>
            </figure>
          )}
          {error ? (
            <div role="alert" className="py-6 text-center">
              <p className="text-lg font-bold">{error}</p>
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)} className="mt-4">
                <ArrowClockwise size={22} weight="bold" />
                Cuba lagi
              </Button>
            </div>
          ) : !history ? (
            <div className="grid gap-3" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : (
            <ol className="grid gap-2.5">
              {history.map((h) => {
                const won = isWin(h.result);
                return (
                  <li key={`${h.date}-${h.seat}`} className={cn("rounded-xl px-4 py-3.5", won ? "bg-primary-soft" : "bg-inset")}>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="text-sm font-bold text-muted-foreground">{electionLabel(h.election, h.state, h.date)}</p>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-bold",
                          won ? "bg-card text-primary" : "bg-card text-muted-foreground",
                        )}
                      >
                        {won && <Trophy size={14} weight="fill" />}
                        {RESULT_LABEL[h.result]}
                      </span>
                    </div>
                    <p className="mt-1 text-lg leading-snug font-bold">
                      {h.seat}, {h.state}
                    </p>
                    <p className="mt-0.5 text-base text-muted-foreground">
                      {h.party}
                      {h.coalition && ` (${h.coalition})`}
                      {h.result !== "won_uncontested" && (
                        <>
                          , {h.votes.toLocaleString("ms-MY")} undi ({fmtPct(h.votes_perc)})
                        </>
                      )}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}
