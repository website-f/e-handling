package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

// ElectionData.MY Open API (https://electiondata.my/openapi, CC0). Called server-side only so the
// key never reaches the browser.
//
// Caching, tuned so a traffic spike never fans out to the upstream:
//   - reference lists (seats, parties, candidate records) live in process memory for 24h and are
//     refreshed in the background; a failed refresh keeps serving the previous copy
//   - each seat's latest contest is cached in Redis for 6h, plus a 7-day stale copy used when
//     the upstream is down
//   - singleflight collapses concurrent misses for the same key into one upstream call

const (
	edRefTTL       = 24 * time.Hour
	edContestTTL   = 6 * time.Hour
	edStaleTTL     = 7 * 24 * time.Hour
	edHistoryTTL   = 24 * time.Hour
	edFetchTimeout = 10 * time.Second
)

var errEDUnavailable = errors.New("electiondata unavailable")

type edClient struct {
	base string
	key  string
	http *http.Client
}

func (c *edClient) get(ctx context.Context, path string, q url.Values, out any) error {
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("electiondata %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

/* ---------- reference data (in-process) ---------- */

type edSeat struct {
	Seat string // "P.173 Putatan, Sabah"
	Slug string
}

type edRecord struct {
	UID      string `json:"uid"`
	Contests int    `json:"contests"`
	Won      int    `json:"won"`
	Lost     int    `json:"lost"`
}

type edRef struct {
	loadedAt time.Time
	seats    map[string]edSeat   // "parlimen|173|sabah"
	parties  map[string]string   // party/coalition uid -> Malay name
	records  map[string]edRecord // candidate name -> record, only for names that are unique
}

func seatKey(level string, number int, state string) string {
	return level + "|" + strconv.Itoa(number) + "|" + strings.ToLower(strings.TrimSpace(state))
}

type ElectionData struct {
	client  *edClient
	app     *App
	ref     atomic.Pointer[edRef]
	group   singleflight.Group
	refresh sync.Mutex
}

func newElectionData(a *App) *ElectionData {
	if a.cfg.ElectionDataKey == "" {
		return nil
	}
	return &ElectionData{
		app: a,
		client: &edClient{
			base: strings.TrimRight(a.cfg.ElectionDataURL, "/"),
			key:  a.cfg.ElectionDataKey,
			http: &http.Client{Timeout: edFetchTimeout},
		},
	}
}

func (e *ElectionData) loadRef(ctx context.Context) (*edRef, error) {
	var (
		seats struct {
			Seats []struct {
				Seat string `json:"seat"`
				Slug string `json:"slug"`
				Type string `json:"type"`
			} `json:"seats"`
		}
		parties struct {
			Data []struct {
				UID    string `json:"uid"`
				NameBM string `json:"name_bm"`
			} `json:"data"`
		}
		cands struct {
			Candidates []struct {
				UID  string `json:"uid"`
				Name string `json:"name"`
				C    int    `json:"c"`
				W    int    `json:"w"`
				L    int    `json:"l"`
			} `json:"candidates"`
		}
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return e.client.get(gctx, "/seats/dropdown", nil, &seats) })
	g.Go(func() error { return e.client.get(gctx, "/parties/dropdown", nil, &parties) })
	g.Go(func() error { return e.client.get(gctx, "/candidates/dropdown", nil, &cands) })
	if err := g.Wait(); err != nil {
		return nil, err
	}

	ref := &edRef{
		loadedAt: time.Now(),
		seats:    make(map[string]edSeat, len(seats.Seats)),
		parties:  make(map[string]string, len(parties.Data)),
		records:  make(map[string]edRecord, len(cands.Candidates)),
	}
	for _, s := range seats.Seats {
		// "P.173 Putatan, Sabah" -> prefix "P.173", state "Sabah"
		comma := strings.LastIndex(s.Seat, ", ")
		sp := strings.IndexByte(s.Seat, ' ')
		if comma < 0 || sp < 3 {
			continue
		}
		n, err := strconv.Atoi(s.Seat[2:sp])
		if err != nil {
			continue
		}
		ref.seats[seatKey(s.Type, n, s.Seat[comma+2:])] = edSeat{Seat: s.Seat, Slug: s.Slug}
	}
	for _, p := range parties.Data {
		ref.parties[p.UID] = p.NameBM
	}
	dupes := map[string]bool{}
	for _, c := range cands.Candidates {
		if _, seen := ref.records[c.Name]; seen {
			dupes[c.Name] = true
			continue
		}
		ref.records[c.Name] = edRecord{UID: c.UID, Contests: c.C, Won: c.W, Lost: c.L}
	}
	for name := range dupes {
		delete(ref.records, name) // two people share this name; never guess which record is theirs
	}
	return ref, nil
}

// getRef returns the reference data, loading it on first use. Once loaded, an expired copy is
// served immediately while a single background refresh runs.
func (e *ElectionData) getRef(ctx context.Context) (*edRef, error) {
	cur := e.ref.Load()
	if cur != nil {
		if time.Since(cur.loadedAt) > edRefTTL && e.refresh.TryLock() {
			go func() {
				defer e.refresh.Unlock()
				bg, cancel := context.WithTimeout(context.Background(), 3*edFetchTimeout)
				defer cancel()
				if ref, err := e.loadRef(bg); err == nil {
					e.ref.Store(ref)
				} else {
					e.app.log.Warn("electiondata refresh failed; keeping previous reference data", "err", err)
				}
			}()
		}
		return cur, nil
	}
	v, err, _ := e.group.Do("ref", func() (any, error) {
		bg, cancel := context.WithTimeout(context.Background(), 3*edFetchTimeout)
		defer cancel()
		ref, err := e.loadRef(bg)
		if err == nil {
			e.ref.Store(ref)
		}
		return ref, err
	})
	if err != nil {
		return nil, err
	}
	return v.(*edRef), nil
}

/* ---------- contests ---------- */

type BallotEntry struct {
	Name          string    `json:"name"`
	Party         string    `json:"party"`
	PartyName     string    `json:"party_name"`
	Coalition     string    `json:"coalition"`
	CoalitionName string    `json:"coalition_name"`
	Votes         int       `json:"votes"`
	VotesPerc     *float64  `json:"votes_perc"`
	Result        string    `json:"result"`
	Record        *edRecord `json:"record"`
	PhotoURL      string    `json:"photo_url,omitempty"`  // approved portrait, filled per request
	PhotoPage     string    `json:"photo_page,omitempty"` // where the portrait came from
}

type Contest struct {
	Level        string        `json:"level"` // parlimen | dun
	Seat         string        `json:"seat"`  // "P.173 Putatan"
	State        string        `json:"state"`
	Election     string        `json:"election"` // "GE-15", "SE-15"
	Date         string        `json:"date"`
	VotersTotal  int           `json:"voters_total"`
	Turnout      int           `json:"voter_turnout"`
	TurnoutPerc  *float64      `json:"voter_turnout_perc"`
	Majority     int           `json:"majority"`
	MajorityPerc *float64      `json:"majority_perc"`
	Ballot       []BallotEntry `json:"ballot"`
}

// cachedFetch: fresh Redis copy -> one shared upstream fetch -> stale Redis copy.
func cachedFetch[T any](ctx context.Context, e *ElectionData, key string, ttl time.Duration, fetch func(context.Context) (T, error)) (T, error) {
	a := e.app
	if v, ok := cacheGet[T](ctx, a, key); ok {
		return v, nil
	}
	v, err, _ := e.group.Do(key, func() (any, error) {
		bg, cancel := context.WithTimeout(context.Background(), 2*edFetchTimeout)
		defer cancel()
		v, err := fetch(bg)
		if err == nil {
			a.cacheSet(bg, key, v, ttl)
			a.cacheSet(bg, "stale:"+key, v, edStaleTTL)
		}
		return v, err
	})
	if err == nil {
		return v.(T), nil
	}
	if stale, ok := cacheGet[T](ctx, a, "stale:"+key); ok {
		a.log.Warn("electiondata fetch failed; serving stale copy", "key", key, "err", err)
		return stale, nil
	}
	var zero T
	return zero, err
}

func (e *ElectionData) contestFor(ctx context.Context, level string, number int, state string) (*Contest, error) {
	ref, err := e.getRef(ctx)
	if err != nil {
		return nil, err
	}
	seat, ok := ref.seats[seatKey(level, number, state)]
	if !ok {
		return nil, errNotFound
	}
	c, err := cachedFetch(ctx, e, "ed:contest:"+seat.Slug, edContestTTL, func(ctx context.Context) (Contest, error) {
		var hist struct {
			Results []struct {
				ElectionName string `json:"election_name"`
				Seat         string `json:"seat"`
				State        string `json:"state"`
				Date         string `json:"date"`
			} `json:"results"`
		}
		if err := e.client.get(ctx, "/seats/results", url.Values{"slug": {seat.Slug}}, &hist); err != nil {
			return Contest{}, err
		}
		if len(hist.Results) == 0 {
			return Contest{}, errNotFound
		}
		latest := hist.Results[0] // most recent first

		var res struct {
			Ballot []struct {
				Name      string   `json:"name"`
				Party     string   `json:"party"`
				PartyUID  string   `json:"party_uid"`
				Coalition string   `json:"coalition"`
				CoalUID   any      `json:"coalition_uid"` // documented as number, served as string
				Votes     int      `json:"votes"`
				VotesPerc *float64 `json:"votes_perc"`
				Result    string   `json:"result"`
			} `json:"ballot"`
			Stats []struct {
				VotersTotal  int      `json:"voters_total"`
				Turnout      int      `json:"voter_turnout"`
				TurnoutPerc  *float64 `json:"voter_turnout_perc"`
				Majority     int      `json:"majority"`
				MajorityPerc *float64 `json:"majority_perc"`
			} `json:"stats"`
		}
		q := url.Values{"seat": {latest.Seat}, "state": {latest.State}, "date": {latest.Date}}
		if err := e.client.get(ctx, "/results", q, &res); err != nil {
			return Contest{}, err
		}

		out := Contest{Level: level, Seat: latest.Seat, State: latest.State, Election: latest.ElectionName, Date: latest.Date}
		if len(res.Stats) > 0 {
			s := res.Stats[0]
			out.VotersTotal, out.Turnout, out.TurnoutPerc, out.Majority, out.MajorityPerc =
				s.VotersTotal, s.Turnout, s.TurnoutPerc, s.Majority, s.MajorityPerc
		}
		for _, b := range res.Ballot {
			entry := BallotEntry{
				Name: b.Name, Party: b.Party, PartyName: ref.parties[b.PartyUID],
				Votes: b.Votes, VotesPerc: b.VotesPerc, Result: b.Result,
			}
			if b.Coalition != "ALONE" {
				entry.Coalition = b.Coalition
				if uid, ok := b.CoalUID.(string); ok {
					entry.CoalitionName = ref.parties[uid]
				}
			}
			if rec, ok := ref.records[b.Name]; ok {
				entry.Record = &rec
			}
			out.Ballot = append(out.Ballot, entry)
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// contestsForVoter returns the parliament contest first, then the state seat (if any).
// Partial results are returned when only one of the two could be loaded.
func (e *ElectionData) contestsForVoter(ctx context.Context, v Voter) ([]Contest, error) {
	par, _ := strconv.Atoi(v.Parlimen.Code)
	dun := 0
	if i := strings.LastIndexByte(v.DUN.Code, '/'); i >= 0 {
		dun, _ = strconv.Atoi(v.DUN.Code[i+1:])
	}
	return e.contests(ctx, par, dun, v.State)
}

func (e *ElectionData) contests(ctx context.Context, par, dun int, state string) ([]Contest, error) {
	type slot struct {
		c   *Contest
		err error
	}
	var pSlot, dSlot slot
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); pSlot.c, pSlot.err = e.contestFor(ctx, "parlimen", par, state) }()
	if dun > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); dSlot.c, dSlot.err = e.contestFor(ctx, "dun", dun, state) }()
	}
	wg.Wait()

	var out []Contest
	for _, s := range []slot{pSlot, dSlot} {
		if s.c != nil {
			out = append(out, *s.c)
		}
	}
	if len(out) == 0 {
		if pSlot.err != nil && !errors.Is(pSlot.err, errNotFound) {
			return nil, errEDUnavailable
		}
		return nil, errNotFound
	}
	return out, nil
}

