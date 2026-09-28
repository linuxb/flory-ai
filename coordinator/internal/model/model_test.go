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

func TestDecodeWorkPayloadReadsTheRoleBeforeTheBody(t *testing.T) {
	payload, role, err := DecodeWorkPayload([]byte(`{"role":"tool","tool":"inventory.reserve","input":{"sku":"A1"}}`))
	if err != nil || role != "tool" || payload.Tool != "inventory.reserve" || payload.Input["sku"] != "A1" {
		t.Fatalf("payload=%+v role=%q err=%v", payload, role, err)
	}
	// A barrier carries no tool body, so it is recognised by its role alone and nothing else is read.
	payload, role, err = DecodeWorkPayload([]byte(`{"role":"confirmation-barrier","tool":17}`))
	if err != nil || role != "confirmation-barrier" || payload.Tool != "" {
		t.Fatalf("barrier payload=%+v role=%q err=%v", payload, role, err)
	}
}

func TestDecodeWorkPayloadRejectsWhatItCannotRead(t *testing.T) {
	for name, raw := range map[string]string{
		"not JSON":             `{`,
		"a mistyped role":      `{"role":7}`,
		"a mistyped tool body": `{"role":"tool","tool":17}`,
	} {
		if _, role, err := DecodeWorkPayload([]byte(raw)); err == nil || role != "" {
			t.Fatalf("%s: role=%q err=%v, want an error and no role", name, role, err)
		}
	}
}

func TestBackoffWaitsNothingBeforeTheFirstRetryOrWithoutAnInitialDelay(t *testing.T) {
	if delay := Backoff(generated.RetryPolicy{InitialBackoffMS: 10, Multiplier: 2}, 1); delay != 0 {
		t.Fatalf("first attempt waited %s", delay)
	}
	if delay := Backoff(generated.RetryPolicy{Multiplier: 2}, 3); delay != 0 {
		t.Fatalf("a policy with no initial delay waited %s", delay)
	}
	// No ceiling means none is applied.
	if delay := Backoff(generated.RetryPolicy{InitialBackoffMS: 10, Multiplier: 3}, 4); delay != 90*time.Millisecond {
		t.Fatalf("uncapped delay=%s, want 90ms", delay)
	}
}
