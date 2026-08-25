package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/linuxb/flory-ai/gatewayd/internal/blob"
	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/route"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

// ProtocolVersion is the MCP revision this surface implements.
const ProtocolVersion = "2025-06-18"

// DefaultDeadline bounds an attempt whose caller did not supply one.
const DefaultDeadline = 30 * time.Second

// Dispatcher routes exactly one attempt to a tool service.
type Dispatcher interface {
	Execute(ctx context.Context, routeID string, request *gatewayv1.ExecuteRequest) (*gatewayv1.ExecuteResponse, error)
}

// Server serves MCP over JSON-RPC 2.0.
type Server struct {
	registry   *registry.Registry
	dispatcher Dispatcher
	blobs      blob.Store
	// historical caches views resolved from blob storage by digest, because a
	// frozen subgraph keeps calling the same digest long after it stopped being
	// current, and recompiling its schemas per attempt would be pure waste.
	historicalMutex sync.Mutex
	historical      map[string]*resolvedView
}

type resolvedView struct {
	published toolview.Published
	schemas   map[registry.Key]*jsonschema.Schema
}

// NewServer creates the MCP surface over a registry, a dispatcher, and the blob
// store that holds every previously published view.
func NewServer(toolRegistry *registry.Registry, dispatcher Dispatcher, blobs blob.Store) *Server {
	return &Server{registry: toolRegistry, dispatcher: dispatcher, blobs: blobs, historical: map[string]*resolvedView{}}
}

// ServeHTTP handles one JSON-RPC request.
func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeResponse(writer, nil, nil, &rpcError{Code: codeInvalidRequest, Message: "MCP requests are POSTed"})
		return
	}
	parsed, failure := readRequest(request)
	if failure != nil {
		writeResponse(writer, nil, nil, failure)
		return
	}
	result, failure := server.dispatch(request.Context(), parsed)
	writeResponse(writer, parsed.ID, result, failure)
}

func (server *Server) dispatch(ctx context.Context, request rpcRequest) (any, *rpcError) {
	switch request.Method {
	case "initialize":
		return map[string]any{
			"protocolVersion": ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "gatewayd", "version": toolview.Version},
		}, nil
	case "notifications/initialized", "ping":
		return map[string]any{}, nil
	case "tools/list":
		return server.toolsList(ctx, request.Params)
	case "tools/call":
		return server.toolsCall(ctx, request.Params)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: fmt.Sprintf("unknown method %q", request.Method)}
	}
}

type listParams struct {
	ToolViewDigest string `json:"tool_view_digest"`
}

func (server *Server) toolsList(ctx context.Context, raw json.RawMessage) (any, *rpcError) {
	var params listParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, invalidParams("%v", err)
		}
	}
	view, failure := server.resolveView(ctx, params.ToolViewDigest)
	if failure != nil {
		return nil, failure
	}
	tools := make([]map[string]any, 0, len(view.published.Document.Tools))
	for _, tool := range view.published.Document.Tools {
		entry := map[string]any{
			"name":        tool.ToolID,
			"inputSchema": json.RawMessage(tool.InputSchema),
			"metadata":    map[string]any{"flory_transaction": tool.Metadata()},
		}
		if tool.Description != "" {
			entry["description"] = tool.Description
		}
		tools = append(tools, entry)
	}
	return map[string]any{
		"tools": tools,
		"_meta": map[string]any{
			"tool_view_ref":    view.published.Ref,
			"tool_view_digest": view.published.Digest,
			// The canonical document, verbatim. The tools array above is a rendering
			// for a model; this is the byte sequence the digest was taken over, so a
			// caller can re-derive the digest instead of trusting the gateway's word
			// for what it served -- which is what content addressing is for.
			"tool_view_document": string(view.published.Canonical),
		},
	}, nil
}

// callMeta is the execution envelope a caller pins its attempt with.
type callMeta struct {
	RunID          string `json:"run_id"`
	VertexID       string `json:"vertex_id"`
	ScopeID        string `json:"scope_id"`
	ToolVersion    string `json:"tool_version"`
	ToolViewDigest string `json:"tool_view_digest"`
	Attempt        uint32 `json:"attempt"`
	IdempotencyKey string `json:"idempotency_key"`
	DeadlineMS     int64  `json:"deadline_ms"`
}

