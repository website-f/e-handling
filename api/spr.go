package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// MySPR Semak voter lookup (VOTER_SOURCE=spr). The API never talks to the portal itself: the
// `spr` service (photos/spr.py) holds one Camoufox session per voter and shows the voter the
// portal's own CAPTCHA. This file owns input validation, the candidate-phase gate, the audit
// trail, and turning a record the portal confirmed into a Voter row.
//
//   POST /api/v1/spr/lookups                 {ic}      -> {job_id, status: awaiting_captcha, captcha}
//   POST /api/v1/spr/lookups/{id}/captcha    {answer}  -> lookupResponse + voter_token, or a new CAPTCHA
//   POST /api/v1/spr/lookups/{id}/refresh              -> new CAPTCHA image

var jobIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type sprVoter struct {
	FullName       string `json:"full_name"`
	State          string `json:"state"`
	Parlimen       Area   `json:"parlimen"`
	DUN            Area   `json:"dun"`
	DaerahMengundi Area   `json:"daerah_mengundi"`
	Lokaliti       Area   `json:"lokaliti"`
	PollingCentre  string `json:"polling_centre"`
	Stream         string `json:"stream"`
	VotingTime     string `json:"voting_time"`
}

// sprField is one label/value row exactly as the portal showed it, kept so nothing captured is lost.
type sprField struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type sprResult struct {
	Status       string         `json:"status"`
	RawFields    []sprField     `json:"raw_fields"`
	Reason       string         `json:"reason"`
	Message      string         `json:"message"`
	Captcha      string         `json:"captcha"`
	AttemptsLeft int            `json:"attempts_left"`
	ExpiresIn    int            `json:"expires_in"`
	IC           string         `json:"ic"`
	Voter        *sprVoter      `json:"voter"`
	Diagnostics  map[string]any `json:"diagnostics"`
}

// sprChallenge is what the voter sees while the portal waits for its CAPTCHA.
type sprChallenge struct {
	JobID        string `json:"job_id"`
	Status       string `json:"status"` // awaiting_captcha | captcha_wrong | captcha_expired | invalid_answer | portal_message | refresh_limit
	Captcha      string `json:"captcha"`
	AttemptsLeft int    `json:"attempts_left"`
	ExpiresIn    int    `json:"expires_in"`
	Message      string `json:"message,omitempty"`
}

var challengeStatuses = map[string]bool{
	"awaiting_captcha": true, "captcha_wrong": true, "captcha_expired": true, "invalid_answer": true,
	"portal_message": true, "refresh_limit": true,
}

type sprFailure struct {
	code    int
	errCode string
	message string
}

// Terminal worker outcomes -> what the voter is told. Never includes the IC or portal internals.
var sprFailures = map[string]sprFailure{
	"not_registered":    {http.StatusNotFound, "not_registered", "Nombor kad pengenalan ini tiada dalam daftar pemilih SPR."},
	"blocked":           {http.StatusServiceUnavailable, "spr_blocked", "Portal SPR meminta pengesahan tambahan yang tidak dapat diteruskan di sini. Sila semak terus di mysprsemak.spr.gov.my."},
	"unavailable":       {http.StatusServiceUnavailable, "spr_unavailable", "Portal SPR tidak dapat dihubungi buat masa ini. Sila cuba lagi sebentar."},
	"busy":              {http.StatusServiceUnavailable, "spr_busy", "Terlalu ramai semakan serentak. Sila cuba lagi dalam seminit."},
	"unexpected_layout": {http.StatusBadGateway, "spr_changed", "Paparan portal SPR tidak seperti dijangka, jadi keputusan tidak dapat disahkan. Sila cuba lagi kemudian."},
	"too_many_attempts": {http.StatusTooManyRequests, "too_many_attempts", "Terlalu banyak cubaan captcha. Sila mula semula."},
	"expired":           {http.StatusGone, "expired", "Sesi semakan telah tamat. Sila mula semula."},
	"cancelled":         {http.StatusGone, "expired", "Sesi semakan telah tamat. Sila mula semula."},
	"in_progress":       {http.StatusConflict, "in_progress", "Semakan sedang diproses. Sila tunggu."},
	"invalid_input":     {http.StatusUnprocessableEntity, "invalid_ic", "Nombor kad pengenalan mesti 12 digit."},
	"unauthorized":      {http.StatusBadGateway, "spr_unavailable", "Perkhidmatan semakan SPR tidak tersedia."},
}

