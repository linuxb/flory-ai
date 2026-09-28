package rbac

import (
	"context"
	"testing"
)

// The gateway resolves every bearer principal's roles here, so a store it cannot reach must stop
// it at startup rather than turn each request into an authorization failure.
func TestOpenRefusesADatabaseItCannotReach(t *testing.T) {
	for name, connectionString := range map[string]string{
		"an unparseable connection string": "postgresql://%zz",
		"a server that is not listening":   "postgresql://gateway_role:password@127.0.0.1:1/flory_test?connect_timeout=2",
	} {
		if store, err := Open(context.Background(), connectionString); err == nil {
			store.Close()
			t.Fatalf("%s was opened", name)
		}
	}
}