type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Meta      callMeta        `json:"_meta"`
}

// toolsCall resolves an exact frozen contract and routes one attempt to it.
//
// Everything before dispatch fails closed, and in this order: resolve the pinned
// view, find that exact version inside it, validate the arguments against its
// frozen schema, then confirm a route is healthy. A refusal at any of those
// steps means nothing was attempted, which is why they are JSON-RPC errors and
// an upstream answer is a result.
func (server *Server) toolsCall(ctx context.Context, raw json.RawMessage) (any, *rpcError) {
	var params callParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, invalidParams("%v", err)
	}
	if params.Name == "" {
		return nil, invalidParams("name is required")
	}
	view, failure := server.resolveView(ctx, params.Meta.ToolViewDigest)
	if failure != nil {
		return nil, failure
	}
	tool, failure := lookupPinned(view, params.Name, params.Meta.ToolVersion)
	if failure != nil {
		return nil, failure
	}
	arguments := params.Arguments
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if failure := validateArguments(view, tool, arguments); failure != nil {
		return nil, failure
	}

	deadline := time.Duration(params.Meta.DeadlineMS) * time.Millisecond
	if deadline <= 0 {
		deadline = time.Duration(tool.TimeoutMS) * time.Millisecond
	}
	if deadline <= 0 {
		deadline = DefaultDeadline
	}
	attemptCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()

	response, err := server.dispatcher.Execute(attemptCtx, tool.RouteID, &gatewayv1.ExecuteRequest{
		RunId:          params.Meta.RunID,
		VertexId:       params.Meta.VertexID,
		ScopeId:        params.Meta.ScopeID,
		AttemptNo:      params.Meta.Attempt,
		ToolId:         tool.ToolID,
		ToolVersion:    tool.ToolVersion,
		ToolViewDigest: view.published.Digest,
		IdempotencyKey: params.Meta.IdempotencyKey,
		Arguments:      string(arguments),
		Deadline:       timestamppb.New(time.Now().Add(deadline)),
	})
	if err != nil {
		var unhealthy route.ErrNoHealthyInstance
		if errors.As(err, &unhealthy) {
			return nil, refuse(ReasonRouteUnhealthy, "%v", err)
		}
		// The attempt left the gateway and did not come back with an answer, so
		// whether the side effect happened is genuinely unknown. Reporting it as
		// retryable here would authorise a duplicate; unknown hands the decision
		// to the executor, which owns the idempotency and pivot state that can
		// actually resolve it.
		return outcomeResult(gatewayv1.Outcome_OUTCOME_UNKNOWN, "", fmt.Sprintf("upstream transport failure: %v", err)), nil
	}
	return outcomeResult(response.GetOutcome(), response.GetResult(), response.GetError()), nil
}

func lookupPinned(view *resolvedView, name, version string) (toolview.Tool, *rpcError) {
	tool, found := view.published.Document.Lookup(name, version)
	if found {
		return tool, nil
	}
	// Distinguish "no such tool" from "not that version": a caller pinning a
	// version that has been superseded must see that as a version problem, and
	// must never be quietly upgraded to a newer contract it never admitted.
	if _, present := view.published.Document.Lookup(name, ""); present {
		return toolview.Tool{}, refuse(ReasonVersionAbsent, "tool %s is in view %s, but not at version %s", name, view.published.Digest, version)
	}
	return toolview.Tool{}, refuse(ReasonUnknownTool, "tool %s is not in view %s", name, view.published.Digest)
}

func validateArguments(view *resolvedView, tool toolview.Tool, arguments json.RawMessage) *rpcError {
	schema, found := view.schemas[registry.Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}]
	if !found {
		return &rpcError{Code: codeInternalError, Message: fmt.Sprintf("view %s has no compiled schema for %s", view.published.Digest, tool.ToolID)}
	}
	var decoded any
	if err := json.Unmarshal(arguments, &decoded); err != nil {
		return refuse(ReasonSchemaViolation, "arguments are not JSON: %v", err)
	}
	if err := schema.Validate(decoded); err != nil {
		return refuse(ReasonSchemaViolation, "arguments violate the frozen input schema of %s@%s: %v", tool.ToolID, tool.ToolVersion, err)
	}
	return nil
}

