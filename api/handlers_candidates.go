package main

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// voterContests is best-effort: a slow or failing upstream never blocks the voter lookup.
func (a *App) voterContests(ctx context.Context, v Voter) ([]Contest, string) {
	if a.ed == nil {
		return nil, "Senarai calon tidak tersedia buat masa ini."
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	contests, err := a.ed.contestsForVoter(ctx, v)
	switch {
	case err == nil:
		a.enqueuePhotos(contests)
		return a.withPhotos(contests), ""
	case errors.Is(err, errNotFound):
		return nil, "Tiada data calon untuk kawasan ini."
	default:
		a.log.Warn("contests for voter", "par", v.Parlimen.Code, "dun", v.DUN.Code, "err", err)
		return nil, "Senarai calon tidak dapat dimuatkan buat masa ini. Sila cuba lagi."
	}
}

// GET /api/v1/contests?parlimen=173&dun=23&state=SABAH  (retry path for the candidates screen)
func (a *App) handleContests(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	par, err := strconv.Atoi(q.Get("parlimen"))
	dun, _ := strconv.Atoi(q.Get("dun"))
	state := strings.TrimSpace(q.Get("state"))
	if err != nil || par < 1 || par > 999 || dun < 0 || dun > 99 || state == "" || len(state) > 40 {
		writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		return
	}
	if a.ed == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "Senarai calon tidak tersedia buat masa ini.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	contests, err := a.ed.contests(ctx, par, dun, state)
	switch {
	case errors.Is(err, errNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Tiada data calon untuk kawasan ini.")
	case err != nil:
		a.log.Warn("contests", "err", err)
		writeError(w, http.StatusBadGateway, "upstream", "Senarai calon tidak dapat dimuatkan buat masa ini. Sila cuba lagi.")
	default:
		a.enqueuePhotos(contests)
		writeJSON(w, http.StatusOK, map[string]any{"contests": a.withPhotos(contests)})
	}
}

var candidateUID = regexp.MustCompile(`^[A-Z0-9]{3,12}$`)

// GET /api/v1/candidates/{uid}: every contest a candidate has stood in, most recent first.
func (a *App) handleCandidateHistory(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	if !candidateUID.MatchString(uid) {
		writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		return
	}
	if a.ed == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "Rekod calon tidak tersedia buat masa ini.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	hist, err := a.ed.history(ctx, uid)
	switch {
	case errors.Is(err, errNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Rekod calon tidak dijumpai.")
	case err != nil:
		a.log.Warn("candidate history", "uid", uid, "err", err)
		writeError(w, http.StatusBadGateway, "upstream", "Rekod calon tidak dapat dimuatkan. Sila cuba lagi.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"history": hist})
	}
}
