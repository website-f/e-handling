import * as React from "react";
import {
  ArrowClockwise, ArrowsClockwise, CalendarCheck, CaretDown, CaretLeft, CaretRight, ChartBar, Code, DownloadSimple,
  Image as ImageIcon, Key, ListBullets, MagnifyingGlass, SignOut, UserPlus, Users, WarningCircle,
} from "@phosphor-icons/react";
import { AppShell } from "@/components/app-shell";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminApi, ApiError, type CountRow, type ResponsePage, type ResponseRow, type Stats } from "@/lib/api";
import { formatArea, formatDateMs, formatDateTimeMs, formatIC } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PhotosPanel } from "./photos-panel";

const KEY_STORAGE = "eh-admin-key";
type Prompts = Record<string, Stats["questions"][number]>;

function readKey() {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export default function AdminPage() {
  const [key, setKey] = React.useState(readKey);
  const signOut = React.useCallback(() => {
    try {
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore */
    }
    setKey("");
  }, []);
  return (
    <AppShell width="wide" subtitle="Konsol Pentadbir">
      {key ? (
        <Dashboard apiKey={key} onSignOut={signOut} />
      ) : (
        <SignIn
          onSignedIn={(k) => {
            try {
              sessionStorage.setItem(KEY_STORAGE, k);
            } catch {
              /* ignore */
            }
            setKey(k);
          }}
        />
      )}
    </AppShell>
  );
}

/* ---------- sign in ---------- */

function SignIn({ onSignedIn }: { onSignedIn: (key: string) => void }) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi(value.trim()).stats();
      onSignedIn(value.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Tidak dapat menyambung.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-4 max-w-md overflow-hidden rounded-2xl border bg-card shadow-lift sm:mt-10">
      <div className="border-b bg-primary-soft px-6 py-5">
        <span className="flex size-12 items-center justify-center rounded-xl bg-card text-primary shadow-soft">
          <Key size={26} weight="duotone" />
        </span>
        <h1 className="mt-4 text-2xl font-bold">Konsol Pentadbir</h1>
        <p className="mt-1 text-base text-muted-foreground">Masukkan kunci API untuk melihat data tinjauan.</p>
      </div>
      <div className="grid gap-2 p-6">
        <Label htmlFor="key">Kunci API (ADMIN_API_KEY)</Label>
        <Input id="key" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} />
        {error && <p role="alert" className="text-base font-bold text-destructive">{error}</p>}
        <Button type="submit" className="mt-3 w-full" disabled={!value.trim() || busy}>
          {busy ? "Menyemak..." : "Masuk"}
        </Button>
      </div>
    </form>
  );
}

/* ---------- dashboard ---------- */

