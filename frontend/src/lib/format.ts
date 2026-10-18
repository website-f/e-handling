import type { Area } from "./api";

const MONTHS_MS = [
  "Januari", "Februari", "Mac", "April", "Mei", "Jun",
  "Julai", "Ogos", "September", "Oktober", "November", "Disember",
];

/** "1999-01-23" -> "23 Januari 1999" */
export function formatDateMs(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS_MS[m - 1]} ${y}`;
}

export function formatDateTimeMs(iso: string) {
  const dt = new Date(iso);
  const time = dt.toLocaleTimeString("ms-MY", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${dt.getDate()} ${MONTHS_MS[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}, ${time}`;
}

/** "173/23/01/001" + "KG PETAGAS" -> "173 / 23 / 01 / 001 - KG PETAGAS" */
export function formatArea(area: Area) {
  return `${area.code.split("/").join(" / ")} - ${area.name}`;
}

export function onlyDigits(value: string) {
  return value.replace(/\D/g, "").slice(0, 12);
}

/** "990123125571" -> "990123-12-5571" (also works on partial input) */
export function formatIC(digits: string) {
  const d = onlyDigits(digits);
  if (d.length <= 6) return d;
  if (d.length <= 8) return `${d.slice(0, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
}
