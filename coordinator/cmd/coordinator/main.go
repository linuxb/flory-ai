// Command coordinator runs the Distributed Transaction Coordinator.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
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
	adapterClient := selectAdapter(logger)
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

// selectAdapter chooses the execution route.
//
// The gateway is the default: it is the only route that resolves an exact frozen
// contract and validates arguments against it before dispatch. The direct
// adapter remains selectable for a gateway-less debugging session and for the
// dual-path fixture that proves the two routes agree, but no scenario runs on it.
func selectAdapter(logger *slog.Logger) adapter.Client {
	transport := gatewayHTTPClient(logger)
	if mode := environment("ADAPTER_MODE", "gateway"); mode == "direct" {
		base := environment("ADAPTER_BASE_URL", "http://127.0.0.1:8090")
		logger.Warn("routing tool calls directly, bypassing contract pinning and argument validation", "adapter", base)
		return adapter.NewHTTPClient(base, transport)
	}
	base := environment("GATEWAY_BASE_URL", "http://127.0.0.1:8092")
	logger.Info("routing tool calls through the gateway", "gateway", base)
	return adapter.NewGatewayClient(base, transport)
}

func gatewayHTTPClient(logger *slog.Logger) *http.Client {
	certificatePath, keyPath, caPath := os.Getenv("COORDINATOR_MTLS_CERT_FILE"), os.Getenv("COORDINATOR_MTLS_KEY_FILE"), os.Getenv("GATEWAYD_CA_FILE")
	if certificatePath == "" && keyPath == "" && caPath == "" {
		return &http.Client{Timeout: 15 * time.Second}
	}
	certificate, err := tls.LoadX509KeyPair(certificatePath, keyPath)
	if err != nil {
		logger.Error("Coordinator mTLS certificate unavailable", "error", err)
		os.Exit(1)
	}
	raw, err := os.ReadFile(caPath)
	if err != nil {
		logger.Error("Gateway CA unavailable", "error", err)
		os.Exit(1)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(raw) {
		logger.Error("Gateway CA contains no certificates")
		os.Exit(1)
	}
	return &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}, RootCAs: roots,
	}}}
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
