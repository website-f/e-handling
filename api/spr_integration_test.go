package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// End-to-end SPR flow against a real Postgres and a fake spr worker. Runs only when
// TEST_DATABASE_URL points at a disposable database, e.g.
//
//	docker run -d --rm --name eh-test-db -e POSTGRES_PASSWORD=t -p 127.0.0.1:8809:5432 postgres:17-alpine
//	TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:8809/postgres go test ./...
func TestSprFlowIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DELETE FROM responses WHERE ic = '` + testIC + `'`, `DELETE FROM voters WHERE ic = '` + testIC + `'`,
		`DELETE FROM spr_lookups`, `DELETE FROM pipeline_phases`, `DELETE FROM candidate_photos WHERE uid LIKE 'TST%'`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	// Fake worker: awaiting_captcha on start, wrong captcha first, then a found record.
	var submits atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Internal-Token") != "tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/sessions":
			if body["ic"] != testIC {
				t.Errorf("worker got ic %q, want the submitted one", body["ic"])
			}
			_, _ = io.WriteString(w, `{"status":"awaiting_captcha","captcha":"data:image/png;base64,AA==","attempts_left":3,"expires_in":240}`)
		case strings.HasSuffix(r.URL.Path, "/captcha"):
			if submits.Add(1) == 1 {
				_, _ = io.WriteString(w, `{"status":"captcha_wrong","captcha":"data:image/png;base64,AB==","attempts_left":2,"expires_in":200}`)
				return
			}
			_, _ = io.WriteString(w, `{"status":"found","ic":"`+testIC+`","voter":{"full_name":"PEMILIH UJIAN","state":"SABAH",
				"parlimen":{"code":"173","name":"PUTATAN"},"dun":{"code":"173/23","name":"PETAGAS"},
				"daerah_mengundi":{"code":"173/23/01","name":"CONTOH"},"lokaliti":{"code":"","name":"KG UJIAN"},
				"polling_centre":"SK UJIAN","stream":"2","voting_time":""}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer worker.Close()

	a := &App{
		cfg: Config{AdminAPIKey: "admin", IPHashSalt: "salt", VoterSource: "spr", SPRInternalToken: "tok",
			SPRWorkerURL: worker.URL, SPRRequireCandidates: true, CacheTTL: time.Minute},
		db:  pool,
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	h := a.routes()
	call := func(method, path, body string) (int, map[string]any) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	// 1. Gate: no candidates phase yet -> closed.
	if code, out := call("POST", "/api/v1/spr/lookups", `{"ic":"`+testIC+`"}`); code != 503 || out["error"] != "candidates_not_ready" {
		t.Fatalf("gate closed: %d %v", code, out)
	}
	// A phase with a candidate still queued keeps it closed.
	var phase int64
	if err := pool.QueryRow(ctx, `INSERT INTO pipeline_phases (name, status, total) VALUES ('candidates', 'processing', 2) RETURNING id`).Scan(&phase); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO candidate_photos (uid, name, status, phase_id) VALUES
		('TST1', 'A', 'approved', $1), ('TST2', 'B', 'queued', $1)`, phase); err != nil {
		t.Fatal(err)
	}
	if code, _ := call("POST", "/api/v1/spr/lookups", `{"ic":"`+testIC+`"}`); code != 503 {
		t.Fatalf("gate with queued candidate = %d", code)
	}
	// Last candidate finishes without a photo -> completed_with_warnings, gate opens.
	if _, err := pool.Exec(ctx, `UPDATE candidate_photos SET status = 'not_found' WHERE uid = 'TST2'`); err != nil {
		t.Fatal(err)
	}

	// 2. Start -> CAPTCHA challenge for the voter.
	code, out := call("POST", "/api/v1/spr/lookups", `{"ic":"`+testIC[:6]+`-`+testIC[6:8]+`-`+testIC[8:]+`"}`)
	if code != 200 || out["status"] != "awaiting_captcha" || !strings.HasPrefix(out["captcha"].(string), "data:image/png") {
		t.Fatalf("start: %d %v", code, out)
	}
	job := out["job_id"].(string)
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM pipeline_phases WHERE id = $1`, phase).Scan(&status); err != nil || status != "completed_with_warnings" {
		t.Fatalf("phase status %q %v", status, err)
	}

	// 3. Wrong CAPTCHA -> new image, still the same job.
	code, out = call("POST", "/api/v1/spr/lookups/"+job+"/captcha", `{"answer":"1111"}`)
	if code != 200 || out["status"] != "captcha_wrong" || out["job_id"] != job {
		t.Fatalf("wrong captcha: %d %v", code, out)
	}

	// 4. Right CAPTCHA -> voter record, contests error (no ElectionData in tests), token.
	code, out = call("POST", "/api/v1/spr/lookups/"+job+"/captcha", `{"answer":"2222"}`)
	if code != 200 {
		t.Fatalf("found: %d %v", code, out)
	}
	voter := out["voter"].(map[string]any)
	if voter["full_name"] != "PEMILIH UJIAN" || voter["source"] != "spr" || voter["gender"] != "LELAKI" ||
		voter["polling_centre"] != "SK UJIAN" {
		t.Fatalf("voter: %v", voter)
	}
	// The portal showed no locality code: none is invented, and the internal row key stays hidden.
	if lok := voter["lokaliti"].(map[string]any); lok["code"] != "" || lok["name"] != "KG UJIAN" {
		t.Fatalf("lokaliti: %v", lok)
	}
	token, _ := out["voter_token"].(string)
	if token == "" {
		t.Fatal("no voter token")
	}

	// 5. Audit row: masked IC and keyed hash only, two CAPTCHA attempts, completed.
	var masked, hash, auditStatus string
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT ic_masked, ic_hash, status, captcha_attempts FROM spr_lookups WHERE id = $1`, job).
		Scan(&masked, &hash, &auditStatus, &attempts); err != nil {
		t.Fatal(err)
	}
	if masked != "010101****01" || strings.Contains(hash, testIC) || auditStatus != "completed" || attempts != 2 {
		t.Fatalf("audit: %s %s %s %d", masked, hash, auditStatus, attempts)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM spr_lookups WHERE row_to_json(spr_lookups)::text LIKE '%`+testIC+`%'`).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("raw IC in audit table: %d %v", leaked, err)
	}

	// 6. Survey: rejected without the token, accepted with it.
	if code, _ := call("POST", "/api/v1/responses", `{"ic":"`+testIC+`","answers":{"q1":"A","q2":"A"}}`); code != 403 {
		t.Fatalf("submit without token = %d", code)
	}
	code, out = call("POST", "/api/v1/responses", `{"ic":"`+testIC+`","answers":{"q1":"A","q2":"A"},"voter_token":"`+token+`"}`)
	if code != 201 {
		t.Fatalf("submit with token = %d %v", code, out)
	}

	// 7. Retention: an unsubmitted SPR voter older than the window is purged, a submitted one kept.
	if _, err := pool.Exec(ctx, `UPDATE voters SET verified_at = now() - interval '2 days' WHERE ic = $1`, testIC); err != nil {
		t.Fatal(err)
	}
	a.cfg.SPRVoterRetention, a.cfg.SPRAuditRetention = 24*time.Hour, 90*24*time.Hour
	if err := a.purgeOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM voters WHERE ic = $1`, testIC).Scan(&n)
	if n != 1 {
		t.Fatal("voter with a survey response was purged")
	}
	_, _ = pool.Exec(ctx, `DELETE FROM responses WHERE ic = $1`, testIC)
	if err := a.purgeOnce(ctx); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM voters WHERE ic = $1`, testIC).Scan(&n)
	if n != 0 {
		t.Fatal("stale SPR voter was not purged")
	}
}
