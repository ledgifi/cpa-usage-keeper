package test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	. "cpa-usage-keeper/internal/api"
	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/quota"
	"cpa-usage-keeper/internal/service"
)

// All collector/mutation methods remain nil and panic if invoked. Only cache
// and settings reads are implemented, so these tests catch unintended calls.
type viewerCacheStub struct {
	QuotaProvider
	cache    quota.CacheResponse
	settings quota.AutoRefreshSettings
	request  quota.CacheRequest
	reads    int
	err      error
}

func (s *viewerCacheStub) GetCachedQuota(_ context.Context, r quota.CacheRequest) (quota.CacheResponse, error) {
	s.request = r
	s.reads++
	return s.cache, s.err
}
func (s *viewerCacheStub) GetAutoRefreshSettings(context.Context) (quota.AutoRefreshSettings, error) {
	return s.settings, s.err
}

type quotaViewerKeys struct {
	keyViewerRankingKeyStub
	revoked bool
}

func (s *quotaViewerKeys) FindActiveCPAAPIKeyByID(ctx context.Context, id int64) (entities.CPAAPIKey, error) {
	if s.revoked {
		return entities.CPAAPIKey{}, service.ErrInvalidID
	}
	return s.keyViewerRankingKeyStub.FindActiveCPAAPIKeyByID(ctx, id)
}
func quotaViewerRouter(t *testing.T, enabled bool, identities []entities.UsageIdentity, cache *viewerCacheStub) (http.Handler, string, string, *quotaViewerKeys) {
	t.Helper()
	sessions := auth.NewSessionManager(time.Hour)
	viewer, _, err := sessions.CreateAPIKeyViewer(42)
	if err != nil {
		t.Fatal(err)
	}
	admin, _, err := sessions.Create()
	if err != nil {
		t.Fatal(err)
	}
	keys := &quotaViewerKeys{keyViewerRankingKeyStub: keyViewerRankingKeyStub{row: entities.CPAAPIKey{ID: 42, APIKey: "private-teammate-key"}}}
	config := AuthConfig{Enabled: true, APIKeyViewerQuotaEnabled: enabled}
	router := NewRouter(nil, nil, nil, nil, config, NewAuthHandler(config, sessions), "", OptionalProviders{CPAAPIKeys: keys, Quota: cache, UsageIdentity: identityMetadataStub{items: identities}})
	return router, viewer, admin, keys
}
func quotaGet(router http.Handler, token string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, viewerRankingRequest("GET", "/api/v1/quotas?auth_indexes=unselected-secret", token))
	return response
}
func TestKeyQuotaAuthorization(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		cache := &viewerCacheStub{}
		router, viewer, admin, keys := quotaViewerRouter(t, enabled, nil, cache)
		expected := http.StatusForbidden
		if enabled {
			expected = http.StatusOK
		}
		if response := quotaGet(router, viewer); response.Code != expected {
			t.Fatalf("enabled=%t status=%d %s", enabled, response.Code, response.Body.String())
		}
		if response := quotaGet(router, admin); response.Code != http.StatusOK {
			t.Fatalf("admin access must not depend on viewer flag: enabled=%t status=%d", enabled, response.Code)
		}
		for _, token := range []string{"", "invalid-token"} {
			response := quotaGet(router, token)
			if response.Code != http.StatusUnauthorized && response.Code != http.StatusForbidden {
				t.Fatalf("unauthorized status=%d", response.Code)
			}
		}
		session := httptest.NewRecorder()
		router.ServeHTTP(session, viewerRankingRequest("GET", "/api/v1/auth/session", viewer))
		if strings.Contains(session.Body.String(), `"quota_enabled":true`) != enabled {
			t.Fatalf("incorrect capability %s", session.Body.String())
		}
		keys.revoked = true
		if response := quotaGet(router, viewer); response.Code != http.StatusUnauthorized {
			t.Fatalf("revoked status=%d", response.Code)
		}
		keys.revoked = false
	}
	// Auth-disabled stock middleware must not accidentally make shared data public.
	config := AuthConfig{APIKeyViewerQuotaEnabled: true}
	router := NewRouter(nil, nil, nil, nil, config, nil, "", OptionalProviders{Quota: &viewerCacheStub{}})
	if response := quotaGet(router, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous auth-disabled status=%d", response.Code)
	}
}
func TestKeyQuotaCannotReachAdministratorRoutes(t *testing.T) {
	cache := &viewerCacheStub{}
	router, viewer, admin, _ := quotaViewerRouter(t, true, nil, cache)
	for _, route := range []struct{ method, path string }{
		{"POST", "/quota/refresh"}, {"POST", "/quota/reset"}, {"GET", "/quota/reset-credits/auth-secret"}, {"POST", "/quota/cache"}, {"GET", "/quota/refresh/auth-secret"}, {"POST", "/quota/inspection"}, {"GET", "/quota/inspection"}, {"GET", "/quota/auto-refresh/settings"}, {"PUT", "/quota/auto-refresh/settings"}, {"DELETE", "/quota/history/auth-secret/cycles/1"}, {"PATCH", "/auth-files/auth-secret/status"}, {"DELETE", "/auth-files"}, {"GET", "/usage/identities"}, {"GET", "/usage/api-keys"},
	} {
		r := viewerRankingRequest(route.method, "/api/v1"+route.path, viewer)
		r.Header.Set("X-CPA-Usage-Keeper-Request", "fetch")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s %s status=%d", route.method, route.path, response.Code)
		}
	}
	r := viewerRankingRequest("GET", "/api/v1/quota/auto-refresh/settings", admin)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, r)
	if response.Code != http.StatusOK {
		t.Fatalf("distinct admin access status=%d", response.Code)
	}
	if cache.reads != 0 {
		t.Fatal("unauthorized request reached cache")
	}
}

