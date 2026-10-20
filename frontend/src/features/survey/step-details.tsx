import type { ReactNode } from "react";
import { ArrowRight, IdentificationCard, MapPinArea, SealCheck } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { Area, Voter } from "@/lib/api";
import { formatDateMs, formatIC } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackLink, StepHeading, StickyActions } from "./shared";

function Field({ label, value, mono, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div className={cn("rounded-xl bg-inset px-4 py-3", className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-lg leading-snug font-bold break-words", mono && "font-mono tracking-wide")}>{value}</dd>
    </div>
  );
}

/** "173 / 23 / 01 / 001 - KG PETAGAS": code quieter, place name strong. Missing parts are left out, never filled in. */
function AreaValue({ area }: { area: Area }) {
  if (!area.code && !area.name) return <span className="text-muted-foreground">Tiada</span>;
  return (
    <>
      {area.code && <span className="text-muted-foreground tabular-nums">{area.code.split("/").join(" / ")}</span>}
      {area.code && area.name && <span className="text-muted-foreground"> - </span>}
      <span className="font-bold">{area.name}</span>
    </>
  );
}

export function DetailsStep({ voter, onNext, onBack }: { voter: Voter; onNext: () => void; onBack: () => void }) {
  const levels: { label: string; value: ReactNode }[] = [
    ...(voter.polling_centre
      ? [{
          label: "Pusat Mengundi",
          value: (
            <>
              <span className="font-bold">{voter.polling_centre}</span>
              {voter.stream && <span className="text-muted-foreground"> (Saluran {voter.stream})</span>}
              {voter.voting_time && <span className="block text-base text-muted-foreground">{voter.voting_time}</span>}
            </>
          ),
        }]
      : []),
    { label: "Lokaliti", value: <AreaValue area={voter.lokaliti} /> },
    { label: "Daerah Mengundi", value: <AreaValue area={voter.daerah_mengundi} /> },
    { label: "DUN", value: <AreaValue area={voter.dun} /> },
    { label: "Parlimen", value: <AreaValue area={voter.parlimen} /> },
    { label: "Negeri", value: <span className="font-bold">{voter.state}</span> },
  ];

  return (
    <>
      <BackLink onClick={onBack} label="Bukan saya, semak semula" />
      <StepHeading title="Maklumat Pemilih" lead="Sila pastikan maklumat di bawah adalah maklumat anda." />

      <div className="grid gap-5">
        {/* Personal details, shaped like an ID card */}
        <section aria-labelledby="sec-personal" className="overflow-hidden rounded-2xl border bg-card shadow-lift">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-primary-soft px-5 py-3.5 sm:px-6">
            <h2 id="sec-personal" className="flex items-center gap-2.5 text-sm font-bold tracking-wide">
              <IdentificationCard size={22} weight="duotone" className="text-primary" />
              MAKLUMAT PERIBADI PEMILIH
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-sm font-bold text-primary">
              <SealCheck size={18} weight="fill" />
              {voter.source === "spr" ? "Disahkan SPR" : "Berdaftar"}
            </span>
          </div>
          <dl className="grid gap-2.5 p-4 sm:grid-cols-3 sm:p-5">
            <Field label="Nama Penuh" value={voter.full_name} className="sm:col-span-3" />
            <Field label="No. Kad Pengenalan" value={formatIC(voter.ic)} mono />
            <Field label="Tarikh Lahir" value={formatDateMs(voter.dob)} />
            <Field label="Jantina" value={voter.gender} />
          </dl>
        </section>

        {/* Voting place: most specific first, joined by a rail so the hierarchy reads at a glance */}
        <section aria-labelledby="sec-register" className="rounded-2xl border bg-card shadow-soft">
          <div className="flex items-center gap-2.5 border-b px-5 py-3.5 sm:px-6">
            <MapPinArea size={22} weight="duotone" className="text-primary" />
            <h2 id="sec-register" className="text-sm font-bold tracking-wide">DAFTAR PEMILIH YANG TELAH DISAHKAN</h2>
          </div>
          <dl className="p-4 sm:p-5">
            {levels.map((lvl, i) => {
              const first = i === 0;
              const last = i === levels.length - 1;
              return (
                <div key={lvl.label} className="relative flex gap-4">
                  <div aria-hidden className="relative flex w-5 shrink-0 justify-center">
                    {!last && <span className="absolute top-6 -bottom-0 w-0.5 bg-primary-line" />}
                    <span
                      className={cn(
                        "relative mt-[1.15rem] rounded-full",
                        first ? "size-4 bg-primary ring-4 ring-primary-soft" : "size-2.5 bg-primary-line",
                      )}
                    />
                  </div>
                  <div className={cn("min-w-0 flex-1 rounded-xl px-4 py-2.5", first ? "mb-1.5 bg-primary-soft" : "pb-3")}>
                    <dt className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                      {lvl.label}
                      {first && <span className="font-bold text-primary">Tempat anda mengundi</span>}
                    </dt>
                    <dd className="mt-0.5 text-lg leading-snug break-words">{lvl.value}</dd>
                  </div>
                </div>
              );
            })}
          </dl>
        </section>
      </div>

      <StickyActions>
        <Button size="lg" onClick={onNext} className="w-full sm:w-auto">
          Lihat Senarai Calon
          <ArrowRight size={22} weight="bold" />
        </Button>
      </StickyActions>
    </>
  );
}
