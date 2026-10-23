package quota

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestPeekCachedQuotaDoesNotPruneTaskState(t *testing.T) {
	now := time.Now()
	observation := &CheckResponse{Quota: []QuotaRow{{Key: "five_hour"}}}
	expired := &RefreshTaskRecord{Status: RefreshTaskStatusCompleted, Quota: observation, ExpiresAt: now.Add(-time.Hour)}
	fresh := &RefreshTaskRecord{Status: RefreshTaskStatusCompleted, Quota: observation, RefreshedAt: now, ExpiresAt: now.Add(time.Hour)}
	service := &Service{refreshTasks: map[string]*RefreshTaskRecord{"expired": expired, "fresh": fresh}}
	beforeExpired, beforeFresh := *expired, *fresh
	request := CacheRequest{AuthIndexes: []string{"expired", "fresh", "fresh", "missing"}}

	for range 2 {
		response, err := service.PeekCachedQuota(context.Background(), request)
		if err != nil || len(response.Items) != 1 || response.Items[0].AuthIndex != "fresh" {
			t.Fatalf("unexpected snapshot: %+v, %v", response, err)
		}
		if len(service.refreshTasks) != 2 || service.refreshTasks["expired"] != expired || !service.nextRefreshTaskCleanupAt.IsZero() ||
			!reflect.DeepEqual(*expired, beforeExpired) || !reflect.DeepEqual(*fresh, beforeFresh) {
			t.Fatal("viewer snapshot changed task state or the cleanup deadline")
		}
	}

	// Administrator reads retain upstream's cleanup behavior and response.
	admin, err := service.GetCachedQuota(context.Background(), request)
	viewer, viewerErr := service.PeekCachedQuota(context.Background(), request)
	if err != nil || viewerErr != nil || !reflect.DeepEqual(admin, viewer) || len(service.refreshTasks) != 1 || service.nextRefreshTaskCleanupAt.IsZero() {
		t.Fatalf("admin cleanup or snapshot parity changed: admin=%+v viewer=%+v errors=%v/%v", admin, viewer, err, viewerErr)
	}
}