/* ---------- keyed hashes and voter tokens ---------- */

func (a *App) mac(label, data string) []byte {
	m := hmac.New(sha256.New, []byte(a.cfg.IPHashSalt+"|"+a.cfg.AdminAPIKey+"|"+label))
	m.Write([]byte(data))
	return m.Sum(nil)
}

func (a *App) icHash(ic string) string { return hex.EncodeToString(a.mac("spr-ic", ic)) }

func maskIC(ic string) string {
	if len(ic) < 8 {
		return strings.Repeat("*", len(ic))
	}
	return ic[:6] + strings.Repeat("*", len(ic)-8) + ic[len(ic)-2:]
}

const voterTokenTTL = 2 * time.Hour

// voterToken proves this browser completed an SPR lookup for `ic`; survey submissions need it.
func (a *App) voterToken(ic string, now time.Time) string {
	exp := strconv.FormatInt(now.Add(voterTokenTTL).Unix(), 10)
	return exp + "." + hex.EncodeToString(a.mac("voter-token", ic+"|"+exp))
}

func (a *App) checkVoterToken(token, ic string, now time.Time) bool {
	exp, sig, ok := strings.Cut(token, ".")
	if !ok {
		return false
	}
	n, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || now.Unix() > n || n > now.Add(voterTokenTTL+time.Minute).Unix() {
		return false
	}
	want := hex.EncodeToString(a.mac("voter-token", ic+"|"+exp))
	return hmac.Equal([]byte(sig), []byte(want))
}

func newJobID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

/* ---------- worker client ---------- */

// Every API replica talks to one worker; keep enough idle connections for a burst of voters.
var sprHTTP = &http.Client{Timeout: 55 * time.Second, Transport: &http.Transport{
	MaxIdleConns: 64, MaxIdleConnsPerHost: 64, IdleConnTimeout: 90 * time.Second}}

func (a *App) sprCall(ctx context.Context, path string, body any) (sprResult, error) {
	var res sprResult
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.SPRWorkerURL+path, bytes.NewReader(raw))
	if err != nil {
		return res, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", a.cfg.SPRInternalToken)
	resp, err := sprHTTP.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return sprResult{Status: "unauthorized"}, nil
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&res); err != nil {
		return res, fmt.Errorf("spr worker %d: %w", resp.StatusCode, err)
	}
	return res, nil
}

/* ---------- candidate phase gate ---------- */

