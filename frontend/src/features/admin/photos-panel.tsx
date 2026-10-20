import * as React from "react";
import { ArrowClockwise, Check, MagnifyingGlass, Prohibit, UserCircle, WarningCircle } from "@phosphor-icons/react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type adminApi, type PhotoPage, type PhotoRow, type PhotoStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

type Client = ReturnType<typeof adminApi>;

const FILTERS: { id: PhotoStatus | "all"; label: string }[] = [
  { id: "pending", label: "Menunggu semakan" },
  { id: "approved", label: "Diluluskan" },
  { id: "queued", label: "Dalam barisan" },
  { id: "not_found", label: "Tiada foto" },
  { id: "rejected", label: "Ditolak" },
  { id: "all", label: "Semua" },
];

const STATUS_LABEL: Record<PhotoStatus, string> = {
  queued: "Dalam barisan",
  searching: "Sedang dicari",
  pending: "Menunggu semakan",
  approved: "Diluluskan",
  rejected: "Ditolak",
  not_found: "Tiada foto",
  error: "Ralat",
};

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Review queue for candidate portraits. Nothing reaches voters until it is approved here. */
export function PhotosPanel({ client }: { client: Client }) {
  const [filter, setFilter] = React.useState<PhotoStatus | "all">("pending");
  const [data, setData] = React.useState<PhotoPage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setData(await client.photos(filter));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal memuatkan foto calon.");
    }
  }, [client, filter]);

  React.useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function scan() {
    setScanning(true);
    setNotice(null);
    try {
      const r = await client.photoScan();
      setNotice(
        `${r.candidates} calon dari ${r.seats} kawasan diperiksa, ${r.queued} baharu dimasukkan ke barisan carian.` +
          (r.phase_status === "processing" ? " Semakan SPR dibuka sebaik sahaja semua calon selesai diproses." : ""),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Imbasan gagal.");
    } finally {
      setScanning(false);
    }
  }

  const counts = data?.counts ?? {};
  const countFor = (id: PhotoStatus | "all") =>
    id === "all"
      ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
      : id === "queued"
        ? (counts.queued ?? 0) + (counts.searching ?? 0)
        : (counts[id] ?? 0);

  return (
    <section className="grid gap-5 [&>*]:min-w-0">
      <div className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-soft sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-[60ch]">
          <h2 className="text-lg font-bold">Foto Calon</h2>
          <p className="mt-1 text-base text-muted-foreground">
            Diluluskan secara automatik: foto Wikipedia, dan wajah yang sama dari sekurang-kurangnya dua laman web
            berbeza. Foto lain hanya dipaparkan kepada pemilih selepas anda meluluskannya.
          </p>
        </div>
        <Button onClick={scan} disabled={scanning} className="shrink-0">
          <MagnifyingGlass size={20} weight="bold" />
          {scanning ? "Mengimbas..." : "Cari foto semua calon"}
        </Button>
      </div>

      {notice && (
        <Alert variant="success">
          <Check size={22} weight="bold" />
          <span>{notice}</span>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <WarningCircle size={22} weight="fill" />
          <span>{error}</span>
        </Alert>
      )}

      <div role="tablist" aria-label="Status foto" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "inline-flex h-11 items-center gap-2 rounded-full border px-4 text-base font-bold transition-colors",
              filter === f.id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
            )}
          >
            {f.label}
            <span className={cn("rounded-full px-2 text-sm tabular-nums", filter === f.id ? "bg-background/25" : "bg-muted")}>
              {countFor(f.id)}
            </span>
          </button>
        ))}
      </div>

      {!data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-96 rounded-2xl" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card px-5 py-14 text-center">
          <p className="text-lg font-bold">Tiada calon dalam senarai ini</p>
          <p className="mt-1 text-base text-muted-foreground">
            {filter === "pending"
              ? "Semua foto telah disemak. Tekan \"Cari foto semua calon\" untuk mencari calon baharu."
              : "Calon akan muncul di sini apabila pemilih membuka senarai calon, atau selepas imbasan."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((row) => (
            <PhotoCard key={row.uid} row={row} client={client} onChanged={load} />
          ))}
        </div>
      )}
    </section>
  );
}

