package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed sql/schema.sql
var schemaSQL string

//go:embed sql/seed.sql
var seedSQL string

// migrate applies schema + seed. The advisory lock keeps concurrent replicas from racing at boot.
func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(727001)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, schemaSQL); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, seedSQL); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func loadLocalityCodes(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, "SELECT code FROM localities ORDER BY code")
	if err != nil {
		return nil, err
	}
	codes, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err == nil && len(codes) == 0 {
		err = errors.New("no localities seeded")
	}
	return codes, err
}

type Area struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type Voter struct {
	IC             string `json:"ic"`
	FullName       string `json:"full_name"`
	DOB            string `json:"dob"`
	Gender         string `json:"gender"`
	State          string `json:"state"`
	Parlimen       Area   `json:"parlimen"`
	DUN            Area   `json:"dun"`
	DaerahMengundi Area   `json:"daerah_mengundi"`
	Lokaliti       Area   `json:"lokaliti"`
	IsDemo         bool   `json:"is_demo"`
}

type Option struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type Question struct {
	ID      string   `json:"id"`
	Prompt  string   `json:"prompt"`
	Options []Option `json:"options"`
}

type PreviousResponse struct {
	Answers   map[string]string `json:"answers"`
	UpdatedAt time.Time         `json:"updated_at"`
}

const voterColumns = `v.ic, v.full_name, v.dob, v.gender, v.is_demo, l.state,
	l.par_code, l.par_name, l.dun_code, l.dun_name, l.dm_code, l.dm_name, l.code, l.name`

func voterScanTargets(v *Voter, dob *time.Time) []any {
	return []any{&v.IC, &v.FullName, dob, &v.Gender, &v.IsDemo, &v.State,
		&v.Parlimen.Code, &v.Parlimen.Name, &v.DUN.Code, &v.DUN.Name,
		&v.DaerahMengundi.Code, &v.DaerahMengundi.Name, &v.Lokaliti.Code, &v.Lokaliti.Name}
}

var errNotFound = errors.New("not found")

func (a *App) voterFromDB(ctx context.Context, ic string) (Voter, error) {
	var v Voter
	var dob time.Time
	err := a.db.QueryRow(ctx, `SELECT `+voterColumns+`
		FROM voters v JOIN localities l ON l.code = v.locality_code WHERE v.ic = $1`, ic).
		Scan(voterScanTargets(&v, &dob)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, errNotFound
	}
	v.DOB = dob.Format("2006-01-02")
	return v, err
}

// getVoter is the hot path: Redis first, then Postgres, then (optionally) a generated demo voter.
func (a *App) getVoter(ctx context.Context, ic string, info ICInfo) (Voter, error) {
	key := "voter:" + ic
	if v, ok := cacheGet[Voter](ctx, a, key); ok {
		return v, nil
	}
	v, err := a.voterFromDB(ctx, ic)
	if errors.Is(err, errNotFound) && a.cfg.DemoFallback {
		v, err = a.createDemoVoter(ctx, ic, info)
	}
	if err != nil {
		return v, err
	}
	a.cacheSet(ctx, key, v, a.cfg.CacheTTL)
	return v, nil
}

func (a *App) getQuestions(ctx context.Context) ([]Question, error) {
	const key = "survey:questions"
	if q, ok := cacheGet[[]Question](ctx, a, key); ok {
		return q, nil
	}
	rows, err := a.db.Query(ctx, `SELECT id, prompt, options FROM survey_questions
		WHERE active ORDER BY position`)
	if err != nil {
		return nil, err
	}
	qs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Question, error) {
		var q Question
		var raw []byte
		if err := r.Scan(&q.ID, &q.Prompt, &raw); err != nil {
			return q, err
		}
		return q, json.Unmarshal(raw, &q.Options)
	})
	if err != nil {
		return nil, err
	}
	a.cacheSet(ctx, key, qs, a.cfg.CacheTTL)
	return qs, nil
}

func (a *App) getPreviousResponse(ctx context.Context, ic string) (*PreviousResponse, error) {
	var p PreviousResponse
	err := a.db.QueryRow(ctx, `SELECT answers, updated_at FROM responses WHERE ic = $1`, ic).
		Scan(&p.Answers, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