type phaseInfo struct {
	ID         int64      `json:"id"`
	Status     string     `json:"status"`
	Total      int        `json:"total"`
	Remaining  int        `json:"remaining"` // queued or being searched
	Approved   int        `json:"approved"`
	Review     int        `json:"review"` // found, waiting for an admin
	NotFound   int        `json:"not_found"`
	Failed     int        `json:"failed"`
	Detail     any        `json:"detail"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Ready      bool       `json:"ready"`
}

type gateCache struct {
	mu   sync.Mutex
	at   time.Time
	info *phaseInfo
}

func phaseReady(status string) bool {
	return status == "completed" || status == "completed_with_warnings"
}

// phaseOutcome decides a finished phase's status: warnings when any candidate ended without a
// usable photo or any seat could not be loaded.
func phaseOutcome(p *phaseInfo, seatsFailed int) string {
	if p.NotFound+p.Failed > 0 || seatsFailed > 0 {
		return "completed_with_warnings"
	}
	return "completed"
}

// candidatePhase reports the latest candidates phase, closing it once every candidate in it has
// reached a terminal photo state. nil = no scan has ever been run.
func (a *App) candidatePhase(ctx context.Context) (*phaseInfo, error) {
	var p phaseInfo
	var detail []byte
	err := a.db.QueryRow(ctx, `SELECT id, status, total, detail, started_at, finished_at FROM pipeline_phases
		WHERE name = 'candidates' ORDER BY id DESC LIMIT 1`).Scan(&p.ID, &p.Status, &p.Total, &detail, &p.StartedAt, &p.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d map[string]any
	_ = json.Unmarshal(detail, &d)
	p.Detail = d
	err = a.db.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE status IN ('queued', 'searching')),
			count(*) FILTER (WHERE status = 'approved'),
			count(*) FILTER (WHERE status = 'pending'),
			count(*) FILTER (WHERE status IN ('not_found', 'rejected')),
			count(*) FILTER (WHERE status = 'error')
		FROM candidate_photos WHERE phase_id = $1`, p.ID).Scan(&p.Remaining, &p.Approved, &p.Review, &p.NotFound, &p.Failed)
	if err != nil {
		return nil, err
	}
	if p.Status == "processing" && p.Remaining == 0 {
		seatsFailed := 0
		if v, ok := d["seats_failed"].(float64); ok {
			seatsFailed = int(v)
		}
		p.Status = phaseOutcome(&p, seatsFailed)
		now := time.Now()
		p.FinishedAt = &now
		if _, err := a.db.Exec(ctx, `UPDATE pipeline_phases SET status = $2, finished_at = now() WHERE id = $1 AND status = 'processing'`,
			p.ID, p.Status); err != nil {
			return nil, err
		}
	}
	p.Ready = phaseReady(p.Status)
	return &p, nil
}

// gateOpen is the hot-path check before any SPR lookup (cached for 10 s per replica).
func (a *App) gateOpen(ctx context.Context) (bool, error) {
	if !a.cfg.SPRRequireCandidates {
		return true, nil
	}
	a.gate.mu.Lock()
	defer a.gate.mu.Unlock()
	if a.gate.info != nil && a.gate.info.Ready && time.Since(a.gate.at) < 10*time.Second {
		return true, nil
	}
	p, err := a.candidatePhase(ctx)
	if err != nil {
		return false, err
	}
	a.gate.info, a.gate.at = p, time.Now()
	return p != nil && p.Ready, nil
}

/* ---------- handlers ---------- */

func (a *App) sprEnabled(w http.ResponseWriter) bool {
	if a.cfg.VoterSource != "spr" {
		writeError(w, http.StatusNotFound, "not_found", "Semakan SPR tidak diaktifkan.")
		return false
	}
	return true
}

func (a *App) sprAudit(ctx context.Context, id, status, reason string, attempt bool, final bool) {
	_, err := a.db.Exec(ctx, `UPDATE spr_lookups SET status = $2, reason = NULLIF($3, ''),
			captcha_attempts = captcha_attempts + CASE WHEN $4 THEN 1 ELSE 0 END,
			finished_at = CASE WHEN $5 THEN now() ELSE finished_at END, updated_at = now()
		WHERE id = $1`, id, status, reason, attempt, final)
	if err != nil {
		a.log.Warn("spr audit", "job", id, "err", err)
	}
}

