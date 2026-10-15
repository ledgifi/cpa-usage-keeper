package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/quota"
	"cpa-usage-keeper/internal/service"
	"cpa-usage-keeper/internal/timeutil"
	"github.com/gin-gonic/gin"
)

// This interface cannot collect, probe, reset, or mutate provider state.
type viewerQuotaCache interface {
	GetCachedQuota(context.Context, quota.CacheRequest) (quota.CacheResponse, error)
	GetAutoRefreshSettings(context.Context) (quota.AutoRefreshSettings, error)
}

// Dedicated allowlisted DTOs. Never serialize identities or raw quota payloads.
type viewerQuotaRow struct {
	ID               string     `json:"id"`
	Label            string     `json:"label"`
	Metric           string     `json:"metric,omitempty"`
	Used             *float64   `json:"used,omitempty"`
	UsedPercent      *float64   `json:"used_percent,omitempty"`
	Remaining        *float64   `json:"remaining,omitempty"`
	Limit            *float64   `json:"limit,omitempty"`
	RemainingPercent *float64   `json:"remaining_percent,omitempty"`
	ResetAt          *time.Time `json:"reset_at,omitempty"`
	WindowSeconds    *int64     `json:"window_seconds,omitempty"`
	LimitReached     *bool      `json:"limit_reached,omitempty"`
}
type viewerSubscription struct {
	Plan string `json:"plan"`
	Tier string `json:"tier,omitempty"`
}
type viewerQuotaAccount struct {
	ID           string              `json:"id"`
	Label        string              `json:"label"`
	Provider     string              `json:"provider"`
	Status       string              `json:"status"`
	UpdatedAt    *time.Time          `json:"updated_at,omitempty"`
	FreshUntil   *time.Time          `json:"fresh_until,omitempty"`
	Subscription *viewerSubscription `json:"subscription,omitempty"`
	Rows         []viewerQuotaRow    `json:"rows"`
}

func viewerOpaqueID(namespace string, value any) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("keeper-viewer-%s:%v", namespace, value)))
	return fmt.Sprintf("%x", sum[:12])
}
func viewerProviderName(identity entities.UsageIdentity) string {
	switch strings.ToLower(strings.TrimSpace(identity.Type)) {
	case "codex":
		return "Codex"
	case "claude":
		return "Claude"
	case "gemini", "gemini-cli":
		return "Gemini"
	case "antigravity":
		return "Antigravity"
	case "kimi":
		return "Kimi"
	case "xai":
		return "xAI"
	default:
		return "Other provider"
	}
}

