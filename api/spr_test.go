package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Synthetic IC numbers only.
const testIC = "010101010101"

func testApp(source string) *App {
	return &App{
		cfg: Config{AdminAPIKey: "admin", IPHashSalt: "salt", VoterSource: source, SPRInternalToken: "tok",
			SPRRequireCandidates: true},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestVoterToken(t *testing.T) {
	a := testApp("spr")
	now := time.Now()
	tok := a.voterToken(testIC, now)
	if !a.checkVoterToken(tok, testIC, now) {
		t.Fatal("fresh token rejected")
	}
	if a.checkVoterToken(tok, "020202020202", now) {
		t.Fatal("token accepted for another IC")
	}
	if a.checkVoterToken(tok, testIC, now.Add(voterTokenTTL+time.Second)) {
		t.Fatal("expired token accepted")
	}
	exp, sig, _ := strings.Cut(tok, ".")
	if a.checkVoterToken(exp+"."+strings.Repeat("0", len(sig)), testIC, now) {
		t.Fatal("forged signature accepted")
	}
	far := a.voterToken(testIC, now.Add(48*time.Hour))
	if a.checkVoterToken(far, testIC, now) {
		t.Fatal("token with an expiry beyond the TTL accepted")
	}
	other := testApp("spr")
	other.cfg.IPHashSalt = "different"
	if other.checkVoterToken(tok, testIC, now) {
		t.Fatal("token valid under a different key")
	}
}

func TestICHashAndMask(t *testing.T) {
	a := testApp("spr")
	h := a.icHash(testIC)
	if strings.Contains(h, testIC) || len(h) != 64 || h != a.icHash(testIC) {
		t.Fatalf("bad hash %q", h)
	}
	if got := maskIC("990123125571"); got != "990123****71" {
		t.Fatalf("mask = %q", got)
	}
	if got := maskIC("123"); got != "***" {
		t.Fatalf("short mask = %q", got)
	}
}

func TestJobID(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := newJobID()
		if !jobIDRe.MatchString(id) || seen[id] {
			t.Fatalf("bad or repeated job id %q", id)
		}
		seen[id] = true
	}
}

func TestSprLocalityCode(t *testing.T) {
	v := sprVoter{State: "SABAH", Parlimen: Area{"173", "PUTATAN"}, Lokaliti: Area{"173/23/01/001", "KG A"}}
	if got := sprLocalityCode(v); got != "173/23/01/001" {
		t.Fatalf("portal code not kept: %q", got)
	}
	v.Lokaliti.Code = ""
	a, b := sprLocalityCode(v), sprLocalityCode(v)
	if a != b || !strings.HasPrefix(a, "spr:") {
		t.Fatalf("internal key not stable: %q %q", a, b)
	}
	v.Lokaliti.Name = "KG B"
	if sprLocalityCode(v) == a {
		t.Fatal("different localities share a key")
	}
}

func TestValidSprVoter(t *testing.T) {
	ok := sprVoter{FullName: "A", State: "SABAH", Parlimen: Area{"173", "PUTATAN"}}
	if !validSprVoter(ok) {
		t.Fatal("valid voter rejected")
	}
	for _, bad := range []sprVoter{
		{State: "SABAH", Parlimen: Area{"173", "X"}},
		{FullName: "A", Parlimen: Area{"173", "X"}},
		{FullName: "A", State: "SABAH", Parlimen: Area{"17", "X"}},
		{FullName: "A", State: "SABAH", Parlimen: Area{"P17", "X"}},
	} {
		if validSprVoter(bad) {
			t.Fatalf("invalid voter accepted: %+v", bad)
		}
	}
}

func TestPhaseOutcome(t *testing.T) {
	if s := phaseOutcome(&phaseInfo{Approved: 3, Review: 1}, 0); s != "completed" {
		t.Fatal(s)
	}
	if s := phaseOutcome(&phaseInfo{Approved: 3, NotFound: 1}, 0); s != "completed_with_warnings" {
		t.Fatal(s)
	}
	if s := phaseOutcome(&phaseInfo{Approved: 3}, 1); s != "completed_with_warnings" {
		t.Fatal(s)
	}
	for status, want := range map[string]bool{"completed": true, "completed_with_warnings": true, "processing": false,
		"failed": false, "pending": false} {
		if phaseReady(status) != want {
			t.Fatalf("phaseReady(%s)", status)
		}
	}
}

func post(t *testing.T, h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// These paths are decided before any database or worker call.
func TestSprGuards(t *testing.T) {
	spr := testApp("spr")
	demo := testApp("demo")

	if rec := post(t, demo.handleSprStart, "/api/v1/spr/lookups", `{"ic":"`+testIC+`"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("demo mode start = %d", rec.Code)
	}
	if rec := post(t, spr.handleLookup, "/api/v1/voters/lookup", `{"ic":"`+testIC+`"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("plain lookup in spr mode = %d", rec.Code)
	}
	for _, ic := range []string{"", "12345", "991399125571", "abcdefabcdef"} {
		if rec := post(t, spr.handleSprStart, "/api/v1/spr/lookups", `{"ic":"`+ic+`"}`); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("start with ic %q = %d", ic, rec.Code)
		}
	}
	under18 := time.Now().In(myt).AddDate(-10, 0, 0).Format("060102") + "121234"
	if rec := post(t, spr.handleSprStart, "/api/v1/spr/lookups", `{"ic":"`+under18+`"}`); rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), "not_eligible") {
		t.Fatalf("under-18 start = %d %s", rec.Code, rec.Body)
	}
	// Survey submission needs the token from a completed SPR lookup.
	body := `{"ic":"` + testIC + `","answers":{"q1":"A","q2":"B"}}`
	if rec := post(t, spr.handleSubmit, "/api/v1/responses", body); rec.Code != http.StatusForbidden {
		t.Fatalf("submit without token = %d", rec.Code)
	}
	forged := `{"ic":"` + testIC + `","answers":{"q1":"A"},"voter_token":"9999999999.abc"}`
	if rec := post(t, spr.handleSubmit, "/api/v1/responses", forged); rec.Code != http.StatusForbidden {
		t.Fatalf("submit with forged token = %d", rec.Code)
	}
}

func TestSprAnswerValidation(t *testing.T) {
	a := testApp("spr")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/spr/lookups/{id}/captcha", a.handleSprAnswer)
	do := func(path, body string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		return rec.Code
	}
	if c := do("/api/v1/spr/lookups/not-a-job/captcha", `{"answer":"1234"}`); c != http.StatusBadRequest {
		t.Fatalf("bad job id = %d", c)
	}
	job := newJobID()
	for _, ans := range []string{"", "12", "12a4", "1234567", "12 34"} {
		if c := do("/api/v1/spr/lookups/"+job+"/captcha", `{"answer":"`+ans+`"}`); c != http.StatusUnprocessableEntity {
			t.Fatalf("answer %q = %d", ans, c)
		}
	}
}
