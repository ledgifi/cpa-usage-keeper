package api

import (
	"context"
	"time"

	"cpa-usage-keeper/internal/quota"
	"github.com/gin-gonic/gin"
)

// Add presentation metadata to the existing admin cache response without
// collecting quota. Unreadable settings leave freshness unknown.
func quotaCacheDisplayResponse(ctx context.Context, provider QuotaProvider, response quota.CacheResponse) gin.H {
	settings, settingsErr := provider.GetAutoRefreshSettings(ctx)
	var scheduled *bool
	if settingsErr == nil {
		enabled := settings.Enabled && settings.Schedule != nil
		scheduled = &enabled
	} else {
		settings = quota.AutoRefreshSettings{}
	}
	now := time.Now()
	type displayItem struct {
		quota.CachedQuotaItem
		DisplayStatus string     `json:"display_status"`
		FreshUntil    *time.Time `json:"fresh_until,omitempty"`
	}
	items := make([]displayItem, 0, len(response.Items))
	for _, item := range response.Items {
		status, deadline := quotaCacheFreshness(item, settings, now)
		items = append(items, displayItem{item, status, deadline})
	}
	return gin.H{"items": items, "server_time": now, "scheduled_refresh_enabled": scheduled}
}
