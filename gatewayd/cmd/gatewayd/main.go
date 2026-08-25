// Command gatewayd runs the Tool Registry and Execution Gateway.
//
// It listens on two surfaces: gRPC for tool-service registration, and HTTP for
// the MCP tools/list and tools/call the Agent Orchestrator and the Distributed
// Transaction Coordinator consume.
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"google.golang.org/grpc"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	"github.com/linuxb/flory-ai/gatewayd/internal/grpcapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/httpapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/mcp"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	store, err := openBlobStore(ctx, logger)
	if err != nil {
		logger.Error("blob storage unavailable", "error", err)
		os.Exit(1)
	}

	table := route.NewTable(nil)
	dispatcher := route.NewDispatcher(table)
	defer dispatcher.Close()
	toolRegistry := registry.New(store, table)
	prober := route.NewProber(table, dispatcher.Probe, duration("GATEWAYD_PROBE_INTERVAL_MS", 5*time.Second), duration("GATEWAYD_PROBE_TIMEOUT_MS", time.Second))
	// A probe that changes an instance's state can complete a cluster that was
	// waiting on its route, so resolution is driven by health rather than polled.
	prober.OnChange = func() {
		if err := toolRegistry.Resolve(ctx); err != nil {
			logger.Error("tool view resolution failed", "error", err)
		}
	}
	go prober.Run(ctx)
	go sweepLeases(ctx, toolRegistry, logger)

	grpcServer := grpc.NewServer()
	gatewayv1.RegisterRegistryServiceServer(grpcServer, grpcapi.NewRegistryServer(toolRegistry, table, prober, store))
	grpcAddress := environment("GATEWAYD_GRPC_ADDR", "127.0.0.1:8093")
	listener, err := net.Listen("tcp", grpcAddress)
	if err != nil {
		logger.Error("registration listener failed", "address", grpcAddress, "error", err)
		os.Exit(1)
	}
	go func() {
		logger.Info("registration surface listening", "address", grpcAddress)
		if err := grpcServer.Serve(listener); err != nil {
			logger.Error("registration surface stopped", "error", err)
			stop()
		}
	}()

	httpAddress := environment("GATEWAYD_HTTP_ADDR", "127.0.0.1:8092")
	httpServer := &http.Server{
		Addr:              httpAddress,
		Handler:           httpapi.New(mcp.NewServer(toolRegistry, dispatcher, store), toolRegistry),
		ReadHeaderTimeout: 2 * time.Second,
	}
	go func() {
		logger.Info("MCP surface listening", "address", httpAddress)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("MCP surface stopped", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	grpcServer.GracefulStop()
}

// openBlobStore selects the durable store for published tool views.
//
// The in-memory backend exists so a laptop run needs no storage at all; it keeps
// no history, so a restart loses every previously published view and any digest
// a frozen subgraph pinned. Anything beyond local development uses GCS.
func openBlobStore(ctx context.Context, logger *slog.Logger) (blob.Store, error) {
	switch backend := environment("GATEWAYD_BLOB_BACKEND", "gcs"); backend {
	case "memory":
		logger.Warn("using in-memory tool-view storage; published views do not survive a restart")
		return blob.NewMemory(), nil
	default:
		store, err := blob.NewGCS(ctx, environment("GATEWAYD_BLOB_BUCKET", "flory-tool-views"))
		if err != nil {
			return nil, err
		}
		if os.Getenv("STORAGE_EMULATOR_HOST") != "" {
			if err := store.EnsureBucket(ctx, environment("GATEWAYD_BLOB_PROJECT", "flory-local")); err != nil {
				return nil, err
			}
		}
		return store, nil
	}
}

// sweepLeases re-resolves periodically so an expired lease stops gating a route.
//
// Leases expire silently by the clock passing, with no event to react to, so
// this is the one place the gateway polls rather than responds.
func sweepLeases(ctx context.Context, toolRegistry *registry.Registry, logger *slog.Logger) {
	ticker := time.NewTicker(grpcapi.LeaseSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := toolRegistry.Resolve(ctx); err != nil {
				logger.Error("lease sweep failed", "error", err)
			}
		}
	}
}

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func duration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	milliseconds, err := strconv.Atoi(value)
	if err != nil || milliseconds <= 0 {
		return fallback
	}
	return time.Duration(milliseconds) * time.Millisecond
}