// POST /api/v1/spr/lookups {ic}
func (a *App) handleSprStart(w http.ResponseWriter, r *http.Request) {
	if !a.sprEnabled(w) {
		return
	}
	var req struct {
		IC      string `json:"ic"`
		Refresh bool   `json:"refresh"` // voter asked to re-check on the portal
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	ic, _, ok := validateIC(w, req.IC)
	if !ok {
		return
	}
	ctx := r.Context()
	open, err := a.gateOpen(ctx)
	if err != nil {
		a.fail(w, "spr gate", err)
		return
	}
	if !open {
		writeError(w, http.StatusServiceUnavailable, "candidates_not_ready",
			"Sistem sedang menyediakan data calon. Semakan SPR akan dibuka sebaik sahaja ia selesai.")
		return
	}

	job := newJobID()

	// Already confirmed on the portal before: answer from the stored record, no portal session.
	if !req.Refresh {
		voter, err := a.storedSprVoter(ctx, ic)
		if err != nil {
			a.fail(w, "spr stored voter", err)
			return
		}
		if voter != nil {
			if _, err := a.db.Exec(ctx, `INSERT INTO spr_lookups (id, ic_hash, ic_masked, ip_hash, status, finished_at)
				VALUES ($1, $2, $3, $4, 'reused', now())`, job, a.icHash(ic), maskIC(ic), a.hashIP(clientIP(r))); err != nil {
				a.log.Warn("spr audit reuse", "err", err)
			}
			a.writeVoterResult(w, r, *voter, true)
			return
		}
	}

	if _, err := a.db.Exec(ctx, `INSERT INTO spr_lookups (id, ic_hash, ic_masked, ip_hash, status) VALUES ($1, $2, $3, $4, 'processing')`,
		job, a.icHash(ic), maskIC(ic), a.hashIP(clientIP(r))); err != nil {
		a.fail(w, "spr audit insert", err)
		return
	}
	res, err := a.sprCall(ctx, "/sessions", map[string]string{"job_id": job, "ic": ic})
	if err != nil {
		a.log.Warn("spr start", "job", job, "err", err)
		a.sprAudit(context.WithoutCancel(ctx), job, "failed", "worker_unreachable", false, true)
		f := sprFailures["unavailable"]
		writeError(w, f.code, f.errCode, f.message)
		return
	}
	a.sprRespond(w, r, job, res, false)
}

// POST /api/v1/spr/lookups/{id}/captcha {answer}
func (a *App) handleSprAnswer(w http.ResponseWriter, r *http.Request) {
	if !a.sprEnabled(w) {
		return
	}
	job := r.PathValue("id")
	var req struct {
		Answer string `json:"answer"`
	}
	if !jobIDRe.MatchString(job) || !decodeJSON(w, r, &req) {
		if !jobIDRe.MatchString(job) {
			writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		}
		return
	}
	answer := strings.TrimSpace(req.Answer)
	if len(answer) < 3 || len(answer) > 6 || normalizeIC(answer) != answer {
		writeError(w, http.StatusUnprocessableEntity, "invalid_answer", "Masukkan nombor captcha seperti dalam gambar.")
		return
	}
	res, err := a.sprCall(r.Context(), "/sessions/"+job+"/captcha", map[string]string{"answer": answer})
	if err != nil {
		a.log.Warn("spr answer", "job", job, "err", err)
		a.sprAudit(context.WithoutCancel(r.Context()), job, "failed", "worker_unreachable", false, true)
		f := sprFailures["unavailable"]
		writeError(w, f.code, f.errCode, f.message)
		return
	}
	a.sprRespond(w, r, job, res, true)
}

// POST /api/v1/spr/lookups/{id}/cancel: the voter left the CAPTCHA screen (Back, start over,
// closed the tab via sendBeacon). Frees the browser slot now instead of after the session TTL.
func (a *App) handleSprCancel(w http.ResponseWriter, r *http.Request) {
	if !a.sprEnabled(w) {
		return
	}
	job := r.PathValue("id")
	if !jobIDRe.MatchString(job) {
		writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, a.cfg.SPRWorkerURL+"/sessions/"+job, nil)
	req.Header.Set("X-Internal-Token", a.cfg.SPRInternalToken)
	if resp, err := sprHTTP.Do(req); err == nil {
		resp.Body.Close()
	} else {
		a.log.Warn("spr cancel", "job", job, "err", err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE spr_lookups SET status = 'cancelled', finished_at = now(), updated_at = now()
		WHERE id = $1 AND finished_at IS NULL`, job); err != nil {
		a.log.Warn("spr audit cancel", "job", job, "err", err)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}

// POST /api/v1/spr/lookups/{id}/refresh
func (a *App) handleSprRefresh(w http.ResponseWriter, r *http.Request) {
	if !a.sprEnabled(w) {
		return
	}
	job := r.PathValue("id")
	if !jobIDRe.MatchString(job) {
		writeError(w, http.StatusBadRequest, "bad_request", "Permintaan tidak sah.")
		return
	}
	res, err := a.sprCall(r.Context(), "/sessions/"+job+"/refresh", map[string]string{})
	if err != nil {
		f := sprFailures["unavailable"]
		writeError(w, f.code, f.errCode, f.message)
		return
	}
	a.sprRespond(w, r, job, res, false)
}

func (a *App) sprRespond(w http.ResponseWriter, r *http.Request, job string, res sprResult, answered bool) {
	ctx := context.WithoutCancel(r.Context()) // the audit row is written even if the voter navigates away
	submitted := answered && res.Status != "invalid_answer" && res.Status != "captcha_expired" &&
		res.Status != "in_progress" && res.Status != "expired"

	if challengeStatuses[res.Status] {
		a.sprAudit(ctx, job, "awaiting_captcha", res.Status, submitted, false)
		writeJSON(w, http.StatusOK, sprChallenge{JobID: job, Status: res.Status, Captcha: res.Captcha,
			AttemptsLeft: res.AttemptsLeft, ExpiresIn: res.ExpiresIn, Message: res.Message})
		return
	}
	if res.Status == "found" {
		a.sprFound(w, r, job, res)
		return
	}
	f, ok := sprFailures[res.Status]
	if !ok {
		f = sprFailures["unexpected_layout"]
	}
	reason := res.Reason
	if res.Status == "unexpected_layout" {
		// Structure only (labels found, line count, path): enough to fix selectors, no voter data.
		diag, _ := json.Marshal(res.Diagnostics)
		a.log.Warn("spr unexpected layout", "job", job, "reason", res.Reason, "diagnostics", string(diag))
	}
	if res.Status != "in_progress" {
		a.sprAudit(ctx, job, res.Status, reason, submitted, true)
	}
	writeError(w, f.code, f.errCode, f.message)
}

func (a *App) sprFound(w http.ResponseWriter, r *http.Request, job string, res sprResult) {
	ctx := r.Context()
	if res.IC == "" || res.Voter == nil {
		// The worker already handed this result out once; a repeat must start over.
		writeError(w, http.StatusConflict, "already_done", "Semakan ini telah selesai. Sila mula semula.")
		return
	}
	var wantHash string
	if err := a.db.QueryRow(ctx, `SELECT ic_hash FROM spr_lookups WHERE id = $1`, job).Scan(&wantHash); err != nil ||
		!hmac.Equal([]byte(wantHash), []byte(a.icHash(res.IC))) {
		a.log.Error("spr result does not match its job", "job", job)
		a.sprAudit(context.WithoutCancel(ctx), job, "failed", "ic_mismatch", true, true)
		writeError(w, http.StatusBadGateway, "spr_changed", sprFailures["unexpected_layout"].message)
		return
	}
	info, err := parseIC(res.IC, time.Now().In(myt))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_ic", "Tarikh lahir dalam nombor kad pengenalan tidak sah.")
		return
	}
	if err := a.saveSprVoter(ctx, res.IC, info, *res.Voter, res.RawFields); err != nil {
		a.fail(w, "save spr voter", err)
		return
	}
	a.sprAudit(context.WithoutCancel(ctx), job, "completed", "", true, true)
	a.cacheDel(ctx, "voter:"+res.IC)

	voter, err := a.voterFromDB(ctx, res.IC)
	if err != nil {
		a.fail(w, "load spr voter", err)
		return
	}
	a.writeVoterResult(w, r, voter, false)
}

// storedSprVoter returns the voter's portal-confirmed record if we have one that is fresh enough
// (SPR_REUSE_MAX_AGE, 0 = any age), else nil.
func (a *App) storedSprVoter(ctx context.Context, ic string) (*Voter, error) {
	v, err := a.voterFromDB(ctx, ic)
	if errors.Is(err, errNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if v.Source != "spr" || v.VerifiedAt == nil {
		return nil, nil
	}
	if a.cfg.SPRReuseMaxAge > 0 && time.Since(*v.VerifiedAt) > a.cfg.SPRReuseMaxAge {
		return nil, nil
	}
	return &v, nil
}

// writeVoterResult sends what the voter flow needs next: record, candidates, questions, their
// previous answers and the token that lets them submit the survey.
func (a *App) writeVoterResult(w http.ResponseWriter, r *http.Request, voter Voter, reused bool) {
	ctx := r.Context()
	contests, contestsErr := a.voterContests(ctx, voter)
	qs, err := a.getQuestions(ctx)
	if err != nil {
		a.fail(w, "spr questions", err)
		return
	}
	prev, err := a.getPreviousResponse(ctx, voter.IC)
	if err != nil {
		a.fail(w, "spr previous response", err)
		return
	}
	writeJSON(w, http.StatusOK, lookupResponse{Voter: voter, Contests: contests, ContestsError: contestsErr, Questions: qs,
		PreviousResponse: prev, VoterToken: a.voterToken(voter.IC, time.Now()), Reused: reused})
}

// sprLocalityCode keeps the portal's own locality code; when the portal shows none, a stable
// internal key derived from the names (it identifies the row, it is not shown as SPR data).
func sprLocalityCode(v sprVoter) string {
	if v.Lokaliti.Code != "" {
		return v.Lokaliti.Code
	}
	sum := sha1.Sum([]byte(strings.Join([]string{v.State, v.Parlimen.Code, v.DUN.Code, v.DaerahMengundi.Code,
		v.DaerahMengundi.Name, v.Lokaliti.Name}, "|")))
	return "spr:" + hex.EncodeToString(sum[:8])
}

func validSprVoter(v sprVoter) bool {
	return v.FullName != "" && v.State != "" && len(v.Parlimen.Code) == 3 && normalizeIC(v.Parlimen.Code) == v.Parlimen.Code
}

func (a *App) saveSprVoter(ctx context.Context, ic string, info ICInfo, v sprVoter, raw []sprField) error {
	if !validSprVoter(v) {
		return errors.New("spr voter failed validation")
	}
	code := sprLocalityCode(v)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO localities (code, state, par_code, par_name, dun_code, dun_name, dm_code, dm_name, name)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, par_code = EXCLUDED.par_code, par_name = EXCLUDED.par_name,
			dun_code = EXCLUDED.dun_code, dun_name = EXCLUDED.dun_name, dm_code = EXCLUDED.dm_code,
			dm_name = EXCLUDED.dm_name, name = EXCLUDED.name`,
		code, v.State, v.Parlimen.Code, v.Parlimen.Name, v.DUN.Code, v.DUN.Name, v.DaerahMengundi.Code,
		v.DaerahMengundi.Name, v.Lokaliti.Name); err != nil {
		return err
	}
	if raw == nil {
		raw = []sprField{}
	}
	rawJSON, _ := json.Marshal(raw)
	if _, err := tx.Exec(ctx, `INSERT INTO voters (ic, full_name, dob, gender, locality_code, is_demo, source, verified_at,
			polling_centre, stream, voting_time, spr_fields)
		VALUES ($1, $2, $3, $4, $5, false, 'spr', now(), $6, $7, $8, $9)
		ON CONFLICT (ic) DO UPDATE SET full_name = EXCLUDED.full_name, dob = EXCLUDED.dob, gender = EXCLUDED.gender,
			locality_code = EXCLUDED.locality_code, is_demo = false, source = 'spr', verified_at = now(),
			polling_centre = EXCLUDED.polling_centre, stream = EXCLUDED.stream, voting_time = EXCLUDED.voting_time,
			spr_fields = EXCLUDED.spr_fields`,
		ic, v.FullName, info.DOB, info.Gender, code, v.PollingCentre, v.Stream, v.VotingTime, rawJSON); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ---------- admin ---------- */

type sprLookupRow struct {
	ID              string     `json:"id"`
	ICMasked        string     `json:"ic_masked"`
	Operator        string     `json:"operator"`
	Status          string     `json:"status"`
	Reason          *string    `json:"reason"`
	CaptchaAttempts int        `json:"captcha_attempts"`
	CreatedAt       time.Time  `json:"created_at"`
	FinishedAt      *time.Time `json:"finished_at"`
}

// GET /api/admin/spr: gate state, worker counters and the latest lookups (masked).
func (a *App) handleAdminSpr(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	phase, err := a.candidatePhase(ctx)
	if err != nil {
		a.fail(w, "admin spr phase", err)
		return
	}
	rows, err := a.db.Query(ctx, `SELECT id::text, ic_masked, operator, status, reason, captcha_attempts, created_at, finished_at
		FROM spr_lookups ORDER BY created_at DESC LIMIT 50`)
	if err != nil {
		a.fail(w, "admin spr lookups", err)
		return
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (sprLookupRow, error) {
		var l sprLookupRow
		err := r.Scan(&l.ID, &l.ICMasked, &l.Operator, &l.Status, &l.Reason, &l.CaptchaAttempts, &l.CreatedAt, &l.FinishedAt)
		return l, err
	})
	if err != nil {
		a.fail(w, "admin spr scan", err)
		return
	}
	counts := map[string]int{}
	crows, err := a.db.Query(ctx, `SELECT status, count(*) FROM spr_lookups WHERE created_at > now() - interval '24 hours' GROUP BY 1`)
	if err == nil {
		for crows.Next() {
			var s string
			var n int
			if crows.Scan(&s, &n) == nil {
				counts[s] = n
			}
		}
		crows.Close()
	}
	var worker any
	if a.cfg.VoterSource == "spr" {
		wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(wctx, http.MethodGet, a.cfg.SPRWorkerURL+"/stats", nil)
		req.Header.Set("X-Internal-Token", a.cfg.SPRInternalToken)
		if resp, err := sprHTTP.Do(req); err == nil {
			var m map[string]any
			if json.NewDecoder(resp.Body).Decode(&m) == nil {
				worker = m
			}
			resp.Body.Close()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"voter_source": a.cfg.VoterSource, "require_candidates": a.cfg.SPRRequireCandidates,
		"phase": phase, "worker": worker, "lookups": items, "counts_24h": counts,
	})
}

/* ---------- retention ---------- */

// purgeLoop enforces retention hourly.
func (a *App) purgeLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := a.purgeOnce(ctx); err != nil && ctx.Err() == nil {
			a.log.Warn("spr retention purge", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// purgeOnce deletes SPR voter rows nobody submitted a survey for (and their cached copies) once
// they are older than SPR_VOTER_RETENTION, and audit rows older than SPR_AUDIT_RETENTION.
func (a *App) purgeOnce(ctx context.Context) error {
	if a.cfg.SPRVoterRetention <= 0 { // 0 = keep every confirmed record (the default)
		_, err := a.db.Exec(ctx, `DELETE FROM spr_lookups WHERE created_at < now() - make_interval(secs => $1)`,
			a.cfg.SPRAuditRetention.Seconds())
		return err
	}
	rows, err := a.db.Query(ctx, `DELETE FROM voters v WHERE v.source = 'spr' AND v.verified_at < now() - make_interval(secs => $1)
			AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.ic = v.ic) RETURNING v.ic`, a.cfg.SPRVoterRetention.Seconds())
	if err != nil {
		return err
	}
	ics, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(ics) > 0 {
		keys := make([]string, len(ics))
		for i, ic := range ics {
			keys[i] = "voter:" + ic
		}
		a.cacheDel(ctx, keys...)
		a.log.Info("purged spr voters", "rows", len(ics))
	}
	_, err = a.db.Exec(ctx, `DELETE FROM spr_lookups WHERE created_at < now() - make_interval(secs => $1)`,
		a.cfg.SPRAuditRetention.Seconds())
	return err
}
