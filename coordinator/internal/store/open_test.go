package store

import (
	"context"
	"testing"
)

// A Coordinator that cannot reach its database must not start: every decision it makes is a
// write to the log, and a process that only discovers the outage on its first claim has already
// reported itself ready.
func TestOpenRefusesADatabaseItCannotReach(t *testing.T) {
	for name, connectionString := range map[string]string{
		"an unparseable connection string": "postgresql://%zz",
		"a server that is not listening":   "postgresql://coordinator_role:password@127.0.0.1:1/flory_test?connect_timeout=2",
	} {
		if store, err := Open(context.Background(), connectionString); err == nil {
			store.Close()
			t.Fatalf("%s was opened", name)
		}
	}
}
