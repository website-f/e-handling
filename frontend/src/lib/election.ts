import type { ContestResult } from "./api";
import { formatDateMs } from "./format";

/** "GE-15" -> "PRU-15", "SE-15" + "Sabah" -> "PRN Sabah". */
export function electionName(code: string, state: string) {
  const [kind, n] = code.split("-");
  if (kind === "GE") return `PRU-${n}`;
  if (kind === "SE") return `PRN ${state}`;
  return code;
}

export function electionLabel(code: string, state: string, date: string) {
  return `${electionName(code, state)}, ${formatDateMs(date)}`;
}

/** "P.173 Putatan" -> { code: "P.173", name: "Putatan" } */
export function splitSeat(seat: string) {
  const i = seat.indexOf(" ");
  return i < 0 ? { code: seat, name: "" } : { code: seat.slice(0, i), name: seat.slice(i + 1) };
}

export const RESULT_LABEL: Record<ContestResult, string> = {
  won: "Menang",
  won_uncontested: "Menang tanpa bertanding",
  lost: "Kalah",
  lost_deposit: "Hilang deposit",
};

export const isWin = (r: ContestResult) => r === "won" || r === "won_uncontested";

export const fmtInt = (n: number) => n.toLocaleString("ms-MY");
export const fmtPct = (n: number | null | undefined) => (n == null ? "-" : `${n.toFixed(1)}%`);