var outcomeNames = map[gatewayv1.Outcome]string{
	gatewayv1.Outcome_OUTCOME_SUCCEEDED:         "succeeded",
	gatewayv1.Outcome_OUTCOME_RETRYABLE_FAILURE: "retryable-failure",
	gatewayv1.Outcome_OUTCOME_PERMANENT_FAILURE: "permanent-failure",
	gatewayv1.Outcome_OUTCOME_UNKNOWN:           "unknown",
}

// outcomeResult renders an upstream answer in the executors' own vocabulary.
func outcomeResult(outcome gatewayv1.Outcome, result, failure string) map[string]any {
	name, known := outcomeNames[outcome]
	if !known {
		// A tool service that answered without an outcome has told us nothing
		// about whether its effect happened, which is the definition of unknown.
		name = "unknown"
		failure = "upstream returned an unspecified outcome"
	}
	structured := map[string]any{"outcome": name}
	if result != "" {
		var decoded any
		if err := json.Unmarshal([]byte(result), &decoded); err != nil {
			return map[string]any{
				"structuredContent": map[string]any{"outcome": "unknown", "error": fmt.Sprintf("upstream result is not JSON: %v", err)},
				"isError":           true,
			}
		}
		structured["result"] = decoded
	}
	if failure != "" {
		structured["error"] = failure
	}
	rendered, _ := json.Marshal(structured)
	return map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(rendered)}},
		"structuredContent": structured,
		"isError":           outcome != gatewayv1.Outcome_OUTCOME_SUCCEEDED,
	}
}

// resolveView resolves the current view, or an exact historical one by digest.
//
// A digest that names no stored view is refused rather than silently served from
// the current one: pinning is the whole mechanism by which a frozen subgraph
// keeps seeing the contract it was admitted against.
func (server *Server) resolveView(ctx context.Context, digest string) (*resolvedView, *rpcError) {
	current := server.registry.Current()
	if digest == "" {
		if current == nil {
			return nil, refuse(ReasonUnknownToolView, "no tool view has been published yet")
		}
		return &resolvedView{published: current.Published, schemas: schemasOf(current)}, nil
	}
	if !toolview.DigestPattern.MatchString(digest) {
		return nil, invalidParams("tool_view_digest %q is not a sha256 digest", digest)
	}
	if current != nil && current.Published.Digest == digest {
		return &resolvedView{published: current.Published, schemas: schemasOf(current)}, nil
	}
	server.historicalMutex.Lock()
	cached, hit := server.historical[digest]
	server.historicalMutex.Unlock()
	if hit {
		return cached, nil
	}
	stored, err := server.blobs.Get(ctx, toolview.Ref(digest))
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			return nil, refuse(ReasonUnknownToolView, "tool view %s is not stored", digest)
		}
		return nil, &rpcError{Code: codeInternalError, Message: err.Error()}
	}
	published, err := toolview.Parse(stored, digest)
	if err != nil {
		return nil, refuse(ReasonUnknownToolView, "%v", err)
	}
	resolved := &resolvedView{published: published, schemas: map[registry.Key]*jsonschema.Schema{}}
	for _, tool := range published.Document.Tools {
		schema, err := registry.CompileSchema(tool.ToolID+"@"+tool.ToolVersion, string(tool.InputSchema))
		if err != nil {
			return nil, &rpcError{Code: codeInternalError, Message: err.Error()}
		}
		resolved.schemas[registry.Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}] = schema
	}
	server.historicalMutex.Lock()
	server.historical[digest] = resolved
	server.historicalMutex.Unlock()
	return resolved, nil
}

func schemasOf(view *registry.View) map[registry.Key]*jsonschema.Schema {
	schemas := map[registry.Key]*jsonschema.Schema{}
	for _, tool := range view.Published.Document.Tools {
		if schema, found := view.Schema(registry.Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}); found {
			schemas[registry.Key{ToolID: tool.ToolID, ToolVersion: tool.ToolVersion}] = schema
		}
	}
	return schemas
}
