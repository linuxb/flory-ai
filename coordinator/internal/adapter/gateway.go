package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

// GatewayClient routes one attempt through gatewayd's MCP surface.
//
// It implements the same Client interface as the direct adapter, so the
// Coordinator's transaction logic is unchanged by which route it uses. Routing
// through the gateway changes discovery and dispatch, not ownership: this
// Coordinator still decides every retry and appends every event.
type GatewayClient struct {
	baseURL string
	client  *http.Client
	nextID  atomic.Int64
}

// NewGatewayClient creates a client for a gatewayd MCP endpoint.
func NewGatewayClient(baseURL string, client *http.Client) *GatewayClient {
	if client == nil {
		client = http.DefaultClient
	}
	return &GatewayClient{baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type rpcResponse struct {
	Result *struct {
		StructuredContent struct {
			Outcome string         `json:"outcome"`
			Result  map[string]any `json:"result"`
			Error   string         `json:"error"`
		} `json:"structuredContent"`
	} `json:"result"`
	Error *struct {
		Code    int            `json:"code"`
		Message string         `json:"message"`
		Data    map[string]any `json:"data"`
	} `json:"error"`
}

// refusalOutcomes maps the gateway's closed refusal vocabulary onto the
// executor's own.
//
// Every one of these is decided before anything is dispatched, so the attempt
// provably did not happen. That is what makes them permanent rather than
// unknown: there is no side effect to reconcile, and repeating the same request
// would be refused the same way.
var refusalOutcomes = map[string]model.OperationOutcome{
	"unknown-tool-view":        model.OutcomePermanentFailure,
	"unknown-tool":             model.OutcomePermanentFailure,
	"version-absent-from-view": model.OutcomePermanentFailure,
	"schema-violation":         model.OutcomePermanentFailure,
	// The contract is intact and only the route is down, so another attempt at
	// this same operation is legal -- which remains the Coordinator's call.
	"route-unhealthy": model.OutcomeRetryableFailure,
}

// Execute sends one attempt as an MCP tools/call.
//
// It sends exactly one request and never repeats it. A transport failure means
// the attempt may or may not have reached the tool service, which is what
// OutcomeUnknown states; the Coordinator resolves that through the pivot's
// registered status query rather than by guessing here.
func (client *GatewayClient) Execute(ctx context.Context, request model.OperationRequest) (model.OperationResponse, error) {
	arguments := request.Input
	if arguments == nil {
		arguments = map[string]any{}
	}
	body, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      client.nextID.Add(1),
		Method:  "tools/call",
		Params: map[string]any{
			"name":      request.Tool,
			"arguments": arguments,
			"_meta": map[string]any{
				"run_id":           request.RunID,
				"vertex_id":        request.VertexID,
				"scope_id":         request.ScopeID,
				"tool_version":     request.ToolVersion,
				"tool_view_digest": request.ToolViewDigest,
				"attempt":          request.AttemptNo,
				"idempotency_key":  request.IdempotencyKey,
				"deadline_ms":      request.DeadlineMS,
			},
		},
	})
	if err != nil {
		return model.OperationResponse{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/mcp", bytes.NewReader(body))
	if err != nil {
		return model.OperationResponse{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := client.client.Do(httpRequest)
	if err != nil {
		return model.OperationResponse{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return model.OperationResponse{}, fmt.Errorf("gateway returned HTTP %d", response.StatusCode)
	}
	var decoded rpcResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return model.OperationResponse{}, err
	}
	if decoded.Error != nil {
		reason, _ := decoded.Error.Data["reason"].(string)
		outcome, known := refusalOutcomes[reason]
		if !known {
			// An unrecognised refusal is a protocol disagreement, not a tool
			// outcome. Failing loudly beats inventing a classification for it.
			return model.OperationResponse{}, fmt.Errorf("gateway refused %s: %s", request.Tool, decoded.Error.Message)
		}
		return model.OperationResponse{Outcome: outcome, Error: decoded.Error.Message}, nil
	}
	if decoded.Result == nil {
		return model.OperationResponse{}, fmt.Errorf("gateway returned neither a result nor an error for %s", request.Tool)
	}
	structured := decoded.Result.StructuredContent
	switch outcome := model.OperationOutcome(structured.Outcome); outcome {
	case model.OutcomeSucceeded, model.OutcomeRetryableFailure, model.OutcomePermanentFailure, model.OutcomeUnknown:
		return model.OperationResponse{Outcome: outcome, Result: structured.Result, Error: structured.Error}, nil
	default:
		return model.OperationResponse{}, fmt.Errorf("gateway returned unknown outcome %q", structured.Outcome)
	}
}
