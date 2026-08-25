// Package mcp implements the gateway's north side: the MCP tools/list and
// tools/call surfaces that the Agent Orchestrator and the Distributed
// Transaction Coordinator both consume.
//
// The surface is identical for both callers. gatewayd does not know or care
// which one is calling: which vertices an executor may run is decided by the
// event log's ownership constraints, not here.
package mcp

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// JSON-RPC 2.0 error codes. The application-level vocabulary travels in Data,
// so a caller can branch on a stable reason rather than on message text.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
	codeGatewayRefusal = -32000
)

// The closed vocabulary of gateway refusals. Every one of them means the attempt
// was never dispatched, which is what lets a caller treat them as decisive
// rather than as an ambiguous outcome needing a status query.
const (
	// ReasonUnknownToolView means the requested digest resolves to nothing.
	ReasonUnknownToolView = "unknown-tool-view"
	// ReasonUnknownTool means the view does not contain that tool at all.
	ReasonUnknownTool = "unknown-tool"
	// ReasonVersionAbsent means the view has the tool but not that version.
	ReasonVersionAbsent = "version-absent-from-view"
	// ReasonSchemaViolation means the arguments failed the frozen input schema.
	ReasonSchemaViolation = "schema-violation"
	// ReasonRouteUnhealthy means no instance was routable before dispatch.
	ReasonRouteUnhealthy = "route-unhealthy"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (err *rpcError) Error() string { return err.Message }

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// refuse builds a gateway refusal carrying its closed-vocabulary reason.
func refuse(reason, format string, arguments ...any) *rpcError {
	return &rpcError{Code: codeGatewayRefusal, Message: fmt.Sprintf(format, arguments...), Data: map[string]any{"reason": reason}}
}

func invalidParams(format string, arguments ...any) *rpcError {
	return &rpcError{Code: codeInvalidParams, Message: fmt.Sprintf(format, arguments...)}
}

// writeResponse emits one JSON-RPC response.
//
// The HTTP status is always 200 for a well-formed envelope: JSON-RPC carries its
// own error channel, and a caller that had to read both would have two sources
// of truth for one outcome.
func writeResponse(writer http.ResponseWriter, id json.RawMessage, result any, failure *rpcError) {
	writer.Header().Set("Content-Type", "application/json")
	response := rpcResponse{JSONRPC: "2.0", ID: id, Result: result, Error: failure}
	writer.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(writer).Encode(response)
}

func readRequest(request *http.Request) (rpcRequest, *rpcError) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return rpcRequest{}, &rpcError{Code: codeParseError, Message: err.Error()}
	}
	var parsed rpcRequest
	if err := json.Unmarshal(body, &parsed); err != nil {
		return rpcRequest{}, &rpcError{Code: codeParseError, Message: err.Error()}
	}
	if parsed.JSONRPC != "2.0" || parsed.Method == "" {
		return rpcRequest{}, &rpcError{Code: codeInvalidRequest, Message: `a request needs jsonrpc "2.0" and a method`}
	}
	return parsed, nil
}
