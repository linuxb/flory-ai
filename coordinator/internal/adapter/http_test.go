package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

func TestHTTPClientUsesStableExecuteContract(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/execute" {
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
		var operation model.OperationRequest
		if err := json.NewDecoder(request.Body).Decode(&operation); err != nil {
			t.Fatal(err)
		}
		if operation.IdempotencyKey != "key-1" {
			t.Fatalf("unexpected key %s", operation.IdempotencyKey)
		}
		body, _ := json.Marshal(model.OperationResponse{Outcome: model.OutcomeSucceeded, Result: map[string]any{"ok": true}})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})
	client := &http.Client{Transport: transport}
	response, err := NewHTTPClient("http://adapter.test", client).Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve", IdempotencyKey: "key-1", Input: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if response.Outcome != model.OutcomeSucceeded {
		t.Fatalf("unexpected outcome %s", response.Outcome)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
