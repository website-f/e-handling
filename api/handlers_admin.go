package main

import (
	"encoding/csv"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const statsCacheKey = "admin:stats"

type countRow struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type questionStats struct {
	ID      string     `json:"id"`
	Prompt  string     `json:"prompt"`
	Options []countRow `json:"options"`
}

type statsResponse struct {
	Total         int             `json:"total"`
	Today         int             `json:"today"`
	Resubmissions int             `json:"resubmissions"`
	DemoVoters    int             `json:"demo_voters"`
	Questions     []questionStats `json:"questions"`
	ByParlimen    []countRow      `json:"by_parlimen"`
	ByGender      []countRow      `json:"by_gender"`
	ByAgeBand     []countRow      `json:"by_age_band"`
	GeneratedAt   time.Time       `json:"generated_at"`
}

func collectCounts(rows pgx.Rows, err error) ([]countRow, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (countRow, error) {
		var c countRow
		err := r.Scan(&c.Key, &c.Label, &c.Count)
		return c, err
	})
}

// GET /api/admin/stats: cached for a few seconds so a busy dashboard never hammers Postgres.
func (a *App) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s, ok := cacheGet[statsResponse](ctx, a, statsCacheKey); ok {
		writeJSON(w, http.StatusOK, s)
		return
	}

	var s statsResponse
	err := a.db.QueryRow(ctx, `SELECT
			count(*),
			count(*) FILTER (WHERE updated_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur'),
			count(*) FILTER (WHERE submit_count > 1),
			(SELECT count(*) FROM voters WHERE is_demo)
		FROM responses`).Scan(&s.Total, &s.Today, &s.Resubmissions, &s.DemoVoters)
	if err != nil {
		a.fail(w, "stats totals", err)
		return
	}

	qs, err := a.getQuestions(ctx)
	if err != nil {
		a.fail(w, "stats questions", err)
		return
	}
	answerCounts, err := collectCounts(a.db.Query(ctx, `SELECT a.key || ':' || a.value, '', count(*)
		FROM responses r CROSS JOIN LATERAL jsonb_each_text(r.answers) a GROUP BY 1`))
	if err != nil {
		a.fail(w, "stats answers", err)
		return
	}
	tally := map[string]int{}
	for _, c := range answerCounts {
		tally[c.Key] = c.Count
	}
	for _, q := range qs {
		qsOut := questionStats{ID: q.ID, Prompt: q.Prompt}
		for _, o := range q.Options {
			qsOut.Options = append(qsOut.Options, countRow{Key: o.Key, Label: o.Label, Count: tally[q.ID+":"+o.Key]})
		}
		s.Questions = append(s.Questions, qsOut)
	}

	if s.ByParlimen, err = collectCounts(a.db.Query(ctx, `SELECT l.par_code, l.par_name, count(*)
		FROM responses r JOIN voters v ON v.ic = r.ic JOIN localities l ON l.code = v.locality_code
		GROUP BY 1, 2 ORDER BY 3 DESC, 1`)); err != nil {
		a.fail(w, "stats parlimen", err)
		return
	}
	if s.ByGender, err = collectCounts(a.db.Query(ctx, `SELECT v.gender, v.gender, count(*)
		FROM responses r JOIN voters v ON v.ic = r.ic GROUP BY 1 ORDER BY 1`)); err != nil {
		a.fail(w, "stats gender", err)
		return
	}
	if s.ByAgeBand, err = collectCounts(a.db.Query(ctx, `SELECT band, band, count(*) FROM (
			SELECT CASE
				WHEN age < 30 THEN '18-29' WHEN age < 40 THEN '30-39' WHEN age < 50 THEN '40-49'
				WHEN age < 60 THEN '50-59' ELSE '60+' END AS band
			FROM (SELECT date_part('year', age(v.dob))::int AS age
				FROM responses r JOIN voters v ON v.ic = r.ic) ages
		) bands GROUP BY 1 ORDER BY 1`)); err != nil {
		a.fail(w, "stats age", err)
		return
	}

	s.GeneratedAt = time.Now().UTC()
	a.cacheSet(ctx, statsCacheKey, s, 5*time.Second)
	writeJSON(w, http.StatusOK, s)
}

