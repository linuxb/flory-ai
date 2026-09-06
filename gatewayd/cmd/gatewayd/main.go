// Command gatewayd runs the Tool Registry and Execution Gateway.
//
// It listens on two surfaces: gRPC for tool-service registration, and HTTP for
// the MCP tools/list and tools/call the Agent Orchestrator and the Distributed
// Transaction Coordinator consume.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"google.golang.org/grpc"

	"github.com/linuxb/flory-ai/gatewayd/internal/authn"
	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	"github.com/linuxb/flory-ai/gatewayd/internal/grpcapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/httpapi"
	"github.com/linuxb/flory-ai/gatewayd/internal/mcp"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
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

	var roleStore *rbac.Store
	rbacEnabled := environment("GATEWAYD_RBAC_ENABLED", "true") == "true"
	if rbacEnabled {
		roleStore, err = rbac.Open(ctx, environment("GATEWAYD_DATABASE_URL", "postgresql://gateway_role:gateway-dev-password@127.0.0.1:5432/flory"))
		if err != nil {
			logger.Error("RBAC store unavailable", "error", err)
			os.Exit(1)
		}
		defer roleStore.Close()
	}
	table := route.NewTable(nil)
	dispatcher := route.NewDispatcher(table)
	defer dispatcher.Close()
	var toolRegistry *registry.Registry
	if roleStore != nil {
		toolRegistry = registry.New(store, table, roleStore)
	} else {
		toolRegistry = registry.New(store, table)
	}
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
	mcpServer := mcp.NewServer(toolRegistry, dispatcher, store)
	var mcpHandler http.Handler = mcpServer
	var adminConfig []httpapi.RBACAdminConfig
	var tlsConfig *tls.Config
	if rbacEnabled {
		algorithms, configureErr := signatureAlgorithms(environment("GATEWAYD_OIDC_ALLOWED_ALGS", "RS256"))
		if configureErr != nil {
			logger.Error("OIDC algorithms invalid", "error", configureErr)
			os.Exit(1)
		}
		oidcVerifier, configureErr := authn.NewOIDCVerifier(ctx, authn.OIDCConfig{
			Issuer: os.Getenv("GATEWAYD_OIDC_ISSUER"), Audience: os.Getenv("GATEWAYD_OIDC_AUDIENCE"),
			AllowedAlgorithms: algorithms,
			AllowInsecureHTTP: environment("GATEWAYD_OIDC_ALLOW_INSECURE_HTTP", "false") == "true",
		})
		if configureErr != nil {
			logger.Error("OIDC configuration invalid", "error", configureErr)
			os.Exit(1)
		}
		signer, configureErr := authn.LoadSigner(os.Getenv("GATEWAYD_IDENTITY_KEY_ID"), os.Getenv("GATEWAYD_IDENTITY_PRIVATE_KEY_FILE"), os.Getenv("GATEWAYD_IDENTITY_KEYRING_DIR"))
		if configureErr != nil {
			logger.Error("workflow identity signer unavailable", "error", configureErr)
			os.Exit(1)
		}
		orchestrators := stringSet(os.Getenv("GATEWAYD_ORCHESTRATOR_SPIFFE_IDS"))
		internals := stringSet(os.Getenv("GATEWAYD_INTERNAL_SPIFFE_IDS"))
		mcpServer.ConfigureAuthorization(signer, orchestrators)
		mcpHandler = (&authn.Middleware{OIDC: oidcVerifier, Roles: roleStore, Signer: signer, InternalSPIFFEIDs: internals}).Handler(mcpServer)
		adminConfig = append(adminConfig, httpapi.RBACAdminConfig{Store: roleStore, AdminSPIFFEIDs: stringSet(os.Getenv("GATEWAYD_ADMIN_SPIFFE_IDS"))})
		tlsConfig, err = clientTLSConfig(os.Getenv("GATEWAYD_CLIENT_CA_FILE"))
		if err != nil {
			logger.Error("client CA unavailable", "error", err)
			os.Exit(1)
		}
	}
	httpServer := &http.Server{
		Addr:              httpAddress,
		Handler:           httpapi.New(mcpHandler, toolRegistry, adminConfig...),
		ReadHeaderTimeout: 2 * time.Second,
		TLSConfig:         tlsConfig,
	}
	go func() {
		logger.Info("MCP surface listening", "address", httpAddress)
		serve := func() error { return httpServer.ListenAndServe() }
		if rbacEnabled {
			serve = func() error {
				return httpServer.ListenAndServeTLS(os.Getenv("GATEWAYD_TLS_CERT_FILE"), os.Getenv("GATEWAYD_TLS_KEY_FILE"))
			}
		}
		if err := serve(); err != nil && err != http.ErrServerClosed {
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

func stringSet(value string) map[string]bool {
	result := map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result[item] = true
		}
	}
	return result
}

func signatureAlgorithms(value string) ([]jose.SignatureAlgorithm, error) {
	known := map[string]jose.SignatureAlgorithm{"RS256": jose.RS256, "ES256": jose.ES256, "EdDSA": jose.EdDSA}
	result := []jose.SignatureAlgorithm{}
	for _, configured := range strings.Split(value, ",") {
		name := strings.TrimSpace(configured)
		algorithm, ok := known[name]
		if !ok {
			return nil, fmt.Errorf("unsupported signature algorithm %q", name)
		}
		result = append(result, algorithm)
	}
	return result, nil
}

func clientTLSConfig(caPath string) (*tls.Config, error) {
	raw, err := os.ReadFile(caPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(raw) {
		return nil, fmt.Errorf("no certificates in %s", caPath)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, ClientCAs: pool, ClientAuth: tls.VerifyClientCertIfGiven}, nil
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
