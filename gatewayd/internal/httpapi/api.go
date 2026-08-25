// Package httpapi exposes the gateway's HTTP surfaces: MCP for the executors,
// a tool-view read endpoint for tooling, and the operational endpoints.
package httpapi

import (
	"encoding/json"
	"expvar"
	"net/http"

	"github.com/linuxb/flory-ai/gatewayd/internal/mcp"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
)

// New builds the gateway's HTTP handler.
func New(mcpServer *mcp.Server, toolRegistry *registry.Registry) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST /mcp", mcpServer)
	mux.HandleFunc("GET /v1/tool-view", func(writer http.ResponseWriter, _ *http.Request) {
		current := toolRegistry.Current()
		if current == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"error": "no tool view has been published yet"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"tool_view_ref":    current.Published.Ref,
			"tool_view_digest": current.Published.Digest,
			"tool_count":       len(current.Published.Document.Tools),
		})
	})
	mux.HandleFunc("GET /v1/registrations", func(writer http.ResponseWriter, _ *http.Request) {
		statuses := toolRegistry.Statuses()
		reported := make([]map[string]any, 0, len(statuses))
		for _, status := range statuses {
			entry := map[string]any{"tool_id": status.GetToolId(), "tool_version": status.GetToolVersion(), "state": status.GetState().String()}
			if status.GetDetail() != "" {
				entry["code"], entry["detail"] = status.GetCode().String(), status.GetDetail()
			}
			reported = append(reported, entry)
		}
		writeJSON(writer, http.StatusOK, map[string]any{"registrations": reported})
	})
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusNoContent) })
	// Readiness is publication, not process liveness. A gateway that has not
	// published anything -- not even the empty view -- cannot answer discovery at
	// all, and reporting it ready would send an executor to a surface that can
	// only refuse it. An empty view is ready: "no tools are admitted yet" is a
	// real answer, and a planner resolving it gets a valid view rather than an
	// error it would have to distinguish from an outage.
	mux.HandleFunc("GET /readyz", func(writer http.ResponseWriter, _ *http.Request) {
		if toolRegistry.Current() == nil {
			writeJSON(writer, http.StatusServiceUnavailable, map[string]any{"error": "no tool view has been published yet"})
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("GET /metrics", expvar.Handler())
	return mux
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