function Dashboard({ apiKey, onSignOut }: { apiKey: string; onSignOut: () => void }) {
  const client = React.useMemo(() => adminApi(apiKey), [apiKey]);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [page, setPage] = React.useState<ResponsePage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [appliedQuery, setAppliedQuery] = React.useState("");
  const [parlimen, setParlimen] = React.useState("");
  const [pageNo, setPageNo] = React.useState(1);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, p] = await Promise.all([client.stats(), client.responses({ page: pageNo, q: appliedQuery, parlimen })]);
      setStats(s);
      setPage(p);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignOut();
      setError(err instanceof ApiError ? err.message : "Gagal memuatkan data.");
    } finally {
      setRefreshing(false);
    }
  }, [client, pageNo, appliedQuery, parlimen, onSignOut]);

  React.useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const prompts: Prompts = React.useMemo(() => Object.fromEntries((stats?.questions ?? []).map((q) => [q.id, q])), [stats]);

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-bold tracking-[-0.015em] sm:text-4xl">Papan Pemuka Tinjauan</h1>
          <p className="mt-2 text-base text-muted-foreground">
            {stats ? `Dikemas kini ${formatDateTimeMs(stats.generated_at)}, muat semula automatik setiap 15 saat` : "Memuatkan data..."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
            <ArrowClockwise size={20} weight="bold" className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            Muat semula
          </Button>
          <Button variant="outline" size="sm" onClick={() => client.exportCsv({ q: appliedQuery, parlimen }).catch((e) => setError(e.message))}>
            <DownloadSimple size={20} weight="bold" />
            Eksport CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut} aria-label="Keluar">
            <SignOut size={20} weight="bold" />
            <span className="hidden sm:inline">Keluar</span>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <WarningCircle size={22} weight="fill" />
          <span>{error}</span>
        </Alert>
      )}

      <Tabs defaultValue="summary">
        <TabsList aria-label="Bahagian papan pemuka">
          <TabsTrigger value="summary">
            <ChartBar size={20} weight="bold" />
            Ringkasan
          </TabsTrigger>
          <TabsTrigger value="responses">
            <ListBullets size={20} weight="bold" />
            Respons
            {page && <span className="rounded-full bg-background/25 px-2 text-sm tabular-nums">{page.total}</span>}
          </TabsTrigger>
          <TabsTrigger value="photos">
            <ImageIcon size={20} weight="bold" />
            Foto Calon
          </TabsTrigger>
          <TabsTrigger value="api">
            <Code size={20} weight="bold" />
            API
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <Summary stats={stats} />
        </TabsContent>

        <TabsContent value="responses">
          <section className="overflow-hidden rounded-2xl border bg-card shadow-soft">
            <form
              className="grid gap-2 border-b p-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:p-5"
              onSubmit={(e) => {
                e.preventDefault();
                setPageNo(1);
                setAppliedQuery(query);
              }}
            >
              <label className="sr-only" htmlFor="q">Cari nama atau IC</label>
              <div className="relative">
                <MagnifyingGlass size={20} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari nama atau nombor IC" className="h-12 pl-11 text-base" />
              </div>
              <label className="sr-only" htmlFor="par">Parlimen</label>
              <select
                id="par"
                value={parlimen}
                onChange={(e) => {
                  setPageNo(1);
                  setParlimen(e.target.value);
                }}
                className="h-12 rounded-xl border-2 border-input bg-card px-3 text-base"
              >
                <option value="">Semua parlimen</option>
                {stats?.by_parlimen.map((p) => (
                  <option key={p.key} value={p.key}>P.{p.key} {p.label}</option>
                ))}
              </select>
              <Button type="submit" className="h-12">Cari</Button>
            </form>

            <ResponsesView page={page} prompts={prompts} filtered={!!(appliedQuery || parlimen)} />

            {page && page.total > page.limit && (
              <Pagination page={page} pageNo={pageNo} onChange={setPageNo} />
            )}
          </section>
        </TabsContent>

        <TabsContent value="photos">
          <PhotosPanel client={client} />
        </TabsContent>

        <TabsContent value="api">
          <ApiReference />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------- summary tab ---------- */

