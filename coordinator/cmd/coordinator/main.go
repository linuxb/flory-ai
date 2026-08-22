// Command coordinator runs the Distributed Transaction Coordinator.
package main

import (
	"context"
	"expvar"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/linuxb/flory-ai/coordinator/internal/adapter"
	"github.com/linuxb/flory-ai/coordinator/internal/coordinator"
	"github.com/linuxb/flory-ai/coordinator/internal/store"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	databaseURL := environment("COORDINATOR_DATABASE_URL", "postgresql://coordinator_role:coordinator-dev-password@127.0.0.1:5432/flory")
	database, err := store.Open(ctx, databaseURL)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer database.Close()
	adapterClient := adapter.NewHTTPClient(environment("ADAPTER_BASE_URL", "http://127.0.0.1:8090"), &http.Client{Timeout: 15 * time.Second})
	service := coordinator.New(database, adapterClient, coordinator.Config{
		WorkerID: environment("COORDINATOR_WORKER_ID", "coordinator-local"), LeaseDuration: 30 * time.Second, PollInterval: 100 * time.Millisecond, SweepInterval: time.Second,
	}, logger)
	health := &http.Server{Addr: environment("COORDINATOR_HEALTH_ADDR", "127.0.0.1:8091"), Handler: healthHandler(), ReadHeaderTimeout: 2 * time.Second}
	go func() {
		if err := health.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("health server failed", "error", err)
			stop()
		}
	}()
	if err := service.Run(ctx); err != nil && err != context.Canceled {
		logger.Error("coordinator stopped", "error", err)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = health.Shutdown(shutdownCtx)
}

func healthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /readyz", func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNoContent) })
	mux.Handle("GET /metrics", expvar.Handler())
	return mux
}

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
