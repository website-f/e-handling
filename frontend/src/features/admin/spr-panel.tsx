import * as React from "react";
import { CheckCircle, HourglassMedium, LockSimple, WarningCircle } from "@phosphor-icons/react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type adminApi, type CandidatePhase, type SprAdmin } from "@/lib/api";
import { formatDateTimeMs } from "@/lib/format";
import { cn } from "@/lib/utils";

type Client = ReturnType<typeof adminApi>;

const LOOKUP_LABEL: Record<string, string> = {
  processing: "Dibuka",
  awaiting_captcha: "Menunggu captcha",
  completed: "Berjaya",
  not_registered: "Tiada dalam daftar",
  blocked: "Disekat portal",
  unavailable: "Portal tiada respons",
  busy: "Sibuk",
  unexpected_layout: "Paparan portal berubah",
  too_many_attempts: "Captcha gagal 3 kali",
  expired: "Tamat masa",
  cancelled: "Dibatalkan pemilih",
  reused: "Rekod tersimpan (tanpa portal)",
  failed: "Gagal",
};

const PHASE_LABEL: Record<CandidatePhase["status"], string> = {
  pending: "Belum bermula",
  processing: "Sedang diproses",
  completed: "Selesai",
  completed_with_warnings: "Selesai (dengan amaran)",
  failed: "Gagal",
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-inset px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-bold tabular-nums">{value}</dd>
    </div>
  );
}

/** MySPR lookups: whether the candidate gate is open, worker counters and a masked audit trail. */
export function SprPanel({ client }: { client: Client }) {
  const [data, setData] = React.useState<SprAdmin | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setData(await client.spr());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuatkan status semakan SPR.");
    }
  }, [client]);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return (
      <Alert variant="destructive">
        <WarningCircle size={22} weight="fill" />
        <span>{error}</span>
      </Alert>
    );
  }
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;

  const phase = data.phase;
  const open = !data.require_candidates || !!phase?.ready;

  return (
    <section className="grid gap-5 [&>*]:min-w-0">
      <div className="rounded-2xl border bg-card p-4 shadow-soft sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Semakan MySPR</h2>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold",
              data.voter_source !== "spr"
                ? "bg-muted text-muted-foreground"
                : open
                  ? "bg-primary-soft text-primary"
                  : "bg-destructive/10 text-destructive",
            )}
          >
            {data.voter_source !== "spr" ? (
              "Mod demo (VOTER_SOURCE=demo)"
            ) : open ? (
              <>
                <CheckCircle size={18} weight="fill" /> Dibuka kepada pemilih
              </>
            ) : (
              <>
                <LockSimple size={18} weight="fill" /> Ditutup: menunggu fasa calon
              </>
            )}
          </span>
        </div>
        <p className="mt-1 max-w-[70ch] text-base text-muted-foreground">
          Semakan SPR hanya dibuka selepas fasa calon terkini selesai: setiap calon yang diimbas (Foto Calon &gt; "Cari foto
          semua calon") telah sampai ke status akhir. Pemilih sendiri menaip captcha portal; sistem tidak membaca atau
          menyelesaikannya.
        </p>

        <h3 className="mt-5 flex items-center gap-2 text-base font-bold">
          <HourglassMedium size={20} weight="duotone" className="text-primary" />
          Fasa calon {phase ? `#${phase.id}: ${PHASE_LABEL[phase.status]}` : ": belum pernah diimbas"}
        </h3>
        {phase && (
          <dl className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Jumlah calon" value={phase.total} />
            <Stat label="Belum selesai" value={phase.remaining} />
            <Stat label="Foto diluluskan" value={phase.approved} />
            <Stat label="Menunggu semakan" value={phase.review} />
            <Stat label="Tiada foto" value={phase.not_found} />
            <Stat label="Ralat" value={phase.failed} />
          </dl>
        )}

        {data.worker && (
          <>
            <h3 className="mt-5 text-base font-bold">Pekerja pelayar (Camoufox)</h3>
            <dl className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label="Sesi terbuka" value={data.worker.open_sessions} />
              <Stat label="Portal dibuka" value={data.worker.requests.open ?? 0} />
              <Stat label="Hantar (Semak)" value={data.worker.requests.submit ?? 0} />
              <Stat label="Cubaan semula" value={Object.values(data.worker.retries).reduce((a, b) => a + b, 0)} />
            </dl>
          </>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-soft">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3 sm:px-5">
          <h3 className="text-base font-bold">Log audit (50 terkini)</h3>
          <p className="text-sm text-muted-foreground">
            24 jam:{" "}
            {Object.entries(data.counts_24h)
              .map(([k, v]) => `${LOOKUP_LABEL[k] ?? k} ${v}`)
              .join(", ") || "tiada"}
          </p>
        </div>
        {data.lookups.length === 0 ? (
          <p className="p-5 text-base text-muted-foreground">Belum ada semakan.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-base">
              <thead className="bg-inset text-sm text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-bold">Masa</th>
                  <th className="px-4 py-2 font-bold">IC (bertopeng)</th>
                  <th className="px-4 py-2 font-bold">Status</th>
                  <th className="px-4 py-2 font-bold">Captcha</th>
                  <th className="px-4 py-2 font-bold">Sebab</th>
                </tr>
              </thead>
              <tbody>
                {data.lookups.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="px-4 py-2 whitespace-nowrap">{formatDateTimeMs(l.created_at)}</td>
                    <td className="px-4 py-2 font-mono">{l.ic_masked}</td>
                    <td className="px-4 py-2 font-bold">{LOOKUP_LABEL[l.status] ?? l.status}</td>
                    <td className="px-4 py-2 tabular-nums">{l.captcha_attempts}</td>
                    <td className="px-4 py-2 text-muted-foreground">{l.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
