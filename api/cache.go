package main

import (
	"context"
	"encoding/json"
	"time"
)

// Cache failures are never fatal: a Redis outage degrades to direct Postgres reads.

func cacheGet[T any](ctx context.Context, a *App, key string) (T, bool) {
	var zero T
	if a.rdb == nil {
		return zero, false
	}
	raw, err := a.rdb.Get(ctx, key).Bytes()
	if err != nil {
		return zero, false
	}
	var v T
	if json.Unmarshal(raw, &v) != nil {
		return zero, false
	}
	return v, true
}

func (a *App) cacheSet(ctx context.Context, key string, v any, ttl time.Duration) {
	if a.rdb == nil {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = a.rdb.Set(ctx, key, raw, ttl).Err()
}

func (a *App) cacheDel(ctx context.Context, keys ...string) {
	if a.rdb == nil {
		return
	}
	_ = a.rdb.Del(ctx, keys...).Err()
}
