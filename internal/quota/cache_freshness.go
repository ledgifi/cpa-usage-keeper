package quota

import "time"

// CacheFreshUntil is a display deadline, not a collection trigger or guarantee.
// It follows the scheduler's calendar/weekday semantics, with two minutes of
// queue grace. Without a configured enabled schedule freshness is unverified.
func CacheFreshUntil(settings AutoRefreshSettings, observedAt time.Time) *time.Time {
	if !settings.Enabled || settings.Schedule == nil || observedAt.IsZero() {
		return nil
	}
	schedule, err := normalizeAutoRefreshSchedule(settings.Schedule)
	if err != nil {
		return nil
	}
	deadline := nextAutoRefreshDueAt(observedAt, schedule).Add(2 * time.Minute)
	return &deadline
}
