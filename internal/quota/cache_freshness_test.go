package quota

import (
	"testing"
	"time"
)

func TestCacheFreshUntilUsesSchedulerSemantics(t *testing.T) {
	previous := time.Local
	time.Local = time.FixedZone("fixture", -3*3600)
	t.Cleanup(func() { time.Local = previous })
	observed := time.Date(2026, 10, 13, 14, 30, 0, 0, time.Local)
	for _, tc := range []struct {
		unit  AutoRefreshScheduleUnit
		value int
		want  time.Time
	}{
		{AutoRefreshScheduleUnitMinute, 5, observed.Add(7 * time.Minute)},
		{AutoRefreshScheduleUnitHour, 6, observed.Add(6*time.Hour + 2*time.Minute)},
		{AutoRefreshScheduleUnitDay, 2, time.Date(2026, 10, 15, 0, 2, 0, 0, time.Local)},
		{AutoRefreshScheduleUnitWeek, 2, time.Date(2026, 10, 20, 0, 2, 0, 0, time.Local)},
	} {
		deadline := CacheFreshUntil(AutoRefreshSettings{Enabled: true, Schedule: &AutoRefreshSchedule{Unit: tc.unit, Value: tc.value}}, observed)
		if deadline == nil || !deadline.Equal(tc.want) {
			t.Fatalf("%s deadline=%v want=%v", tc.unit, deadline, tc.want)
		}
	}
	for _, settings := range []AutoRefreshSettings{{}, {Enabled: true}, {Enabled: false, Schedule: &AutoRefreshSchedule{Unit: AutoRefreshScheduleUnitHour, Value: 6}}, {Enabled: true, Schedule: &AutoRefreshSchedule{Unit: AutoRefreshScheduleUnitHour, Value: 0}}} {
		if CacheFreshUntil(settings, observed) != nil {
			t.Fatal("disabled/unconfigured/invalid schedule cannot imply freshness")
		}
	}
}
