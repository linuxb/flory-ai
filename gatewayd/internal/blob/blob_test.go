package blob

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"
)

// runStoreContract exercises the behaviour every Store must provide, so the
// in-memory implementation used by unit tests cannot quietly diverge from the
// GCS implementation production publishes through.
func runStoreContract(t *testing.T, store Store) {
	t.Helper()
	ctx := context.Background()
	// A developer's storage emulator outlives any one test run, so the contract
	// is exercised under a name this run owns rather than a fixed one whose
	// leftovers would make the first assertion depend on run history.
	name := "tool-views/test-" + randomSuffix(t) + ".json"
	content := []byte(`{"tool_view_version":"1","tools":[]}`)

	if _, err := store.Get(ctx, name); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing object returned %v, want ErrNotFound", err)
	}
	if err := store.Put(ctx, name, content); err != nil {
		t.Fatalf("put: %v", err)
	}
	stored, err := store.Get(ctx, name)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !bytes.Equal(stored, content) {
		t.Fatalf("get returned %s, want %s", stored, content)
	}
	// A content-addressed name is derived from what it holds, so re-publishing
	// the same view must converge rather than conflict.
	if err := store.Put(ctx, name, content); err != nil {
		t.Fatalf("repeated put: %v", err)
	}
	stored, err = store.Get(ctx, name)
	if err != nil {
		t.Fatalf("get after repeated put: %v", err)
	}
	if !bytes.Equal(stored, content) {
		t.Fatalf("repeated put changed the content to %s", stored)
	}
}

func randomSuffix(t *testing.T) string {
	t.Helper()
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		t.Fatalf("random suffix: %v", err)
	}
	return hex.EncodeToString(buffer)
}

func TestMemoryStoreContract(t *testing.T) {
	runStoreContract(t, NewMemory())
}

func TestMemoryStoreCopiesContent(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	content := []byte(`{"a":1}`)
	if err := store.Put(ctx, "object", content); err != nil {
		t.Fatalf("put: %v", err)
	}
	content[2] = 'z'
	stored, err := store.Get(ctx, "object")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(stored) != `{"a":1}` {
		t.Fatalf("mutating the caller's slice changed the stored object to %s", stored)
	}
}

// Runs against fake-gcs-server locally and in CI; skipped when no emulator is
// configured, so a plain `go test` needs no external service.
func TestGCSStoreContract(t *testing.T) {
	if os.Getenv("STORAGE_EMULATOR_HOST") == "" {
		t.Skip("set STORAGE_EMULATOR_HOST to run the GCS store against an emulator")
	}
	bucket := os.Getenv("GATEWAYD_BLOB_BUCKET")
	if bucket == "" {
		bucket = "flory-tool-views"
	}
	ctx := context.Background()
	store, err := NewGCS(ctx, bucket)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer store.Close()
	if err := store.EnsureBucket(ctx, "flory-local"); err != nil {
		t.Fatalf("ensure bucket: %v", err)
	}
	runStoreContract(t, store)
}
