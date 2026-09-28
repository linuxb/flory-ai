package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/linuxb/flory-ai/coordinator/internal/model"
)

func respondWith(status int, body string) roundTripFunc {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	}
}

func unreachable(*http.Request) (*http.Response, error) {
	return nil, errors.New("connection refused")
}

// Every one of these is a reply the Coordinator cannot classify. Each must come back as an error,
// never as an outcome: an outcome invented here would be appended to the log as if a tool had
// reported it, and a retry or a compensation would then be decided on something nobody said.
func TestEitherRouteRefusesToClassifyWhatItCannotRead(t *testing.T) {
	cases := []struct {
		name      string
		transport roundTripFunc
		want      string
	}{
		{name: "the transport fails", transport: unreachable, want: "connection refused"},
		{name: "the status is not 200", transport: respondWith(http.StatusBadGateway, `{}`), want: "HTTP 502"},
		{name: "the body is not JSON", transport: respondWith(http.StatusOK, `not json`), want: "invalid character"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &http.Client{Transport: testCase.transport}
			for route, adapter := range map[string]Client{"direct": NewHTTPClient("http://adapter.test", client), "gateway": NewGatewayClient("http://gateway.test", client)} {
				response, err := adapter.Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve", Input: map[string]any{}})
				if err == nil || !strings.Contains(err.Error(), testCase.want) {
					t.Fatalf("%s route: got %+v, %v; want an error containing %q", route, response, err, testCase.want)
				}
			}
		})
	}
}

func TestTheDirectRouteRejectsAnOutcomeOutsideTheVocabulary(t *testing.T) {
	client := &http.Client{Transport: respondWith(http.StatusOK, `{"outcome":"maybe"}`)}
	if _, err := NewHTTPClient("http://adapter.test", client).Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve"}); err == nil {
		t.Fatal("an unknown outcome was accepted")
	}
}

func TestTheGatewayRouteRejectsAnOutcomeOutsideTheVocabulary(t *testing.T) {
	client := &http.Client{Transport: respondWith(http.StatusOK, `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"outcome":"maybe"}}}`)}
	_, err := NewGatewayClient("http://gateway.test", client).Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve"})
	if err == nil || !strings.Contains(err.Error(), `unknown outcome "maybe"`) {
		t.Fatalf("an unknown outcome was accepted: %v", err)
	}
}

func TestTheGatewayRouteRejectsAReplyWithNeitherResultNorError(t *testing.T) {
	client := &http.Client{Transport: respondWith(http.StatusOK, `{"jsonrpc":"2.0","id":1}`)}
	_, err := NewGatewayClient("http://gateway.test", client).Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve"})
	if err == nil || !strings.Contains(err.Error(), "neither a result nor an error") {
		t.Fatalf("an empty reply was accepted: %v", err)
	}
}

// Nothing is sent when the request itself cannot be built, so there is no attempt to reconcile.
func TestNeitherRouteSendsARequestItCannotBuild(t *testing.T) {
	sent := false
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		sent = true
		return nil, errors.New("unexpected send")
	})}
	unencodable := map[string]any{"callback": func() {}}
	cases := []struct {
		name    string
		adapter Client
		request model.OperationRequest
	}{
		{name: "direct input", adapter: NewHTTPClient("http://adapter.test", client), request: model.OperationRequest{Input: unencodable}},
		{name: "direct URL", adapter: NewHTTPClient("http://adapter.test\x7f", client), request: model.OperationRequest{}},
		{name: "gateway input", adapter: NewGatewayClient("http://gateway.test", client), request: model.OperationRequest{Input: unencodable}},
		{name: "gateway URL", adapter: NewGatewayClient("http://gateway.test\x7f", client), request: model.OperationRequest{}},
		{name: "gateway identity", adapter: NewGatewayClient("http://gateway.test", client), request: model.OperationRequest{AuthorizationIdentity: unencodable}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := testCase.adapter.Execute(context.Background(), testCase.request); err == nil {
				t.Fatal("an unbuildable request did not fail")
			}
			if sent {
				t.Fatal("an unbuildable request was sent")
			}
		})
	}
}

// A call with no input still sends an arguments object: MCP requires one, and a JSON null would
// fail the gateway's schema check for a reason that has nothing to do with the tool.
func TestTheGatewayRouteSendsAnEmptyArgumentsObjectForNoInput(t *testing.T) {
	var arguments json.RawMessage
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var envelope struct {
			Params struct {
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		arguments = envelope.Params.Arguments
		body := `{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"outcome":"succeeded"}}}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader([]byte(body))), Header: make(http.Header)}, nil
	})}
	if _, err := NewGatewayClient("http://gateway.test", client).Execute(context.Background(), model.OperationRequest{Tool: "inventory.reserve"}); err != nil {
		t.Fatal(err)
	}
	if string(arguments) != "{}" {
		t.Fatalf("arguments=%s, want {}", arguments)
	}
}
