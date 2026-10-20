package main

import (
	"context"
	"errors"
	"net/http"
	"time"
)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)

	mux.HandleFunc("GET /api/v1/config", a.handleConfig)
	mux.HandleFunc("POST /api/v1/voters/lookup", a.handleLookup)
	mux.HandleFunc("POST /api/v1/spr/lookups", a.handleSprStart)
	mux.HandleFunc("POST /api/v1/spr/lookups/{id}/captcha", a.handleSprAnswer)
	mux.HandleFunc("POST /api/v1/spr/lookups/{id}/refresh", a.handleSprRefresh)
	mux.HandleFunc("POST /api/v1/spr/lookups/{id}/cancel", a.handleSprCancel)
	mux.HandleFunc("POST /api/v1/responses", a.handleSubmit)
	mux.HandleFunc("GET /api/v1/contests", a.handleContests)
	mux.HandleFunc("GET /api/v1/candidates/{uid}", a.handleCandidateHistory)

	mux.Handle("GET /api/admin/stats", a.requireAdmin(a.handleStats))
	mux.Handle("GET /api/admin/responses", a.requireAdmin(a.handleListResponses))
	mux.Handle("GET /api/admin/responses/{id}", a.requireAdmin(a.handleGetResponse))
	mux.Handle("GET /api/admin/export.csv", a.requireAdmin(a.handleExportCSV))
	mux.Handle("GET /api/admin/photos", a.requireAdmin(a.handleListPhotos))
	mux.Handle("POST /api/admin/photos/scan", a.requireAdmin(a.handlePhotoScan))
	mux.Handle("POST /api/admin/photos/{uid}/{action}", a.requireAdmin(a.handlePhotoAction))
	mux.Handle("GET /api/admin/spr", a.requireAdmin(a.handleAdminSpr))
	return a.observe(mux)
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	status := map[string]string{"status": "ok", "db": "ok", "cache": "disabled"}
	code := http.StatusOK
	if err := a.db.Ping(ctx); err != nil {
		status["status"], status["db"] = "degraded", "down"
		code = http.StatusServiceUnavailable
	}
	if a.rdb != nil {
		status["cache"] = "ok"
		if err := a.rdb.Ping(ctx).Err(); err != nil {
			status["cache"] = "down" // non-fatal: lookups fall back to postgres
		}
	}
	writeJSON(w, code, status)
}

// validateIC writes the user-facing error itself; ok=false means the response is already sent.
func validateIC(w http.ResponseWriter, raw string) (string, ICInfo, bool) {
	ic := normalizeIC(raw)
	info, err := parseIC(ic, time.Now().In(myt))
	switch {
	case errors.Is(err, errICFormat):
		writeError(w, http.StatusUnprocessableEntity, "invalid_ic", "Nombor kad pengenalan mesti 12 digit.")
		return "", info, false
	case err != nil:
		writeError(w, http.StatusUnprocessableEntity, "invalid_ic", "Tarikh lahir dalam nombor kad pengenalan tidak sah.")
		return "", info, false
	case info.Age < 18:
		writeError(w, http.StatusUnprocessableEntity, "not_eligible", "Pemilih mestilah berumur 18 tahun ke atas.")
		return "", info, false
	}
	return ic, info, true
}

type lookupResponse struct {
	Voter            Voter             `json:"voter"`
	Contests         []Contest         `json:"contests"`       // parliament first, then state seat
	ContestsError    string            `json:"contests_error"` // set when candidates could not be loaded
	Questions        []Question        `json:"questions"`
	PreviousResponse *PreviousResponse `json:"previous_response"`
	VoterToken       string            `json:"voter_token,omitempty"` // SPR mode: required to submit the survey
	Reused           bool              `json:"reused,omitempty"`      // SPR mode: answered from the stored record
}

// GET /api/v1/config: which IC flow the frontend shows.
func (a *App) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"voter_source": a.cfg.VoterSource, "demo": a.cfg.VoterSource == "demo"})
}

