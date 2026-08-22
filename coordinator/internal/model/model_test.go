package model

import (
	"testing"
	"time"

	"github.com/linuxb/flory-ai/coordinator/internal/eventlog/generated"
)

func TestBackoffIsDeterministicAndCapped(t *testing.T) {
	policy := generated.RetryPolicy{MaxAttempts: 5, InitialBackoffMS: 10, Multiplier: 2, MaxBackoffMS: 25}
	values := []time.Duration{Backoff(policy, 1), Backoff(policy, 2), Backoff(policy, 3), Backoff(policy, 4)}
	want := []time.Duration{0, 10 * time.Millisecond, 20 * time.Millisecond, 25 * time.Millisecond}
	for index := range want {
		if values[index] != want[index] {
			t.Fatalf("attempt %d: got %s, want %s", index+1, values[index], want[index])
		}
	}
}
