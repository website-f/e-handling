export type Area = { code: string; name: string };

export type Voter = {
  ic: string;
  full_name: string;
  dob: string;
  gender: "LELAKI" | "PEREMPUAN";
  state: string;
  parlimen: Area;
  dun: Area;
  daerah_mengundi: Area;
  lokaliti: Area;
  is_demo: boolean;
};

export type CandidateRecord = { uid: string; contests: number; won: number; lost: number };

export type ContestResult = "won" | "won_uncontested" | "lost" | "lost_deposit";

export type BallotEntry = {
  name: string;
  party: string;
  party_name: string;
  coalition: string;
  coalition_name: string;
  votes: number;
  votes_perc: number | null;
  result: ContestResult;
  record: CandidateRecord | null;
  /** Approved portrait (absent when none has been approved yet). */
  photo_url?: string;
  /** Page the portrait came from, for attribution. */
  photo_page?: string;
};

/** Latest contest for one seat, from ElectionData.MY. Ballot is ordered by votes, highest first. */
export type Contest = {
  level: "parlimen" | "dun";
  seat: string;
  state: string;
  election: string;
  date: string;
  voters_total: number;
  voter_turnout: number;
  voter_turnout_perc: number | null;
  majority: number;
  majority_perc: number | null;
  ballot: BallotEntry[];
};

export type HistoryEntry = {
  election: string;
  type: "parlimen" | "dun";
  date: string;
  seat: string;
  state: string;
  party: string;
  coalition: string;
  votes: number;
  votes_perc: number | null;
  result: ContestResult;
};

export type Question = {
  id: string;
  prompt: string;
  options: { key: string; label: string }[];
};

export type Answers = Record<string, string>;

export type LookupResult = {
  voter: Voter;
  contests: Contest[] | null;
  contests_error: string;
  questions: Question[];
  previous_response: { answers: Answers; updated_at: string } | null;
};

export type SubmitResult = { id: string; updated: boolean; submitted_at: string };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const NETWORK_MESSAGE = "Tiada sambungan ke pelayan. Sila semak internet anda dan cuba lagi.";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(0, "network", NETWORK_MESSAGE);
  }
  if (res.status === 429) {
    throw new ApiError(429, "rate_limited", "Terlalu ramai pengguna sekarang. Sila tunggu sebentar dan cuba lagi.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "unknown", body?.message ?? "Ralat pelayan. Sila cuba lagi.");
  }
  return body as T;
}

export const api = {
  lookup: (ic: string) =>
    request<LookupResult>("/api/v1/voters/lookup", { method: "POST", body: JSON.stringify({ ic }) }),
  submit: (ic: string, answers: Answers) =>
    request<SubmitResult>("/api/v1/responses", { method: "POST", body: JSON.stringify({ ic, answers }) }),
  contests: (voter: Voter) => {
    const qs = new URLSearchParams({
      parlimen: voter.parlimen.code,
      dun: voter.dun.code.split("/").pop() ?? "",
      state: voter.state,
    });
    return request<{ contests: Contest[] }>(`/api/v1/contests?${qs}`).then((r) => r.contests);
  },
  candidateHistory: (uid: string) =>
    request<{ history: HistoryEntry[] }>(`/api/v1/candidates/${encodeURIComponent(uid)}`).then((r) => r.history),
};

/* ---------- admin ---------- */

export type CountRow = { key: string; label: string; count: number };

export type Stats = {
  total: number;
  today: number;
  resubmissions: number;
  demo_voters: number;
  questions: { id: string; prompt: string; options: CountRow[] }[];
  by_parlimen: CountRow[];
  by_gender: CountRow[];
  by_age_band: CountRow[];
  generated_at: string;
};

export type ResponseRow = {
  id: string;
  voter: Voter;
  answers: Answers;
  submit_count: number;
  created_at: string;
  updated_at: string;
};

export type ResponsePage = { items: ResponseRow[]; page: number; limit: number; total: number };

export type PhotoStatus = "queued" | "searching" | "pending" | "approved" | "rejected" | "not_found" | "error";

export type PhotoOption = {
  path: string;
  source: "wikipedia" | "web";
  source_url: string;
  page_url: string;
  title: string;
  faces: number;
  score: number;
  /** Other sites whose photo shows the same face (0 = unconfirmed). */
  agree?: number;
};

export type PhotoRow = {
  uid: string;
  name: string;
  party: string;
  seat: string;
  state: string;
  status: PhotoStatus;
  source: string | null;
  image_path: string | null;
  page_url: string | null;
  options: PhotoOption[];
  attempts: number;
  last_error: string | null;
  updated_at: string;
};

export type PhotoPage = { items: PhotoRow[]; counts: Partial<Record<PhotoStatus, number>>; page: number; limit: number; total: number };

export function adminApi(key: string) {
  const headers = { "X-API-Key": key };
  return {
    stats: () => request<Stats>("/api/admin/stats", { headers }),
    responses: (params: { page: number; q: string; parlimen: string }) => {
      const qs = new URLSearchParams({ page: String(params.page), limit: "20", q: params.q, parlimen: params.parlimen });
      return request<ResponsePage>(`/api/admin/responses?${qs}`, { headers });
    },
    photos: (status: string, page = 1) =>
      request<PhotoPage>(`/api/admin/photos?${new URLSearchParams({ status, page: String(page) })}`, { headers }),
    photoAction: (uid: string, action: "approve" | "reject" | "retry", path?: string) =>
      request<{ status: string }>(`/api/admin/photos/${encodeURIComponent(uid)}/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify(path ? { path } : {}),
      }),
    photoScan: () =>
      request<{ seats: number; seats_failed: number; candidates: number; queued: number }>("/api/admin/photos/scan", {
        method: "POST",
        headers,
        body: "{}",
      }),
    exportCsv: async (params: { q: string; parlimen: string }) => {
      const qs = new URLSearchParams(params);
      const res = await fetch(`/api/admin/export.csv?${qs}`, { headers });
      if (!res.ok) throw new ApiError(res.status, "export_failed", "Muat turun gagal.");
      const name = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ?? "responses.csv";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