// POST (not GET) so the IC number never lands in access logs or browser history.
func (a *App) handleLookup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IC string `json:"ic"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if a.cfg.VoterSource == "spr" {
		// Every lookup goes through the portal (and its CAPTCHA); knowing an IC is not enough.
		writeError(w, http.StatusForbidden, "verification_required", "Sila buat semakan melalui portal SPR.")
		return
	}
	ic, info, ok := validateIC(w, req.IC)
	if !ok {
		return
	}
	ctx := r.Context()

	voter, err := a.getVoter(ctx, ic, info)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_registered", "Nombor kad pengenalan ini tiada dalam daftar pemilih.")
		return
	}
	if err != nil {
		a.fail(w, "lookup voter", err)
		return
	}
	contests, contestsErr := a.voterContests(ctx, voter)
	qs, err := a.getQuestions(ctx)
	if err != nil {
		a.fail(w, "lookup questions", err)
		return
	}
	prev, err := a.getPreviousResponse(ctx, ic)
	if err != nil {
		a.fail(w, "lookup previous response", err)
		return
	}
	writeJSON(w, http.StatusOK, lookupResponse{Voter: voter, Contests: contests, ContestsError: contestsErr, Questions: qs, PreviousResponse: prev})
}

func (a *App) handleSubmit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IC         string            `json:"ic"`
		Answers    map[string]string `json:"answers"`
		VoterToken string            `json:"voter_token"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ic, info, ok := validateIC(w, req.IC)
	if !ok {
		return
	}
	ctx := r.Context()
	if a.cfg.VoterSource == "spr" && !a.checkVoterToken(req.VoterToken, ic, time.Now()) {
		writeError(w, http.StatusForbidden, "verification_required", "Sesi semakan telah tamat. Sila semak semula melalui portal SPR.")
		return
	}

	voter, err := a.getVoter(ctx, ic, info)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_registered", "Nombor kad pengenalan ini tiada dalam daftar pemilih.")
		return
	}
	if err != nil {
		a.fail(w, "submit voter", err)
		return
	}
	if a.cfg.VoterSource == "spr" && voter.Source != "spr" {
		writeError(w, http.StatusForbidden, "verification_required", "Sila semak semula melalui portal SPR.")
		return
	}
	qs, err := a.getQuestions(ctx)
	if err != nil {
		a.fail(w, "submit questions", err)
		return
	}
	if len(req.Answers) != len(qs) {
		writeError(w, http.StatusUnprocessableEntity, "incomplete", "Sila jawab semua soalan.")
		return
	}
	for _, q := range qs {
		if !validOption(q, req.Answers[q.ID]) {
			writeError(w, http.StatusUnprocessableEntity, "incomplete", "Sila jawab semua soalan.")
			return
		}
	}

	ua := r.UserAgent()
	if len(ua) > 300 {
		ua = ua[:300]
	}
	var out struct {
		ID          string    `json:"id"`
		Updated     bool      `json:"updated"`
		SubmittedAt time.Time `json:"submitted_at"`
	}
	var count int
	err = a.db.QueryRow(ctx, `INSERT INTO responses (ic, par_code, answers, ip_hash, user_agent)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (ic) DO UPDATE SET
			answers = EXCLUDED.answers, par_code = EXCLUDED.par_code,
			ip_hash = EXCLUDED.ip_hash, user_agent = EXCLUDED.user_agent,
			submit_count = responses.submit_count + 1, updated_at = now()
		RETURNING id::text, submit_count, updated_at`,
		ic, voter.Parlimen.Code, req.Answers, a.hashIP(clientIP(r)), ua).
		Scan(&out.ID, &count, &out.SubmittedAt)
	if err != nil {
		a.fail(w, "insert response", err)
		return
	}
	out.Updated = count > 1
	a.cacheDel(ctx, statsCacheKey)
	writeJSON(w, http.StatusCreated, out)
}

func validOption(q Question, key string) bool {
	for _, o := range q.Options {
		if o.Key == key {
			return true
		}
	}
	return false
}

func (a *App) fail(w http.ResponseWriter, op string, err error) {
	a.log.Error(op, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "Ralat pelayan. Sila cuba lagi sebentar.")
}
