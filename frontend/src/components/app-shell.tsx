import * as React from "react";
import { CheckSquareOffset, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      if (allowed.includes(v as T)) return v as T;
    } catch {
      /* private mode */
    }
    return fallback;
  });
  const update = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  };
  return [value, update] as const;
}

/* ---------- text size ---------- */

const SCALES = [
  { id: "md", label: "A", size: "100%", aria: "Teks biasa", cls: "text-sm" },
  { id: "lg", label: "A+", size: "112.5%", aria: "Teks besar", cls: "text-base" },
  { id: "xl", label: "A++", size: "125%", aria: "Teks paling besar", cls: "text-lg" },
] as const;
const SCALE_IDS = SCALES.map((s) => s.id);

function TextSizeControl() {
  const [scale, setScale] = useStoredChoice("eh-text-size", SCALE_IDS, "lg");
  React.useEffect(() => {
    document.documentElement.style.fontSize = SCALES.find((s) => s.id === scale)!.size;
  }, [scale]);

  return (
    <div role="group" aria-label="Saiz teks" className="flex items-center gap-0.5 rounded-full border bg-card p-1 shadow-soft">
      <span className="hidden pr-1.5 pl-3 text-sm text-muted-foreground md:inline">Saiz teks</span>
      {SCALES.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-label={s.aria}
          aria-pressed={scale === s.id}
          onClick={() => setScale(s.id)}
          className={cn(
            "flex h-10 min-w-11 items-center justify-center rounded-full px-2 font-bold transition-colors",
            s.cls,
            scale === s.id ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- theme ---------- */

const THEMES = [
  { id: "system", label: "Auto", aria: "Ikut tetapan peranti", Icon: Desktop },
  { id: "light", label: "Cerah", aria: "Tema cerah", Icon: Sun },
  { id: "dark", label: "Gelap", aria: "Tema gelap", Icon: Moon },
] as const;
const THEME_IDS = THEMES.map((t) => t.id);

function ThemeControl() {
  const [theme, setTheme] = useStoredChoice("eh-theme", THEME_IDS, "system");
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") root.classList.add(theme);
  }, [theme]);

  return (
    <div role="group" aria-label="Tema paparan" className="grid grid-cols-3 gap-1 self-start rounded-full border bg-card p-1">
      {THEMES.map(({ id, label, aria, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={theme === id}
          aria-label={aria}
          onClick={() => setTheme(id)}
          className={cn(
            "inline-flex h-10 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-bold transition-colors",
            theme === id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon size={18} weight="bold" />
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------- shell ---------- */

export function AppShell({
  children,
  width = "default",
  subtitle = "Semakan Daftar Pemilih",
}: {
  children: React.ReactNode;
  width?: "default" | "wide";
  subtitle?: string;
}) {
  const container = cn("mx-auto w-full px-4 sm:px-6", width === "wide" ? "max-w-7xl" : "max-w-6xl");
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
        <div className={cn(container, "flex h-[4.25rem] items-center justify-between gap-3")}>
          <a href="/" className="flex min-w-0 items-center gap-3 rounded-xl">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-soft">
              <CheckSquareOffset size={24} weight="bold" />
            </span>
            <span className="hidden min-w-0 leading-tight min-[370px]:block">
              <span className="block text-lg font-bold whitespace-nowrap">e-Handling</span>
              <span className="hidden truncate text-sm text-muted-foreground sm:block">{subtitle}</span>
            </span>
          </a>
          <TextSizeControl />
        </div>
      </header>

      <main className={cn(container, "flex-1 pt-6 pb-10 sm:pt-10 sm:pb-16")}>{children}</main>

      <footer className="border-t bg-card/60">
        <div className={cn(container, "flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between")}>
          <p className="max-w-[52ch] text-sm text-muted-foreground">
            Paparan contoh untuk tujuan demonstrasi. Maklumat pemilih adalah data rekaan; data calon daripada ElectionData.MY.
          </p>
          <ThemeControl />
        </div>
      </footer>
    </div>
  );
}
