package api

import (
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/quota"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func TestViewerProjectionInvalidNumbersPlansAndAbsoluteReset(t *testing.T) {
	now := time.Now().UTC()
	identity := entities.UsageIdentity{ID: 1, Type: "codex", AuthType: entities.UsageIdentityAuthTypeAuthFile}
	future := now.Add(time.Hour)
	item := quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &now, Quota: &quota.CheckResponse{
		Subscription: &quota.SubscriptionInfo{Provider: "codex", Plan: "private-email@example.com", TierName: "secret"},
		Quota:        []quota.QuotaRow{{Key: "row", Label: "private-label", Metric: "secret-token", Used: new(math.NaN()), Remaining: new(math.Inf(1)), Limit: new(-1.0), RemainingFraction: new(math.NaN()), UsedPercent: new(math.Inf(-1)), ResetAt: future.Format(time.RFC3339Nano), ResetAfterSeconds: new(int64(0))}},
	}}
	account := buildViewerQuotaAccount(identity, item, quota.AutoRefreshSettings{}, now)
	if account.Subscription != nil || account.Rows[0].Used != nil || account.Rows[0].Remaining != nil || account.Rows[0].RemainingPercent != nil || account.Rows[0].UsedPercent != nil || account.Rows[0].Limit != nil {
		t.Fatal("invalid values must be unknown")
	}
	if account.Status != "cached" || account.Rows[0].ResetAt == nil || !account.Rows[0].ResetAt.Equal(future) {
		t.Fatal("absolute reset must take precedence over relative zero")
	}
	body, err := json.Marshal(account)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-label", "private-email", "secret-token", "secret"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
	item.RefreshedAt = new(time.Time{})
	item.Quota.Quota[0] = quota.QuotaRow{Key: "missing-observation", ResetAfterSeconds: new(int64(60))}
	account = buildViewerQuotaAccount(identity, item, quota.AutoRefreshSettings{}, now)
	if account.Status != "stale" || account.UpdatedAt != nil || account.Rows[0].ResetAt != nil {
		t.Fatal("zero observation must stay unknown and cannot anchor a reset")
	}
	for _, plan := range []struct{ provider, plan string }{{"Codex", "plus"}, {"Codex", "pro-5x"}, {"Claude", "max-20x"}, {"Claude", "team"}, {"Antigravity", "pro"}} {
		safe := safeViewerSubscription(plan.provider, &quota.SubscriptionInfo{Provider: strings.ToLower(plan.provider), Plan: plan.plan, TierID: "private-id", TierName: "private-tier"})
		if safe == nil || safe.Plan != plan.plan || strings.Contains(safe.Tier, "private") {
			t.Fatal("safe normalized plan lost")
		}
	}
	if safeViewerSubscription("Claude", &quota.SubscriptionInfo{Provider: "codex", Plan: "plus"}) != nil {
		t.Fatal("provider mismatch should be unknown")
	}
}

func TestViewerProjectionOmitsAmbiguousStockProviderValues(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(time.Hour).Format(time.RFC3339)
	for _, tc := range []struct {
		provider, key string
	}{
		{"gemini-cli", "bucket"},
		{"kimi", "limits.window"},
		{"kimi", "usages.limit_month_total"},
		{"claude", "extra_usage"},
	} {
		t.Run(tc.provider+"/"+tc.key, func(t *testing.T) {
			identity := entities.UsageIdentity{ID: 1, Type: tc.provider}
			item := quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &now, Quota: &quota.CheckResponse{Quota: []quota.QuotaRow{{Key: tc.key, Used: new(0.0), Limit: new(100.0), UsedPercent: new(25.0), ResetAt: reset}}}}
			if tc.provider != "claude" {
				item.Quota.Quota[0].Remaining = new(75.0)
				item.Quota.Quota[0].RemainingFraction = new(0.75)
			}
			account := buildViewerQuotaAccount(identity, item, quota.AutoRefreshSettings{}, now)
			row := account.Rows[0]
			if row.Used != nil || row.Limit != nil || row.Remaining != nil {
				t.Fatal("ambiguous or synthetic quantities must stay unknown")
			}
			if tc.provider == "claude" {
				if row.UsedPercent == nil || *row.UsedPercent != 25 || row.RemainingPercent == nil || *row.RemainingPercent != 75 {
					t.Fatal("upstream's optional Claude percentage was lost")
				}
			} else if row.UsedPercent != nil || row.RemainingPercent != nil {
				t.Fatal("unsupported provider percentages must stay unknown")
			}
			if row.ResetAt == nil || account.Status != "cached" {
				t.Fatal("safe reset and observation metadata was lost")
			}
			if item.Quota.Quota[0].Used == nil || item.Quota.Quota[0].Limit == nil {
				t.Fatal("viewer projection modified the shared cache")
			}
		})
	}
}

func TestViewerProjectionWindowDurationIsBoundedDisplayMetadata(t *testing.T) {
	now := time.Now().UTC()
	identity := entities.UsageIdentity{ID: 1, Type: "codex", AuthType: entities.UsageIdentityAuthTypeAuthFile}
	for _, seconds := range []int64{0, -1, 18000, 604800, 366 * 86400, 366*86400 + 1} {
		item := quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &now, Quota: &quota.CheckResponse{Quota: []quota.QuotaRow{{Key: "safe", Window: &quota.QuotaWindow{Seconds: &seconds, Unit: "secret-unit", Duration: new(42.0)}}}}}
		account := buildViewerQuotaAccount(identity, item, quota.AutoRefreshSettings{}, now)
		valid := seconds > 0 && seconds <= 366*86400
		if (account.Rows[0].WindowSeconds != nil) != valid {
			t.Fatalf("duration presence for %d", seconds)
		}
		if valid && *account.Rows[0].WindowSeconds != seconds {
			t.Fatal("normalized duration changed")
		}
		body, err := json.Marshal(account)
		if err != nil || strings.Contains(string(body), "secret-unit") || strings.Contains(string(body), "duration") {
			t.Fatal("raw window metadata leaked")
		}
		item.Status = quota.RefreshTaskStatusFailed
		if failed := buildViewerQuotaAccount(identity, item, quota.AutoRefreshSettings{}, now); len(failed.Rows) != 0 {
			t.Fatal("failed refresh exposed an older window")
		}
	}
}
