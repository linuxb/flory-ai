package coordinator

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// TestMain gives the integration suite the clean slate the TypeScript suites get from their global
// setup.
//
// The work queue, the pending cancellation requests and the sweeper's candidates are all global
// within a database, and every scenario here drives a real Service against them. A run that failed
// half way leaves a fenced scope with a pending request, or a cancellation half done, and the next
// run's first ProcessOne serves that instead of its own work -- one failure then fails every test
// after it for reasons unrelated to what broke. So before the suite runs, as the database owner:
// the queue is emptied, pending requests are cleared, and any scope a previous run left open with a
// fence, an expired try or an unfinished cancellation is set aside as suspended, where no pass will
// pick it up. It refuses to touch any database whose name does not end in `_test`.
func TestMain(m *testing.M) {
	if os.Getenv("FLORY_INTEGRATION") == "1" {
		if err := resetIntegrationDatabase(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "integration reset:", err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

func resetIntegrationDatabase(ctx context.Context) error {
	target, err := url.Parse(coordinatorURL())
	if err != nil {
		return err
	}
	name := strings.TrimPrefix(target.Path, "/")
	if !strings.HasSuffix(name, "_test") {
		// A development database is someone's working state; the suite still runs, unreset.
		fmt.Fprintf(os.Stderr, "integration reset skipped: %s is not a _test database\n", name)
		return nil
	}
	ownerURL := environmentForTest("OWNER_DATABASE_URL", fmt.Sprintf("postgresql://flory:flory-dev-password@%s/%s", target.Host, name))
	connection, err := pgx.Connect(ctx, ownerURL)
	if err != nil {
		return err
	}
	defer connection.Close(ctx)
	for _, statement := range []string{
		`DELETE FROM work_queue`,
		`UPDATE txn_scope SET cancel_request_outcome = NULL, cancel_request_next_at = NULL WHERE cancel_request_outcome IN ('pending', 'deferred')`,
		`UPDATE txn_scope s SET state = 'suspended' WHERE s.state = 'cancelling'
            OR (s.state = 'open' AND (s.fenced_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM txn_bracket b WHERE b.scope_id = s.scope_id AND b.state = 'sealed')))`,
	} {
		if _, err := connection.Exec(ctx, statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	return nil
}