function Summary({ stats }: { stats: Stats | null }) {
  const kpis = [
    { label: "Jumlah respons", value: stats?.total, Icon: Users },
    { label: "Hari ini", value: stats?.today, Icon: CalendarCheck },
    { label: "Dijawab semula", value: stats?.resubmissions, Icon: ArrowsClockwise },
    { label: "Pemilih demo dijana", value: stats?.demo_voters, Icon: UserPlus },
  ];
  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(({ label, value, Icon }) => (
          <div key={label} className="rounded-2xl border bg-card p-4 shadow-soft sm:p-5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-base text-muted-foreground">{label}</p>
              <span className="hidden size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary sm:flex">
                <Icon size={20} weight="bold" />
              </span>
            </div>
            {value === undefined ? (
              <Skeleton className="mt-2 h-10 w-20" />
            ) : (
              <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">{value.toLocaleString("ms-MY")}</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        {(stats?.questions ?? [null, null]).map((q, i) =>
          q ? (
            <Panel key={q.id} title={`SOALAN ${i + 1}`} subtitle={q.prompt}>
              <BarList rows={q.options.map((o) => ({ ...o, label: `${o.key}. ${o.label}` }))} />
            </Panel>
          ) : (
            <Skeleton key={i} className="h-80 rounded-2xl" />
          ),
        )}
      </div>

      {stats && (
        <div className="grid gap-5 md:grid-cols-3 [&>*]:min-w-0">
          <Panel title="MENGIKUT PARLIMEN">
            <BarList rows={stats.by_parlimen.map((r) => ({ ...r, label: `P.${r.key} ${r.label}` }))} />
          </Panel>
          <Panel title="MENGIKUT JANTINA">
            <BarList rows={stats.by_gender} />
          </Panel>
          <Panel title="MENGIKUT UMUR">
            <BarList rows={stats.by_age_band.map((r) => ({ ...r, label: `${r.label} tahun` }))} />
          </Panel>
        </div>
      )}
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card shadow-soft">
      <div className="border-b px-5 py-4">
        <h2 className="text-sm font-bold tracking-wide text-muted-foreground">{title}</h2>
        {subtitle && <p className="mt-1 text-lg leading-snug font-bold">{subtitle}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Single-series horizontal bars: one accent hue, direct value labels, no track, hover highlight. */
function BarList({ rows }: { rows: CountRow[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0 || total === 0) {
    return <p className="py-6 text-base text-muted-foreground">Belum ada data.</p>;
  }
  return (
    <ul className="grid gap-4">
      {rows.map((r) => {
        const pct = (r.count / total) * 100;
        return (
          <li key={r.key} className="group min-w-0" title={`${r.label}: ${r.count} respons (${pct.toFixed(1)}%)`}>
            <div className="flex items-start justify-between gap-3 text-base leading-snug">
              <span className="min-w-0 break-words">{r.label}</span>
              <span className="shrink-0 tabular-nums">
                <strong>{r.count.toLocaleString("ms-MY")}</strong>
                <span className="ml-1.5 inline-block min-w-[3.5ch] text-right text-muted-foreground">{Math.round(pct)}%</span>
              </span>
            </div>
            <div className="mt-1.5 h-3">
              <div
                className="h-full rounded-r-[4px] bg-primary transition-[width,opacity] duration-500 group-hover:opacity-80"
                style={{ width: `${Math.max((r.count / max) * 100, r.count ? 1.5 : 0)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- responses tab ---------- */

function AnswerChips({ row, prompts }: { row: ResponseRow; prompts: Prompts }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {Object.keys(prompts).map((qid) => (
        <span key={qid} className="rounded-full bg-primary-soft px-2.5 py-0.5 text-sm font-bold whitespace-nowrap tabular-nums">
          {qid.toUpperCase()}: {row.answers[qid] ?? "-"}
        </span>
      ))}
    </span>
  );
}

function ResponsesView({ page, prompts, filtered }: { page: ResponsePage | null; prompts: Prompts; filtered: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);

  if (!page) {
    return (
      <div className="grid gap-3 p-5">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }
  if (page.items.length === 0) {
    return (
      <div className="px-5 py-14 text-center">
        <p className="text-lg font-bold">{filtered ? "Tiada padanan" : "Tiada respons lagi"}</p>
        <p className="mt-1 text-base text-muted-foreground">
          {filtered ? "Cuba nama, nombor IC atau parlimen lain." : "Respons akan muncul di sini sebaik sahaja pemilih menghantar tinjauan."}
        </p>
      </div>
    );
  }

  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  return (
    <>
      {/* Desktop table */}
      <table className="hidden w-full text-left text-base md:table">
        <thead className="bg-inset text-sm text-muted-foreground">
          <tr>
            <th scope="col" className="px-5 py-3 font-bold">Pemilih</th>
            <th scope="col" className="px-3 py-3 font-bold">Kawasan</th>
            <th scope="col" className="px-3 py-3 font-bold">Jawapan</th>
            <th scope="col" className="px-3 py-3 font-bold">Dikemas kini</th>
            <th scope="col" className="w-14 px-3 py-3"><span className="sr-only">Butiran</span></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {page.items.map((r) => (
            <React.Fragment key={r.id}>
              <tr className="cursor-pointer transition-colors hover:bg-inset" onClick={() => toggle(r.id)}>
                <td className="px-5 py-3.5">
                  <span className="block font-bold">{r.voter.full_name}</span>
                  <span className="block font-mono text-sm text-muted-foreground">{formatIC(r.voter.ic)}</span>
                </td>
                <td className="px-3 py-3.5">
                  <span className="block">P.{r.voter.parlimen.code} {r.voter.parlimen.name}</span>
                  <span className="block text-sm text-muted-foreground">DUN {r.voter.dun.name}</span>
                </td>
                <td className="px-3 py-3.5"><AnswerChips row={r} prompts={prompts} /></td>
                <td className="px-3 py-3.5 text-sm whitespace-nowrap text-muted-foreground">{formatDateTimeMs(r.updated_at)}</td>
                <td className="px-3 py-3.5">
                  <button
                    type="button"
                    aria-expanded={open === r.id}
                    aria-label={`Butiran ${r.voter.full_name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.id);
                    }}
                    className="flex size-10 items-center justify-center rounded-lg hover:bg-muted"
                  >
                    <CaretDown size={20} weight="bold" className={cn("transition-transform", open === r.id && "rotate-180")} />
                  </button>
                </td>
              </tr>
              {open === r.id && (
                <tr className="bg-inset">
                  <td colSpan={5} className="px-5 py-5"><ResponseDetail row={r} prompts={prompts} /></td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {/* Mobile cards */}
      <ul className="divide-y md:hidden">
        {page.items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => toggle(r.id)}
              aria-expanded={open === r.id}
              className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-inset"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-bold break-words">{r.voter.full_name}</span>
                <span className="block font-mono text-sm text-muted-foreground">{formatIC(r.voter.ic)}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  P.{r.voter.parlimen.code} {r.voter.parlimen.name}, {formatDateTimeMs(r.updated_at)}
                </span>
                <span className="mt-2 block"><AnswerChips row={r} prompts={prompts} /></span>
              </span>
              <CaretDown size={20} weight="bold" className={cn("mt-1 shrink-0 text-muted-foreground transition-transform", open === r.id && "rotate-180")} />
            </button>
            {open === r.id && (
              <div className="bg-inset px-4 py-4">
                <ResponseDetail row={r} prompts={prompts} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function ResponseDetail({ row, prompts }: { row: ResponseRow; prompts: Prompts }) {
  const v = row.voter;
  return (
    <div className="grid gap-x-10 gap-y-4 text-base md:grid-cols-2">
      <dl className="grid content-start gap-2.5">
        <Detail label="Tarikh lahir / jantina" value={`${formatDateMs(v.dob)}, ${v.gender}`} />
        <Detail label="Lokaliti" value={formatArea(v.lokaliti)} />
        <Detail label="Daerah mengundi" value={formatArea(v.daerah_mengundi)} />
        <Detail label="DUN" value={formatArea(v.dun)} />
        <Detail label="Parlimen / negeri" value={`${formatArea(v.parlimen)}, ${v.state}`} />
      </dl>
      <dl className="grid content-start gap-2.5">
        {Object.entries(prompts).map(([qid, q]) => {
          const opt = q.options.find((o) => o.key === row.answers[qid]);
          return <Detail key={qid} label={q.prompt} value={opt ? `${opt.key}. ${opt.label}` : "-"} />;
        })}
        <Detail
          label="Rekod"
          value={`ID ${row.id.slice(0, 8)}, dihantar ${row.submit_count} kali, pertama ${formatDateTimeMs(row.created_at)}${v.is_demo ? ", pemilih demo" : ""}`}
        />
      </dl>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-bold break-words">{value}</dd>
    </div>
  );
}

function Pagination({ page, pageNo, onChange }: { page: ResponsePage; pageNo: number; onChange: (n: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(page.total / page.limit));
  const from = (page.page - 1) * page.limit + 1;
  const to = Math.min(page.page * page.limit, page.total);
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-3 sm:px-5">
      <p className="text-base text-muted-foreground tabular-nums">
        {from}-{to} daripada {page.total.toLocaleString("ms-MY")}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="icon" aria-label="Halaman sebelum" disabled={pageNo <= 1} onClick={() => onChange(pageNo - 1)}>
          <CaretLeft size={20} weight="bold" />
        </Button>
        <Button variant="outline" size="icon" aria-label="Halaman seterusnya" disabled={pageNo >= totalPages} onClick={() => onChange(pageNo + 1)}>
          <CaretRight size={20} weight="bold" />
        </Button>
      </div>
    </div>
  );
}

/* ---------- API tab ---------- */

const ENDPOINTS = [
  { method: "POST", path: "/api/v1/voters/lookup", desc: "Semak IC", body: '{"ic":"990123125571"}' },
  { method: "POST", path: "/api/v1/responses", desc: "Hantar jawapan", body: '{"ic":"...","answers":{"q1":"A","q2":"B"}}' },
  { method: "GET", path: "/api/v1/contests?parlimen=173&dun=23&state=SABAH", desc: "Calon pilihan raya terkini bagi kerusi Parlimen dan DUN (ElectionData.MY, dicache)" },
  { method: "GET", path: "/api/v1/candidates/{uid}", desc: "Rekod penuh seorang calon (ElectionData.MY, dicache)" },
  { method: "GET", path: "/api/admin/photos?status=pending", desc: "Barisan foto calon (menunggu semakan, diluluskan, tiada foto)", admin: true },
  { method: "POST", path: "/api/admin/photos/{uid}/approve | reject | retry", desc: "Luluskan foto (badan: {\"path\":...}), tolak, atau cari semula", admin: true },
  { method: "POST", path: "/api/admin/photos/scan", desc: "Masukkan semua calon kawasan demo ke barisan carian foto", admin: true },
  { method: "GET", path: "/api/admin/stats", desc: "Ringkasan, taburan jawapan dan demografi", admin: true },
  { method: "GET", path: "/api/admin/responses?page=1&limit=25&q=&parlimen=", desc: "Senarai respons lengkap dengan maklumat pemilih", admin: true },
  { method: "GET", path: "/api/admin/responses/{id}", desc: "Satu respons", admin: true },
  { method: "GET", path: "/api/admin/export.csv?q=&parlimen=", desc: "Eksport CSV untuk Excel", admin: true },
  { method: "GET", path: "/api/health", desc: "Status pangkalan data dan cache" },
];

function ApiReference() {
  return (
    <section className="rounded-2xl border bg-card shadow-soft">
      <div className="border-b px-5 py-4">
        <h2 className="text-lg font-bold">API Gateway</h2>
        <p className="mt-1 text-base text-muted-foreground">
          Titik akhir bertanda <strong className="text-foreground">Admin</strong> memerlukan pengepala{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">X-API-Key</code>.
        </p>
      </div>
      <ul className="divide-y">
        {ENDPOINTS.map((e) => (
          <li key={e.path} className="grid gap-1.5 px-5 py-4 md:grid-cols-[5rem_minmax(0,1.3fr)_minmax(0,1fr)] md:items-start md:gap-5">
            <span>
              <span className={cn("rounded-md px-2 py-0.5 font-mono text-sm font-bold", e.method === "POST" ? "bg-primary text-primary-foreground" : "bg-muted")}>
                {e.method}
              </span>
            </span>
            <span className="min-w-0">
              <code className="block font-mono text-sm break-all">{e.path}</code>
              {e.body && <code className="mt-1 block font-mono text-sm break-all text-muted-foreground">{e.body}</code>}
            </span>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {e.desc}
              {e.admin && <span className="rounded-full border px-2 py-0.5 text-xs font-bold text-foreground">Admin</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