function PhotoCard({ row, client, onChanged }: { row: PhotoRow; client: Client; onChanged: () => void }) {
  const initial = row.options.findIndex((o) => o.path === row.image_path);
  const [sel, setSel] = React.useState(Math.max(initial, 0));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const option = row.options[sel];
  const working = row.status === "queued" || row.status === "searching";
  const isCurrent = row.status === "approved" && option?.path === row.image_path;

  async function act(action: "approve" | "reject" | "retry") {
    setBusy(action);
    setError(null);
    try {
      await client.photoAction(row.uid, action, action === "approve" ? option?.path : undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Tindakan gagal.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border bg-card shadow-soft">
      <div className="relative aspect-square bg-inset">
        {option ? (
          <img src={option.path} alt={`Pilihan foto untuk ${row.name}`} className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <UserCircle size={64} weight="thin" />
            <span className="text-base">{working ? "Sedang mencari foto..." : "Tiada foto sesuai dijumpai"}</span>
          </div>
        )}
      </div>

      {row.options.length > 1 && (
        <div className="flex gap-2 border-b p-3" role="radiogroup" aria-label="Pilihan foto">
          {row.options.map((o, i) => (
            <button
              key={o.path}
              type="button"
              role="radio"
              aria-checked={i === sel}
              aria-label={`Pilihan ${i + 1}`}
              onClick={() => setSel(i)}
              className={cn("size-14 overflow-hidden rounded-lg ring-offset-2 ring-offset-card", i === sel ? "ring-3 ring-primary" : "ring-1 ring-border")}
            >
              <img src={o.path} alt="" className="size-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-sm font-bold",
                row.status === "approved" ? "bg-primary-soft text-primary" : row.status === "pending" ? "bg-warning-soft text-warning-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {STATUS_LABEL[row.status]}
            </span>
            {option && <span className="text-sm text-muted-foreground">{option.source === "wikipedia" ? "Wikipedia" : "Carian web"}</span>}
          </div>
          <h3 className="mt-2 text-lg leading-snug font-bold break-words">{row.name}</h3>
          <p className="text-base text-muted-foreground">
            {row.party}, {row.seat}
          </p>
          {option && (
            <a href={option.page_url || option.source_url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 block truncate text-sm text-primary underline underline-offset-2" title={option.title}>
              {option.title || hostOf(option.page_url || option.source_url)}
            </a>
          )}
          {option && (option.agree ?? 0) > 0 && (
            <p className="mt-1 text-sm font-bold text-primary">Wajah sepadan dengan foto dari {option.agree} laman lain</p>
          )}
          {option && option.faces > 1 && (
            <p className="mt-1 text-sm text-warning-foreground">Dipotong daripada gambar berkumpulan. Pastikan orang yang betul.</p>
          )}
          {row.status === "error" && row.last_error && <p className="mt-1 text-sm text-destructive">{row.last_error}</p>}
        </div>

        {error && <p role="alert" className="text-sm font-bold text-destructive">{error}</p>}

        <div className="mt-auto flex flex-wrap gap-2">
          {option && !isCurrent && !working && (
            <Button size="sm" onClick={() => act("approve")} disabled={!!busy}>
              <Check size={18} weight="bold" />
              {busy === "approve" ? "..." : "Lulus foto ini"}
            </Button>
          )}
          {(row.status === "approved" || row.status === "pending") && (
            <Button size="sm" variant="outline" onClick={() => act("reject")} disabled={!!busy}>
              <Prohibit size={18} weight="bold" />
              Tolak
            </Button>
          )}
          {!working && (
            <Button size="sm" variant="ghost" onClick={() => act("retry")} disabled={!!busy}>
              <ArrowClockwise size={18} weight="bold" />
              Cari semula
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
