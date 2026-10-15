package quota

import (
	"testing"

	"cpa-usage-keeper/internal/cpa/dto/apicall"
)

func TestNormalizedWindowsPreserveUnknownAndExplicitZero(t *testing.T) {
	for _, tc := range []struct {
		name, body  string
		codex, zero bool
	}{
		{"codex missing", `{"rate_limit":{"primary_window":{}}}`, true, false},
		{"codex zero", `{"rate_limit":{"primary_window":{"used_percent":0,"reset_after_seconds":0}}}`, true, true},
		{"claude missing", `{"five_hour":{"resets_at":"2026-10-13T12:00:00Z"}}`, false, false},
		{"claude zero", `{"five_hour":{"utilization":0}}`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := &apicall.Response{StatusCode: 200, BodyText: tc.body}
			var output ProviderOutput
			if tc.codex {
				payload, err := parseCodexUsagePayload(response)
				if err != nil {
					t.Fatal(err)
				}
				output.Result = CodexResult{Usage: payload}
			} else {
				payload, err := parseClaudeUsagePayload(response)
				if err != nil {
					t.Fatal(err)
				}
				output.Result = ClaudeResult{Usage: payload}
			}
			rows := NormalizeQuotaRows(output)
			if len(rows) != 1 {
				t.Fatalf("rows=%+v", rows)
			}
			value := rows[0].UsedPercent
			if tc.zero {
				if value == nil || *value != 0 {
					t.Fatalf("explicit zero lost: %+v", rows[0])
				}
			} else if value != nil {
				t.Fatalf("unknown usage became zero: %+v", rows[0])
			}
			if tc.codex && tc.zero && (rows[0].ResetAfterSeconds == nil || *rows[0].ResetAfterSeconds != 0) {
				t.Fatal("explicit immediate reset lost")
			}
		})
	}
}
