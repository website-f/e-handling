package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
)

// Candidate portraits. The API only enqueues work and serves what an admin (or the Wikipedia
// auto-approve rule) has approved; searching and face-cropping happen in photos/worker.py.

type approvedPhoto struct {
	Path string
	Page string
}

type photoIndex struct {
	byUID map[string]approvedPhoto
}

type photoState struct {
	index    atomic.Pointer[photoIndex]
	enqueued sync.Map // uid -> struct{}: already sent to the queue by this process
}

func (a *App) refreshPhotoIndex(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `SELECT uid, image_path, coalesce(page_url, '')
		FROM candidate_photos WHERE status = 'approved' AND image_path IS NOT NULL`)
	if err != nil {
		return err
	}
	idx := &photoIndex{byUID: map[string]approvedPhoto{}}
	for rows.Next() {
		var uid string
		var p approvedPhoto
		if err := rows.Scan(&uid, &p.Path, &p.Page); err != nil {
			rows.Close()
			return err
		}
		idx.byUID[uid] = p
	}
	if err := rows.Err(); err != nil {
		return err
	}
	a.photos.index.Store(idx)
	return nil
}

// watchPhotos keeps the approved-photo index fresh so new approvals reach voters within seconds.
func (a *App) watchPhotos(ctx context.Context) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		if err := a.refreshPhotoIndex(ctx); err != nil && ctx.Err() == nil {
			a.log.Warn("photo index refresh", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// withPhotos returns contests with approved photo URLs filled in. Contests can be shared between
// requests (singleflight), so ballots are copied rather than mutated in place.
func (a *App) withPhotos(contests []Contest) []Contest {
	idx := a.photos.index.Load()
	out := make([]Contest, len(contests))
	for i, c := range contests {
		ballot := make([]BallotEntry, len(c.Ballot))
		copy(ballot, c.Ballot)
		if idx != nil {
			for j := range ballot {
				if ballot[j].Record == nil {
					continue
				}
				if p, ok := idx.byUID[ballot[j].Record.UID]; ok {
					ballot[j].PhotoURL, ballot[j].PhotoPage = p.Path, p.Page
				}
			}
		}
		c.Ballot = ballot
		out[i] = c
	}
	return out
}

// enqueuePhotos queues every candidate in these contests that this process hasn't queued yet.
// Fire-and-forget: it never slows the voter's request.
func (a *App) enqueuePhotos(contests []Contest) {
	type item struct{ uid, name, party, seat, state string }
	var batch []item
	for _, c := range contests {
		for _, b := range c.Ballot {
			if b.Record == nil {
				continue
			}
			if _, seen := a.photos.enqueued.LoadOrStore(b.Record.UID, struct{}{}); seen {
				continue
			}
			batch = append(batch, item{b.Record.UID, b.Name, b.Party, c.Seat, c.State})
		}
	}
	if len(batch) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		b := &pgx.Batch{}
		for _, it := range batch {
			b.Queue(`INSERT INTO candidate_photos (uid, name, party, seat, state) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (uid) DO NOTHING`, it.uid, it.name, it.party, it.seat, it.state)
		}
		if err := a.db.SendBatch(ctx, b).Close(); err != nil {
			a.log.Warn("enqueue photos", "err", err)
			for _, it := range batch {
				a.photos.enqueued.Delete(it.uid) // try again on the next request
			}
		}
	}()
}

/* ---------- admin ---------- */

type photoOption struct {
	Path      string  `json:"path"`
	Source    string  `json:"source"`
	SourceURL string  `json:"source_url"`
	PageURL   string  `json:"page_url"`
	Title     string  `json:"title"`
	Faces     int     `json:"faces"`
	Score     float64 `json:"score"`
}

type photoRow struct {
	UID       string        `json:"uid"`
	Name      string        `json:"name"`
	Party     string        `json:"party"`
	Seat      string        `json:"seat"`
	State     string        `json:"state"`
	Status    string        `json:"status"`
	Source    *string       `json:"source"`
	ImagePath *string       `json:"image_path"`
	PageURL   *string       `json:"page_url"`
	Options   []photoOption `json:"options"`
	Attempts  int           `json:"attempts"`
	LastError *string       `json:"last_error"`
	UpdatedAt time.Time     `json:"updated_at"`
}

var photoStatuses = map[string]bool{
	"queued": true, "searching": true, "pending": true, "approved": true, "rejected": true, "not_found": true, "error": true,
}

// GET /api/admin/photos?status=pending&page=1
func (a *App) handleListPhotos(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := r.URL.Query().Get("status")
	if status != "" && status != "all" && !photoStatuses[status] {
		writeError(w, http.StatusBadRequest, "bad_request", "Status tidak sah.")
		return
	}
	if status == "all" {
		status = ""
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	page = max(page, 1)
	const limit = 24

	rows, err := a.db.Query(ctx, `SELECT uid, name, party, seat, state, status, source, image_path, page_url,
			options, attempts, last_error, updated_at
		FROM candidate_photos WHERE ($1 = '' OR status = $1)
		ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'searching' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
			seat, name
		LIMIT $2 OFFSET $3`, status, limit, (page-1)*limit)
	if err != nil {
		a.fail(w, "list photos", err)
		return
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (photoRow, error) {
		var p photoRow
		var opts []byte
		err := r.Scan(&p.UID, &p.Name, &p.Party, &p.Seat, &p.State, &p.Status, &p.Source, &p.ImagePath, &p.PageURL,
			&opts, &p.Attempts, &p.LastError, &p.UpdatedAt)
		if err == nil {
			err = json.Unmarshal(opts, &p.Options)
		}
		return p, err
	})
	if err != nil {
		a.fail(w, "list photos scan", err)
		return
	}

	counts := map[string]int{}
	crows, err := a.db.Query(ctx, `SELECT status, count(*) FROM candidate_photos GROUP BY 1`)
	if err != nil {
		a.fail(w, "photo counts", err)
		return
	}
	for crows.Next() {
		var s string
		var n int
		if err := crows.Scan(&s, &n); err == nil {
			counts[s] = n
		}
	}
	crows.Close()
	total := 0
	for s, n := range counts {
		if status == "" || s == status {
			total += n
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "counts": counts, "page": page, "limit": limit, "total": total})
}

// POST /api/admin/photos/{uid}/{action}  action = approve {path} | reject | retry
func (a *App) handlePhotoAction(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid, action := r.PathValue("uid"), r.PathValue("action")
	if !candidateUID.MatchString(uid) {
		writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		return
	}
	var tag string
	var err error
	switch action {
	case "approve":
		var req struct {
			Path string `json:"path"`
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		// Only a picture the worker produced for this candidate can be approved.
		var opts []byte
		if err := a.db.QueryRow(ctx, `SELECT options FROM candidate_photos WHERE uid = $1`, uid).Scan(&opts); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeError(w, http.StatusNotFound, "not_found", "Calon tidak dijumpai.")
				return
			}
			a.fail(w, "approve photo", err)
			return
		}
		var options []photoOption
		_ = json.Unmarshal(opts, &options)
		var chosen *photoOption
		for i := range options {
			if options[i].Path == req.Path {
				chosen = &options[i]
			}
		}
		if chosen == nil {
			writeError(w, http.StatusUnprocessableEntity, "bad_path", "Foto ini bukan pilihan untuk calon tersebut.")
			return
		}
		res, e := a.db.Exec(ctx, `UPDATE candidate_photos SET status = 'approved', image_path = $2, source = $3,
			source_url = $4, page_url = $5, updated_at = now() WHERE uid = $1`,
			uid, chosen.Path, chosen.Source, chosen.SourceURL, chosen.PageURL)
		tag, err = res.String(), e
	case "reject":
		res, e := a.db.Exec(ctx, `UPDATE candidate_photos SET status = 'rejected', image_path = NULL, updated_at = now()
			WHERE uid = $1`, uid)
		tag, err = res.String(), e
	case "retry":
		res, e := a.db.Exec(ctx, `UPDATE candidate_photos SET status = 'queued', attempts = 0, last_error = NULL,
			queued_at = now(), updated_at = now() WHERE uid = $1`, uid)
		tag, err = res.String(), e
	default:
		writeError(w, http.StatusNotFound, "not_found", "Tindakan tidak dikenali.")
		return
	}
	if err != nil {
		a.fail(w, "photo "+action, err)
		return
	}
	if strings.HasSuffix(tag, " 0") {
		writeError(w, http.StatusNotFound, "not_found", "Calon tidak dijumpai.")
		return
	}
	_ = a.refreshPhotoIndex(ctx) // this replica shows the change at once; the others within 20s
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// POST /api/admin/photos/scan: queue every candidate for every seat in the locality table, so
// photos are ready before voters arrive.
func (a *App) handlePhotoScan(w http.ResponseWriter, r *http.Request) {
	if a.ed == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "ElectionData tidak dikonfigurasi.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	rows, err := a.db.Query(ctx, `SELECT DISTINCT par_code, dun_code, state FROM localities`)
	if err != nil {
		a.fail(w, "photo scan seats", err)
		return
	}
	type seat struct{ par, dun, state string }
	var seats []seat
	for rows.Next() {
		var s seat
		if err := rows.Scan(&s.par, &s.dun, &s.state); err == nil {
			seats = append(seats, s)
		}
	}
	rows.Close()

	var all []Contest
	failed := 0
	for _, s := range seats {
		par, _ := strconv.Atoi(s.par)
		dun := 0
		if i := strings.LastIndexByte(s.dun, '/'); i >= 0 {
			dun, _ = strconv.Atoi(s.dun[i+1:])
		}
		cs, err := a.ed.contests(ctx, par, dun, s.state)
		if err != nil {
			failed++
			continue
		}
		all = append(all, cs...)
	}

	seen := map[string]bool{}
	for _, c := range all {
		for _, e := range c.Ballot {
			if e.Record != nil {
				seen[e.Record.UID] = true
			}
		}
	}

	// Each scan is one "candidates" phase. Every candidate it covers (new or already known) is
	// tagged with the phase; the phase completes once all of them reach a terminal photo state,
	// and only then does the SPR voter lookup open (spr.go gateOpen).
	status := "processing"
	switch {
	case len(seats) > 0 && failed == len(seats):
		status = "failed"
	case len(seen) == 0:
		status = "completed"
	}
	detail, _ := json.Marshal(map[string]int{"seats": len(seats), "seats_failed": failed})
	var phaseID int64
	if err := a.db.QueryRow(ctx, `INSERT INTO pipeline_phases (name, status, total, detail, finished_at)
		VALUES ('candidates', $1, $2, $3, CASE WHEN $1 = 'processing' THEN NULL ELSE now() END) RETURNING id`,
		status, len(seen), detail).Scan(&phaseID); err != nil {
		a.fail(w, "photo scan phase", err)
		return
	}

	queued := 0
	b := &pgx.Batch{}
	done := map[string]bool{}
	for _, c := range all {
		for _, e := range c.Ballot {
			if e.Record == nil || done[e.Record.UID] {
				continue
			}
			done[e.Record.UID] = true
			// xmax = 0 only for a freshly inserted row: existing ones keep their status and files.
			b.Queue(`INSERT INTO candidate_photos (uid, name, party, seat, state, phase_id) VALUES ($1, $2, $3, $4, $5, $6)
				ON CONFLICT (uid) DO UPDATE SET phase_id = EXCLUDED.phase_id RETURNING xmax = 0`,
				e.Record.UID, e.Name, e.Party, c.Seat, c.State, phaseID)
			a.photos.enqueued.Store(e.Record.UID, struct{}{})
		}
	}
	if b.Len() > 0 {
		br := a.db.SendBatch(ctx, b)
		for i := 0; i < b.Len(); i++ {
			var inserted bool
			if err := br.QueryRow().Scan(&inserted); err == nil && inserted {
				queued++
			}
		}
		if err := br.Close(); err != nil {
			a.fail(w, "photo scan enqueue", err)
			return
		}
	}
	a.gate.mu.Lock()
	a.gate.info = nil // a new phase closes the gate until it completes
	a.gate.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"seats": len(seats), "seats_failed": failed, "candidates": len(seen),
		"queued": queued, "phase_id": phaseID, "phase_status": status})
}