type displayResponse struct {
	Accounts []struct {
		ID, Label, Provider, Status string
		UpdatedAt                   *time.Time `json:"updated_at"`
		Subscription                *struct{ Plan, Tier string }
		Rows                        []struct {
			ID, Label, Metric      string
			Used, Remaining, Limit *float64
			RemainingPercent       *float64   `json:"remaining_percent"`
			ResetAt                *time.Time `json:"reset_at"`
		}
	}
}

func decodeQuota(t *testing.T, response *httptest.ResponseRecorder) displayResponse {
	t.Helper()
	if response.Code != 200 {
		t.Fatalf("status=%d %s", response.Code, response.Body.String())
	}
	var result displayResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func TestKeyQuotaSafeSharedCacheProjection(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	secret := "DO_NOT_EXPOSE-user@example.com-sk-secret-auth.json"
	active := entities.UsageIdentity{ID: 17, Type: "codex", AuthType: entities.UsageIdentityAuthTypeAuthFile, Identity: "secret-index", Name: secret, Alias: new(secret), FileName: new(secret), FilePath: new(secret), AccountID: new(secret), Note: new(secret), PlanType: new(secret)}
	disabled := active
	disabled.ID = 18
	disabled.Identity = "disabled"
	disabled.Disabled = new(true)
	deleted := active
	deleted.ID = 19
	deleted.Identity = "deleted"
	deleted.IsDeleted = true
	provider := active
	provider.ID = 20
	provider.Identity = "provider-key"
	provider.AuthType = entities.UsageIdentityAuthTypeAIProvider
	other := active
	other.ID = 21
	other.Identity = "no-cache"
	other.Type = "claude"
	cache := &viewerCacheStub{settings: quota.AutoRefreshSettings{Enabled: true, Schedule: &quota.AutoRefreshSchedule{Unit: quota.AutoRefreshScheduleUnitHour, Value: 6}}, cache: quota.CacheResponse{Items: []quota.CachedQuotaItem{
		{AuthIndex: active.Identity, FileName: new(secret), Status: quota.RefreshTaskStatusCompleted, Error: secret, UpstreamResponses: []quota.UpstreamResponse{{URL: secret, Body: secret, Header: map[string][]string{"X-Secret": {secret}}}}, RefreshedAt: &now, Quota: &quota.CheckResponse{ID: secret, Subscription: &quota.SubscriptionInfo{Provider: "codex", Plan: "pro-20x", TierID: secret, TierName: secret}, RateLimitResetCreditsAvailableCount: new(7), Quota: []quota.QuotaRow{
			{Key: "rate_limit.primary_window", Label: secret, Metric: secret, GroupDescription: secret, UsedPercent: new(0.0), ResetAfterSeconds: new(int64(3600)), Window: &quota.QuotaWindow{Seconds: new(int64(18000))}, WindowUsageTokens: new(int64(123)), WindowUsageCost: new(3.0)},
			{Key: "unknown", Label: secret, ResetAt: secret},
			{Key: "counts", Used: new(0.0), Remaining: new(0.0), Limit: new(100.0)},
		}}},
	}}}
	router, viewer, admin, _ := quotaViewerRouter(t, true, []entities.UsageIdentity{active, disabled, deleted, provider, other}, cache)
	response := quotaGet(router, viewer)
	result := decodeQuota(t, response)
	adminResponse := quotaGet(router, admin)
	if adminResult := decodeQuota(t, adminResponse); !reflect.DeepEqual(result.Accounts, adminResult.Accounts) {
		t.Fatal("admin and viewer must receive the same safe cached display data")
	}
	if !reflect.DeepEqual(cache.request.AuthIndexes, []string{"secret-index", "no-cache"}) {
		t.Fatalf("server selection=%v", cache.request)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("response must not be cached")
	}
	for _, forbidden := range []string{secret, active.Identity, "private-teammate-key", "auth_index", "file_name", "resetCredits", "window_usage", "raw", "upstream_responses", "total_requests"} {
		if strings.Contains(response.Body.String(), forbidden) || strings.Contains(adminResponse.Body.String(), forbidden) {
			t.Fatalf("leaked %q in %s", forbidden, response.Body.String())
		}
	}
	if len(result.Accounts) != 2 || result.Accounts[0].Status != "available" || result.Accounts[1].Status != "unavailable" {
		t.Fatalf("accounts=%+v", result.Accounts)
	}
	account := result.Accounts[0]
	if account.Subscription == nil || account.Subscription.Plan != "pro-20x" {
		t.Fatal("missing safe plan")
	}
	if *account.Rows[0].RemainingPercent != 100 || account.Rows[0].Remaining != nil || account.Rows[0].Limit != nil {
		t.Fatal("percentage-only quota must not invent counts")
	}
	if !account.Rows[0].ResetAt.Equal(now.Add(time.Hour)) {
		t.Fatal("relative reset must use observation time")
	}
	if account.Rows[1].RemainingPercent != nil || account.Rows[1].Remaining != nil || account.Rows[1].ResetAt != nil {
		t.Fatal("missing/invalid fields must remain unknown")
	}
	if account.Rows[2].Used == nil || *account.Rows[2].Used != 0 || account.Rows[2].Remaining == nil {
		t.Fatal("explicit zero was lost")
	}
	// Removing another account must not renumber or relabel this subscription.
	router2, viewer2, _, _ := quotaViewerRouter(t, true, []entities.UsageIdentity{active}, cache)
	result2 := decodeQuota(t, quotaGet(router2, viewer2))
	if result2.Accounts[0].ID != account.ID || result2.Accounts[0].Label != account.Label {
		t.Fatal("unstable subscription identity")
	}
}
func TestKeyQuotaFreshnessAndUnavailable(t *testing.T) {
	now := time.Now().UTC()
	recent := now.Add(-time.Minute)
	old := now.Add(-2 * time.Hour)
	identity := entities.UsageIdentity{ID: 1, Type: "antigravity", Identity: "fixture", AuthType: entities.UsageIdentityAuthTypeAuthFile}
	for _, tc := range []struct {
		name     string
		settings quota.AutoRefreshSettings
		item     quota.CachedQuotaItem
		status   string
	}{
		{"no cache", quota.AutoRefreshSettings{}, quota.CachedQuotaItem{}, "unavailable"},
		{"schedule disabled", quota.AutoRefreshSettings{}, quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &old}, "cached"},
		{"enabled no schedule", quota.AutoRefreshSettings{Enabled: true}, quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &recent}, "cached"},
		{"stale", quota.AutoRefreshSettings{Enabled: true, Schedule: &quota.AutoRefreshSchedule{Unit: quota.AutoRefreshScheduleUnitMinute, Value: 5}}, quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &old}, "stale"},
		{"missing timestamp", quota.AutoRefreshSettings{}, quota.CachedQuotaItem{Status: quota.RefreshTaskStatusCompleted}, "stale"},
		{"failed despite old payload", quota.AutoRefreshSettings{}, quota.CachedQuotaItem{Status: quota.RefreshTaskStatusFailed, RefreshedAt: &recent, Error: "raw secret error"}, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.item.AuthIndex = "fixture"
			tc.item.Quota = &quota.CheckResponse{Subscription: &quota.SubscriptionInfo{Provider: "antigravity", Plan: "ultra", TierName: "secret tier name"}, Quota: []quota.QuotaRow{{Key: "window", RemainingFraction: new(0.0)}}}
			cache := &viewerCacheStub{settings: tc.settings, cache: quota.CacheResponse{Items: []quota.CachedQuotaItem{tc.item}}}
			router, viewer, _, _ := quotaViewerRouter(t, true, []entities.UsageIdentity{identity}, cache)
			response := quotaGet(router, viewer)
			result := decodeQuota(t, response)
			account := result.Accounts[0]
			if account.Status != tc.status {
				t.Fatalf("status=%s want=%s", account.Status, tc.status)
			}
			if tc.item.Status == quota.RefreshTaskStatusFailed && (len(account.Rows) != 0 || account.Subscription != nil) {
				t.Fatal("failed refresh exposed older success")
			}
			if account.Subscription != nil && account.Subscription.Tier != "Google AI Ultra" {
				t.Fatal("unsafe plan tier")
			}
		})
	}
	for _, relative := range []bool{false, true} {
		row := quota.QuotaRow{Key: "window"}
		if relative {
			row.ResetAfterSeconds = new(int64(0))
		} else {
			row.ResetAt = old.Format(time.RFC3339)
		}
		cache := &viewerCacheStub{cache: quota.CacheResponse{Items: []quota.CachedQuotaItem{{AuthIndex: "fixture", Status: quota.RefreshTaskStatusCompleted, RefreshedAt: &recent, Quota: &quota.CheckResponse{Quota: []quota.QuotaRow{row}}}}}}
		router, viewer, _, _ := quotaViewerRouter(t, true, []entities.UsageIdentity{identity}, cache)
		if result := decodeQuota(t, quotaGet(router, viewer)); result.Accounts[0].Status != "stale" || result.Accounts[0].Rows[0].ResetAt == nil {
			t.Fatal("passed reset must be stale")
		}
	}
	cache := &viewerCacheStub{err: errors.New("upstream secret error")}
	router, viewer, _, _ := quotaViewerRouter(t, true, []entities.UsageIdentity{identity}, cache)
	response := quotaGet(router, viewer)
	if response.Code != 503 || strings.Contains(response.Body.String(), "secret") {
		t.Fatal("unsafe service failure")
	}
}
