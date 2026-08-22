// Package adapter implements business-operation adapter clients.
package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

// Client executes one idempotent business operation.
type Client interface {
	Execute(context.Context, model.OperationRequest) (model.OperationResponse, error)
}

// HTTPClient calls an out-of-process JSON adapter.
type HTTPClient struct {
	baseURL string
	client  *http.Client
}

// NewHTTPClient creates an adapter client using the supplied HTTP transport.
func NewHTTPClient(baseURL string, client *http.Client) *HTTPClient {
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPClient{baseURL: strings.TrimRight(baseURL, "/"), client: client}
}

// Execute calls POST /v1/execute and rejects malformed outcomes.
func (client *HTTPClient) Execute(ctx context.Context, request model.OperationRequest) (model.OperationResponse, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return model.OperationResponse{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/v1/execute", bytes.NewReader(body))
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
		return model.OperationResponse{}, fmt.Errorf("adapter returned HTTP %d", response.StatusCode)
	}
	var result model.OperationResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return model.OperationResponse{}, err
	}
	switch result.Outcome {
	case model.OutcomeSucceeded, model.OutcomeRetryableFailure, model.OutcomePermanentFailure, model.OutcomeUnknown:
		return result, nil
	default:
		return model.OperationResponse{}, fmt.Errorf("adapter returned unknown outcome %q", result.Outcome)
	}
}
