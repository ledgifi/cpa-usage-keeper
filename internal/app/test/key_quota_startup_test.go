package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cpa-usage-keeper/internal/auth"
	"cpa-usage-keeper/internal/entities"
)

func TestStartupWiresViewerQuotaCapability(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		name := "disabled"
		if enabled {
			name = "enabled"
		}
		t.Run(name, func(t *testing.T) {
			cfg := testAppConfig(t)
			cfg.AppBasePath = "/keeper"
			cfg.AuthEnabled, cfg.APIKeyViewerQuotaEnabled = true, enabled
			application := newInitializedApp(t, cfg)
			if err := application.DB.Create(&entities.CPAAPIKey{ID: 42, APIKey: "fixture-key"}).Error; err != nil {
				t.Fatal(err)
			}
			store := auth.NewGormSessionStore(application.DB)
			for token, session := range map[string]auth.Session{
				"fixture-viewer": {Role: auth.RoleAPIKeyViewer, CPAAPIKeyID: 42, Source: auth.SessionSourceStandard, ExpiresAt: time.Now().Add(time.Hour)},
				"fixture-admin":  {Role: auth.RoleAdmin, Source: auth.SessionSourceStandard, ExpiresAt: time.Now().Add(time.Hour)},
			} {
				if err := store.Save(token, session); err != nil {
					t.Fatal(err)
				}
			}
			get := func(path, token string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(http.MethodGet, cfg.AppBasePath+"/api/v1"+path, nil)
				if token != "" {
					r.AddCookie(&http.Cookie{Name: "cpa_usage_keeper_session", Value: token})
				}
				response := httptest.NewRecorder()
				application.Router.ServeHTTP(response, r)
				return response
			}
			session := get("/auth/session", "fixture-viewer")
			var body struct {
				APIKey struct {
					QuotaEnabled bool `json:"quota_enabled"`
				} `json:"api_key"`
			}
			if session.Code != http.StatusOK || json.Unmarshal(session.Body.Bytes(), &body) != nil || body.APIKey.QuotaEnabled != enabled {
				t.Fatalf("capability after v2 initialization: %d %s", session.Code, session.Body.String())
			}
			want := http.StatusForbidden
			if enabled {
				want = http.StatusOK
			}
			for token, status := range map[string]int{"fixture-viewer": want, "fixture-admin": http.StatusOK, "": http.StatusUnauthorized} {
				if response := get("/quotas", token); response.Code != status {
					t.Fatalf("token=%q quota access: %d %s, want %d", token, response.Code, response.Body.String(), status)
				}
			}
		})
	}
}
