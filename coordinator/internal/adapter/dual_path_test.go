package adapter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

// upstream records the exact bytes it was called with, so the two routes are
// compared on what actually reached the tool service and not only on what the
// Coordinator was told afterwards.
type upstream struct {
	mutex    sync.Mutex
	payloads [][]byte
	respond  func(request map[string]any) map[string]any
}

func (service *upstream) record(body []byte) {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	service.payloads = append(service.payloads, body)
}

func (service *upstream) count() int {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	return len(service.payloads)
}

// startDirectUpstream serves the execute contract the direct adapter speaks.
func startDirectUpstream(t *testing.T, service *upstream) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		service.record(body)
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(service.respond(decoded))
	}))
	t.Cleanup(server.Close)
	return server
}

// startGatewayUpstream stands in for gatewayd's MCP surface, translating one
// tools/call into the same upstream request the direct route produces.
func startGatewayUpstream(t *testing.T, service *upstream, refusal map[string]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var envelope struct {
			ID     int64 `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
				Meta      map[string]any `json:"_meta"`
			} `json:"params"`
		}
		_ = json.NewDecoder(request.Body).Decode(&envelope)
		writer.Header().Set("Content-Type", "application/json")
		if refusal != nil {
			// A refusal is decided before dispatch, so nothing is recorded here.
			_ = json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": envelope.ID, "error": refusal})
			return
		}
		forwarded := map[string]any{
			"run_id":          envelope.Params.Meta["run_id"],
			"vertex_id":       envelope.Params.Meta["vertex_id"],
			"attempt_no":      envelope.Params.Meta["attempt"],
			"tool":            envelope.Params.Name,
			"idempotency_key": envelope.Params.Meta["idempotency_key"],
			"input":           envelope.Params.Arguments,
		}
		body, _ := json.Marshal(forwarded)
		service.record(body)
		answer := service.respond(forwarded)
		structured := map[string]any{"outcome": answer["outcome"]}
		if result, present := answer["result"]; present {
			structured["result"] = result
		}
		if failure, present := answer["error"]; present {
			structured["error"] = failure
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": envelope.ID, "result": map[string]any{"structuredContent": structured}})
	}))
	t.Cleanup(server.Close)
	return server
}

func succeeding(request map[string]any) map[string]any {
	return map[string]any{"outcome": "succeeded", "result": map[string]any{"available": 7, "echoed": request["tool"]}}
}

// The request every case is stated against. The pin fields are what the gateway
// route needs and the direct route ignores.
func attempt() model.OperationRequest {
	return model.OperationRequest{
		RunID:          "run-1",
		VertexID:       "vertex-1",
		AttemptNo:      1,
		Tool:           "inventory.check",
		ToolVersion:    "1.0.0",
		ToolViewDigest: "sha256:" + "a1b2c3d4" + "00000000000000000000000000000000000000000000000000000000",
		IdempotencyKey: "key-1",
		Input:          map[string]any{"sku": "SKU-1"},
	}
}

// Doc 09 section 7 makes this the precondition for the gateway becoming the
// production route: both paths must be interchangeable from the Coordinator's
// point of view, or planning and execution would be validating different things.
func TestBothRoutesProduceTheSameOutcome(t *testing.T) {
	ctx := context.Background()
	directService := &upstream{respond: succeeding}
	gatewayService := &upstream{respond: succeeding}
	direct := NewHTTPClient(startDirectUpstream(t, directService).URL, nil)
	gateway := NewGatewayClient(startGatewayUpstream(t, gatewayService, nil).URL, nil)

	fromDirect, err := direct.Execute(ctx, attempt())
	if err != nil {
		t.Fatalf("direct: %v", err)
	}
	fromGateway, err := gateway.Execute(ctx, attempt())
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}
	if !reflect.DeepEqual(fromDirect, fromGateway) {
		t.Fatalf("routes disagree:\n direct  = %+v\n gateway = %+v", fromDirect, fromGateway)
	}
}

// Both routes must end at the same upstream request, or an equivalence proved on
// outcomes alone would hide a difference in what the tool service was asked to do.
func TestBothRoutesSendTheSameUpstreamPayload(t *testing.T) {
	ctx := context.Background()
	directService := &upstream{respond: succeeding}
	gatewayService := &upstream{respond: succeeding}
	direct := NewHTTPClient(startDirectUpstream(t, directService).URL, nil)
	gateway := NewGatewayClient(startGatewayUpstream(t, gatewayService, nil).URL, nil)

	if _, err := direct.Execute(ctx, attempt()); err != nil {
		t.Fatalf("direct: %v", err)
	}
	if _, err := gateway.Execute(ctx, attempt()); err != nil {
		t.Fatalf("gateway: %v", err)
	}
	if directService.count() != 1 || gatewayService.count() != 1 {
		t.Fatalf("upstream call counts: direct=%d gateway=%d, want 1 each", directService.count(), gatewayService.count())
	}
	var fromDirect, fromGateway map[string]any
	if err := json.Unmarshal(directService.payloads[0], &fromDirect); err != nil {
		t.Fatalf("decode direct payload: %v", err)
	}
	if err := json.Unmarshal(gatewayService.payloads[0], &fromGateway); err != nil {
		t.Fatalf("decode gateway payload: %v", err)
	}
	// The direct route carries the pin as extra fields the upstream ignores; the
	// gateway consumes it and does not forward it. Compare what the tool acts on.
	for _, key := range []string{"tool_version", "tool_view_digest", "scope_id", "deadline_ms"} {
		delete(fromDirect, key)
	}
	if !reflect.DeepEqual(fromDirect, fromGateway) {
		t.Fatalf("routes sent different upstream payloads:\n direct  = %v\n gateway = %v", fromDirect, fromGateway)
	}
}

func TestEachOutcomeSurvivesBothRoutes(t *testing.T) {
	ctx := context.Background()
	for _, outcome := range []string{"succeeded", "retryable-failure", "permanent-failure", "unknown"} {
		t.Run(outcome, func(t *testing.T) {
			respond := func(map[string]any) map[string]any { return map[string]any{"outcome": outcome, "error": "detail"} }
			direct := NewHTTPClient(startDirectUpstream(t, &upstream{respond: respond}).URL, nil)
			gateway := NewGatewayClient(startGatewayUpstream(t, &upstream{respond: respond}, nil).URL, nil)
			fromDirect, err := direct.Execute(ctx, attempt())
			if err != nil {
				t.Fatalf("direct: %v", err)
			}
			fromGateway, err := gateway.Execute(ctx, attempt())
			if err != nil {
				t.Fatalf("gateway: %v", err)
			}
			if fromDirect.Outcome != fromGateway.Outcome || fromDirect.Outcome != model.OperationOutcome(outcome) {
				t.Fatalf("outcome %s: direct=%s gateway=%s", outcome, fromDirect.Outcome, fromGateway.Outcome)
			}
		})
	}
}

// A refusal is decided before dispatch. It has to reach the Coordinator as a
// classified outcome rather than as a transport error, because the Coordinator's
// retry and cancellation logic branches on the outcome vocabulary alone.
func TestGatewayRefusalsMapOntoTheExecutorVocabulary(t *testing.T) {
	ctx := context.Background()
	cases := map[string]model.OperationOutcome{
		"unknown-tool-view":        model.OutcomePermanentFailure,
		"unknown-tool":             model.OutcomePermanentFailure,
		"version-absent-from-view": model.OutcomePermanentFailure,
		"schema-violation":         model.OutcomePermanentFailure,
		"route-unhealthy":          model.OutcomeRetryableFailure,
	}
	for reason, want := range cases {
		t.Run(reason, func(t *testing.T) {
			service := &upstream{respond: succeeding}
			refusal := map[string]any{"code": -32000, "message": "refused", "data": map[string]any{"reason": reason}}
			gateway := NewGatewayClient(startGatewayUpstream(t, service, refusal).URL, nil)
			response, err := gateway.Execute(ctx, attempt())
			if err != nil {
				t.Fatalf("%s was reported as a transport error: %v", reason, err)
			}
			if response.Outcome != want {
				t.Fatalf("%s mapped to %s, want %s", reason, response.Outcome, want)
			}
			if service.count() != 0 {
				t.Fatalf("%s reached the tool service %d times; a refusal is decided before dispatch", reason, service.count())
			}
		})
	}
}

// An unrecognised refusal means the gateway and the Coordinator disagree about
// the protocol. Failing loudly beats inventing a classification for it.
func TestAnUnknownRefusalIsAnError(t *testing.T) {
	refusal := map[string]any{"code": -32000, "message": "refused", "data": map[string]any{"reason": "some-future-reason"}}
	gateway := NewGatewayClient(startGatewayUpstream(t, &upstream{respond: succeeding}, refusal).URL, nil)
	if _, err := gateway.Execute(context.Background(), attempt()); err == nil {
		t.Fatal("an unrecognised refusal was silently classified")
	}
}

// The gateway route must send one request and never a second: whether an
// operation may be attempted again is the Coordinator's decision.
func TestTheGatewayRouteSendsExactlyOneRequestPerAttempt(t *testing.T) {
	service := &upstream{respond: func(map[string]any) map[string]any {
		return map[string]any{"outcome": "retryable-failure", "error": "busy"}
	}}
	gateway := NewGatewayClient(startGatewayUpstream(t, service, nil).URL, nil)
	if _, err := gateway.Execute(context.Background(), attempt()); err != nil {
		t.Fatalf("gateway: %v", err)
	}
	if service.count() != 1 {
		t.Fatalf("a retryable failure produced %d upstream calls, want 1", service.count())
	}
}