/* ---------- candidate history ---------- */

type HistoryEntry struct {
	Election  string   `json:"election"`
	Type      string   `json:"type"`
	Date      string   `json:"date"`
	Seat      string   `json:"seat"`
	State     string   `json:"state"`
	Party     string   `json:"party"`
	Coalition string   `json:"coalition"`
	Votes     int      `json:"votes"`
	VotesPerc *float64 `json:"votes_perc"`
	Result    string   `json:"result"`
}

func (e *ElectionData) history(ctx context.Context, uid string) ([]HistoryEntry, error) {
	return cachedFetch(ctx, e, "ed:history:"+uid, edHistoryTTL, func(ctx context.Context) ([]HistoryEntry, error) {
		// Docs say a bare array; the live API wraps it as {"results": [...]}.
		var raw struct {
			Results []struct {
				ElectionName string   `json:"election_name"`
				Type         string   `json:"type"`
				Date         string   `json:"date"`
				Seat         string   `json:"seat"`
				State        string   `json:"state"`
				Party        string   `json:"party"`
				Coalition    string   `json:"coalition"`
				Votes        int      `json:"votes"`
				VotesPerc    *float64 `json:"votes_perc"`
				Result       string   `json:"result"`
			} `json:"results"`
		}
		if err := e.client.get(ctx, "/candidates", url.Values{"uid": {uid}}, &raw); err != nil {
			return nil, err
		}
		out := make([]HistoryEntry, 0, len(raw.Results))
		for _, r := range raw.Results {
			coal := r.Coalition
			if coal == "ALONE" {
				coal = ""
			}
			out = append(out, HistoryEntry{
				Election: r.ElectionName, Type: r.Type, Date: r.Date, Seat: r.Seat, State: r.State,
				Party: r.Party, Coalition: coal, Votes: r.Votes, VotesPerc: r.VotesPerc, Result: r.Result,
			})
		}
		return out, nil
	})
}