type responseRow struct {
	ID          string            `json:"id"`
	Voter       Voter             `json:"voter"`
	Answers     map[string]string `json:"answers"`
	SubmitCount int               `json:"submit_count"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

const responseSelect = `SELECT r.id::text, r.answers, r.submit_count, r.created_at, r.updated_at, ` + voterColumns + `
	FROM responses r JOIN voters v ON v.ic = r.ic JOIN localities l ON l.code = v.locality_code`

func scanResponse(row pgx.Row, extra ...any) (responseRow, error) {
	var out responseRow
	var dob time.Time
	targets := append([]any{&out.ID, &out.Answers, &out.SubmitCount, &out.CreatedAt, &out.UpdatedAt},
		voterScanTargets(&out.Voter, &dob)...)
	err := row.Scan(append(targets, extra...)...)
	out.Voter.DOB = dob.Format("2006-01-02")
	return out, err
}

// filters shared by the list and CSV export: ?q= (IC prefix or name), ?parlimen= (code).
func responseFilters(r *http.Request) (string, []any) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	par := strings.TrimSpace(r.URL.Query().Get("parlimen"))
	return ` WHERE ($1 = '' OR r.ic LIKE $1 || '%' OR v.full_name ILIKE '%' || $1 || '%')
		AND ($2 = '' OR l.par_code = $2)`, []any{strings.ToUpper(q), par}
}

// GET /api/admin/responses?page=1&limit=25&q=&parlimen=
func (a *App) handleListResponses(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page = max(page, 1)
	if limit < 1 || limit > 200 {
		limit = 25
	}
	where, args := responseFilters(r)
	rows, err := a.db.Query(r.Context(), responseSelect+where+
		` ORDER BY r.updated_at DESC LIMIT $3 OFFSET $4`, append(args, limit, (page-1)*limit)...)
	if err != nil {
		a.fail(w, "list responses", err)
		return
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (responseRow, error) { return scanResponse(r) })
	if err != nil {
		a.fail(w, "list responses scan", err)
		return
	}
	var total int
	if err := a.db.QueryRow(r.Context(), `SELECT count(*) FROM responses r
		JOIN voters v ON v.ic = r.ic JOIN localities l ON l.code = v.locality_code`+where, args...).Scan(&total); err != nil {
		a.fail(w, "count responses", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "page": page, "limit": limit, "total": total})
}

// GET /api/admin/responses/{id}
func (a *App) handleGetResponse(w http.ResponseWriter, r *http.Request) {
	out, err := scanResponse(a.db.QueryRow(r.Context(), responseSelect+` WHERE r.id::text = $1`, r.PathValue("id")))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found", "Respons tidak dijumpai.")
		return
	}
	if err != nil {
		a.fail(w, "get response", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GET /api/admin/export.csv?q=&parlimen=  streams every matching row.
func (a *App) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	qs, err := a.getQuestions(ctx)
	if err != nil {
		a.fail(w, "export questions", err)
		return
	}
	where, args := responseFilters(r)
	rows, err := a.db.Query(ctx, responseSelect+where+` ORDER BY r.updated_at DESC`, args...)
	if err != nil {
		a.fail(w, "export query", err)
		return
	}
	defer rows.Close()

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="e-handling-responses-`+time.Now().In(myt).Format("20060102-1504")+`.csv"`)
	w.Write([]byte("\xEF\xBB\xBF")) // BOM so Excel opens UTF-8 correctly
	cw := csv.NewWriter(w)
	header := []string{"id", "ic", "nama", "tarikh_lahir", "jantina", "negeri", "parlimen", "dun",
		"daerah_mengundi", "lokaliti", "data_demo", "bil_hantar", "dihantar_pada", "dikemas_kini"}
	for _, q := range qs {
		header = append(header, q.ID)
	}
	cw.Write(header)
	for rows.Next() {
		row, err := scanResponse(rows)
		if err != nil {
			a.log.Error("export scan", "err", err)
			break
		}
		v := row.Voter
		rec := []string{row.ID, v.IC, v.FullName, v.DOB, v.Gender, v.State,
			v.Parlimen.Code + " " + v.Parlimen.Name, v.DUN.Code + " " + v.DUN.Name,
			v.DaerahMengundi.Code + " " + v.DaerahMengundi.Name, v.Lokaliti.Code + " " + v.Lokaliti.Name,
			strconv.FormatBool(v.IsDemo), strconv.Itoa(row.SubmitCount),
			row.CreatedAt.In(myt).Format(time.RFC3339), row.UpdatedAt.In(myt).Format(time.RFC3339)}
		for _, q := range qs {
			rec = append(rec, row.Answers[q.ID])
		}
		cw.Write(rec)
	}
	cw.Flush()
}
