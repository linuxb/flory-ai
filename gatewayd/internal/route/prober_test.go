package route

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Run probes once at start, so a gateway does not wait out a whole interval before it can route,
// and then on every tick until it is stopped.
func TestProberRunProbesAtOnceThenOnEveryTickUntilStopped(t *testing.T) {
	table, _ := newTestTable(t)
	if err := table.Upsert(instanceInfo("inv-1", "inventory", "127.0.0.1:9000"), serving()); err != nil {
		t.Fatal(err)
	}
	var probes atomic.Int32
	var changes atomic.Int32
	prober := NewProber(table, func(context.Context, string) error {
		probes.Add(1)
		return nil
	}, time.Millisecond, time.Second)
	prober.OnChange = func() { changes.Add(1) }
	ctx, stop := context.WithCancel(context.Background())
	var finished sync.WaitGroup
	finished.Add(1)
	go func() {
		defer finished.Done()
		prober.Run(ctx)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for probes.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	stop()
	finished.Wait()
	if probes.Load() < 3 {
		t.Fatalf("probes=%d, want the initial probe and at least two ticks", probes.Load())
	}
	if !table.Routable("inventory") {
		t.Fatal("a probed, serving instance is not routable")
	}
	// Only the first probe changed anything: the rest confirmed what was already known.
	if changes.Load() != 1 {
		t.Fatalf("changes=%d, want 1", changes.Load())
	}
	settled := probes.Load()
	time.Sleep(20 * time.Millisecond)
	if probes.Load() != settled {
		t.Fatal("the prober kept probing after it was stopped")
	}
}
