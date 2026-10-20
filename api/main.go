package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	Addr         string
	DatabaseURL  string
	RedisURL     string
	AdminAPIKey  string
	IPHashSalt   string
	DemoFallback bool
	CacheTTL     time.Duration
	DBMaxConns   int32

	ElectionDataURL string
	ElectionDataKey string

	// VOTER_SOURCE=spr: voters are confirmed on MySPR Semak (spr.go) instead of the demo register.
	VoterSource          string
	SPRWorkerURL         string
	SPRInternalToken     string
	SPRRequireCandidates bool          // lookups wait for the candidates phase to complete
	SPRVoterRetention    time.Duration // SPR voter rows without a survey response; 0 = keep forever
	SPRReuseMaxAge       time.Duration // reuse a stored SPR record instead of a new portal check; 0 = any age
	SPRAuditRetention    time.Duration
}

func envDuration(key string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(os.Getenv(key)); err == nil && d > 0 {
		return d
	}
	return def
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	maxConns, _ := strconv.Atoi(env("DB_MAX_CONNS", "40"))
	ttl, err := time.ParseDuration(env("CACHE_TTL", "10m"))
	if err != nil {
		ttl = 10 * time.Minute
	}
	source := env("VOTER_SOURCE", "demo")
	if source != "spr" {
		source = "demo"
	}
	return Config{
		Addr:        env("ADDR", ":8080"),
		DatabaseURL: env("DATABASE_URL", "postgres://ehandling:ehandling@localhost:5432/ehandling"),
		RedisURL:    os.Getenv("REDIS_URL"),
		AdminAPIKey: os.Getenv("ADMIN_API_KEY"),
		IPHashSalt:  env("IP_HASH_SALT", "change-me"),
		// Real lookups never fall back to invented voters.
		DemoFallback: source == "demo" && env("DEMO_FALLBACK", "true") == "true",
		CacheTTL:     ttl,
		DBMaxConns:   int32(maxConns),

		ElectionDataURL: env("ELECTIONDATA_URL", "https://api.electiondata.my/v1"),
		ElectionDataKey: os.Getenv("ELECTIONDATA_API_KEY"),

		VoterSource:          source,
		SPRWorkerURL:         strings.TrimRight(env("SPR_WORKER_URL", "http://spr:8090"), "/"),
		SPRInternalToken:     os.Getenv("SPR_INTERNAL_TOKEN"),
		SPRRequireCandidates: env("SPR_REQUIRE_CANDIDATE_PHASE", "true") == "true",
		SPRVoterRetention:    envDuration("SPR_VOTER_RETENTION", 0),
		SPRReuseMaxAge:       envDuration("SPR_REUSE_MAX_AGE", 0),
		SPRAuditRetention:    envDuration("SPR_AUDIT_RETENTION", 90*24*time.Hour),
	}
}

type App struct {
	cfg        Config
	db         *pgxpool.Pool
	rdb        *redis.Client // nil when REDIS_URL is unset; cache misses fall through to Postgres
	log        *slog.Logger
	localities []string      // locality codes, loaded once after migration (used by demo fallback)
	ed         *ElectionData // nil when ELECTIONDATA_API_KEY is unset
	photos     photoState
	gate       gateCache
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local /api/health endpoint and exit")
	flag.Parse()
	cfg := loadConfig()
	if *healthcheck {
		os.Exit(probe(cfg.Addr))
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(cfg, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(cfg Config, log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if cfg.AdminAPIKey == "" {
		return errors.New("ADMIN_API_KEY is required")
	}
	if cfg.VoterSource == "spr" && cfg.SPRInternalToken == "" {
		return errors.New("SPR_INTERNAL_TOKEN is required when VOTER_SOURCE=spr")
	}

	pool, err := connectDB(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := migrate(ctx, pool); err != nil {
		return err
	}

	app := &App{cfg: cfg, db: pool, log: log}
	if app.localities, err = loadLocalityCodes(ctx, pool); err != nil {
		return err
	}
	if cfg.RedisURL != "" {
		opt, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			return err
		}
		opt.PoolSize = 50
		app.rdb = redis.NewClient(opt)
		defer app.rdb.Close()
		if err := app.rdb.Ping(ctx).Err(); err != nil {
			log.Warn("redis unreachable at boot; serving from postgres until it recovers", "err", err)
		}
	}

	app.ed = newElectionData(app)
	go app.watchPhotos(ctx)
	go app.purgeLoop(ctx)
	if app.ed == nil {
		log.Warn("ELECTIONDATA_API_KEY not set; candidate lists are disabled")
	} else {
		// Warm the reference lists so the first voter doesn't pay for the upstream round trips.
		go func() {
			if _, err := app.ed.getRef(ctx); err != nil {
				log.Warn("electiondata warm-up failed; will retry on demand", "err", err)
			}
		}()
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      60 * time.Second, // CSV export streams
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Info("listening", "addr", cfg.Addr, "voter_source", cfg.VoterSource, "demo_fallback", cfg.DemoFallback,
		"cache", app.rdb != nil)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func connectDB(ctx context.Context, cfg Config, log *slog.Logger) (*pgxpool.Pool, error) {
	pcfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	pcfg.MaxConns = cfg.DBMaxConns
	pcfg.MinConns = 4
	pcfg.MaxConnIdleTime = 5 * time.Minute

	var lastErr error
	for attempt := 1; attempt <= 30; attempt++ {
		pool, err := pgxpool.NewWithConfig(ctx, pcfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		log.Warn("waiting for postgres", "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, lastErr
}

func probe(addr string) int {
	port := addr
	if len(port) > 0 && port[0] == ':' {
		port = "127.0.0.1" + port
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + port + "/api/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