func registerQuotasRoute(router gin.IRoutes, identities service.UsageIdentityProvider, provider viewerQuotaCache, h *authHandler) {
	router.GET("/quotas", func(c *gin.Context) {
		setNoStoreHeaders(c)
		// Require a real session even when stock auth middleware is disabled.
		value, _ := c.Get(authSessionContextKey)
		session, authenticated := value.(auth.Session)
		if !authenticated {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}
		if session.Role != auth.RoleAdmin {
			if _, _, ok := activeAPIKeyViewerContext(c); !ok {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
				return
			}
			if h == nil || !h.config.APIKeyViewerQuotaEnabled {
				c.JSON(http.StatusForbidden, gin.H{"error": "Quota access is disabled"})
				return
			}
		}
		unavailable := func() { c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Quota data is unavailable"}) }
		if identities == nil || provider == nil {
			unavailable()
			return
		}
		active, err := identities.ListActiveUsageIdentities(c.Request.Context())
		if err != nil {
			unavailable()
			return
		}
		sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
		selected := make([]entities.UsageIdentity, 0, len(active))
		indexes := make([]string, 0, len(active))
		for _, identity := range active {
			if identity.AuthType != entities.UsageIdentityAuthTypeAuthFile || identity.IsDeleted || (identity.Disabled != nil && *identity.Disabled) || strings.TrimSpace(identity.Identity) == "" {
				continue
			}
			selected = append(selected, identity)
			indexes = append(indexes, identity.Identity)
		}
		settings, err := provider.GetAutoRefreshSettings(c.Request.Context())
		if err != nil {
			unavailable()
			return
		}
		cache := quota.CacheResponse{}
		if len(indexes) > 0 {
			cache, err = provider.GetCachedQuota(c.Request.Context(), quota.CacheRequest{AuthIndexes: indexes})
			if err != nil {
				unavailable()
				return
			}
		}
		byIndex := make(map[string]quota.CachedQuotaItem, len(cache.Items))
		for _, item := range cache.Items {
			byIndex[item.AuthIndex] = item
		}
		now := time.Now()
		accounts := make([]viewerQuotaAccount, 0, len(selected))
		for _, identity := range selected {
			accounts = append(accounts, buildViewerQuotaAccount(identity, byIndex[identity.Identity], settings, now))
		}
		c.JSON(http.StatusOK, gin.H{"accounts": accounts, "server_time": now, "scheduled_refresh_enabled": settings.Enabled && settings.Schedule != nil})
	})
}

func buildViewerQuotaAccount(identity entities.UsageIdentity, item quota.CachedQuotaItem, settings quota.AutoRefreshSettings, now time.Time) viewerQuotaAccount {
	id := viewerOpaqueID("subscription", identity.ID)
	name := viewerProviderName(identity)
	account := viewerQuotaAccount{ID: id, Label: fmt.Sprintf("%s subscription %s", name, id[:8]), Provider: name, Status: "unavailable", Rows: []viewerQuotaRow{}}
	if item.RefreshedAt != nil && !item.RefreshedAt.IsZero() {
		account.UpdatedAt = item.RefreshedAt
	}
	// A failed latest task must never present an older successful payload as healthy.
	if item.Status != quota.RefreshTaskStatusCompleted || item.Quota == nil {
		return account
	}
	account.Subscription = safeViewerSubscription(name, item.Quota.Subscription)
	if len(item.Quota.Quota) == 0 {
		return account
	}
	account.Status, account.FreshUntil = quotaCacheFreshness(item, settings, now)
	for index, row := range item.Quota.Quota {
		// Stock normalization loses numeric presence for these optional fields.
		// Leave them unknown here instead of extending provider parsers.
		if name == "Gemini" || name == "Kimi" {
			row.Used, row.Limit, row.Remaining, row.UsedPercent, row.RemainingFraction = nil, nil, nil, nil, nil
		} else if name == "Claude" && row.Key == "extra_usage" {
			row.Used, row.Limit = nil, nil
		}
		safe := viewerQuotaRow{ID: viewerOpaqueID("window", fmt.Sprintf("%s:%s:%d", id, row.Key, index)), Label: safeViewerRowLabel(row, index), Metric: safeViewerMetric(row.Metric), Used: viewerNumber(row.Used), UsedPercent: viewerNumber(row.UsedPercent), Limit: viewerNumber(row.Limit), Remaining: viewerNumber(row.Remaining), LimitReached: row.LimitReached}
		if fraction := viewerNumber(row.RemainingFraction); fraction != nil && *fraction <= 1 {
			value := *fraction * 100
			safe.RemainingPercent = &value
		} else if percent := viewerNumber(row.UsedPercent); percent != nil && *percent <= 100 {
			value := 100 - *percent
			safe.RemainingPercent = &value
		}
		if row.ResetAt != "" {
			if reset, err := timeutil.ParseStorageTime(row.ResetAt); err == nil && reset.Year() >= 2000 && reset.Year() <= 9999 {
				safe.ResetAt = &reset
			}
		} else if row.ResetAfterSeconds != nil && item.RefreshedAt != nil && !item.RefreshedAt.IsZero() && *row.ResetAfterSeconds >= -366*24*3600 && *row.ResetAfterSeconds <= 366*24*3600 {
			reset := item.RefreshedAt.Add(time.Duration(*row.ResetAfterSeconds) * time.Second)
			safe.ResetAt = &reset
		}
		if safe.ResetAt != nil && !safe.ResetAt.After(now) {
			account.Status = "stale"
		}
		// A normalized duration is safe display metadata. It does not establish
		// an actual window start, history, or a promise of recurring refills.
		if row.Window != nil && row.Window.Seconds != nil && *row.Window.Seconds > 0 && *row.Window.Seconds <= 366*24*3600 {
			safe.WindowSeconds = row.Window.Seconds
		}
		account.Rows = append(account.Rows, safe)
	}
	return account
}
func viewerNumber(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 {
		return nil
	}
	return value
}

// Strings that originated upstream are not trusted display text. Use known
// normalized keys/windows and generated labels, never raw labels or account names.
func safeViewerRowLabel(row quota.QuotaRow, index int) string {
	labels := map[string]string{"five_hour": "5-hour", "seven_day": "Weekly", "seven_day_oauth_apps": "Weekly OAuth apps", "seven_day_opus": "Weekly Opus", "seven_day_sonnet": "Weekly Sonnet", "seven_day_cowork": "Weekly Cowork", "extra_usage": "Extra usage", "billing.weekly": "Weekly", "billing.monthly": "Monthly spend", "billing.on_demand": "Pay-as-you-go", "usages.limit_month_total": "Monthly percentage"}
	label := labels[row.Key]
	if label == "" && row.Window != nil && row.Window.Seconds != nil && *row.Window.Seconds > 0 {
		seconds := *row.Window.Seconds
		switch seconds {
		case 18000:
			label = "5-hour"
		case 604800:
			label = "Weekly"
		case 2592000, 2628000:
			label = "Monthly"
		default:
			label = fmt.Sprintf("%d-second window", seconds)
		}
	}
	if label == "" {
		label = fmt.Sprintf("Quota window %d", index+1)
	}
	if strings.HasPrefix(row.Key, "code_review_rate_limit.") {
		label = "Code review · " + label
	}
	switch row.GroupKey {
	case "antigravity-gemini-models":
		label = "Gemini · " + label
	case "antigravity-claude-and-gpt-models":
		label = "Claude / GPT · " + label
	}
	return label
}
func safeViewerMetric(metric string) string {
	switch strings.ToLower(metric) {
	case "tokens", "token", "requests", "request", "credits", "usd_cents", "prompt", "completion":
		return strings.ToLower(metric)
	}
	return ""
}
func safeViewerSubscription(provider string, info *quota.SubscriptionInfo) *viewerSubscription {
	if info == nil {
		return nil
	}
	allowed := map[string][]string{"Codex": {"free", "plus", "team", "pro-5x", "pro-20x", "enterprise"}, "Claude": {"free", "pro", "team", "max", "max-5x", "max-20x"}, "Antigravity": {"free", "pro", "ultra-lite", "ultra"}}
	if !strings.EqualFold(info.Provider, provider) {
		return nil
	}
	for _, plan := range allowed[provider] {
		if info.Plan == plan {
			result := &viewerSubscription{Plan: plan}
			if provider == "Antigravity" {
				result.Tier = map[string]string{"free": "Free", "pro": "Google AI Pro", "ultra-lite": "Google AI Ultra Lite", "ultra": "Google AI Ultra"}[plan]
			}
			return result
		}
	}
	return nil
}

// Both views use the scheduler's freshness deadline. A failed latest attempt
// cannot inherit a healthy status from an older successful payload.
func quotaCacheFreshness(item quota.CachedQuotaItem, settings quota.AutoRefreshSettings, now time.Time) (string, *time.Time) {
	if item.Status != quota.RefreshTaskStatusCompleted || item.Quota == nil || len(item.Quota.Quota) == 0 {
		return "unavailable", nil
	}
	if item.RefreshedAt == nil || item.RefreshedAt.IsZero() || item.RefreshedAt.After(now.Add(time.Minute)) {
		return "stale", nil
	}
	deadline := quota.CacheFreshUntil(settings, *item.RefreshedAt)
	if deadline == nil {
		return "cached", nil
	}
	if !now.Before(*deadline) {
		return "stale", deadline
	}
	return "available", deadline
}
