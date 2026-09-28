package mcp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// failingBody is a request body whose connection drops before any of it arrives.
type failingBody struct{}

func (failingBody) Read([]byte) (int, error) { return 0, errors.New("connection reset") }
func (failingBody) Close() error             { return nil }

// A request is refused as a parse error when it cannot be read or is not JSON, and as an invalid
// request when it is JSON but not a JSON-RPC 2.0 call: the caller can tell a broken transport from
// a client that speaks the wrong protocol.
func TestReadRequestDistinguishesUnreadableFromMalformed(t *testing.T) {
	cases := []struct {
		name string
		body func() *http.Request
		code int
	}{
		{name: "an unreadable body", code: codeParseError, body: func() *http.Request {
			request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			request.Body = failingBody{}
			return request
		}},
		{name: "a body that is not JSON", code: codeParseError, body: func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{"))
		}},
		{name: "another JSON-RPC version", code: codeInvalidRequest, body: func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"1.0","id":1,"method":"tools/list"}`))
		}},
		{name: "no method", code: codeInvalidRequest, body: func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1}`))
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, failure := readRequest(testCase.body())
			if failure == nil || failure.Code != testCase.code || failure.Error() != failure.Message {
				t.Fatalf("failure=%+v, want code %d", failure, testCase.code)
			}
		})
	}
	parsed, failure := readRequest(httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)))
	if failure != nil || parsed.Method != "tools/list" || string(parsed.ID) != "7" {
		t.Fatalf("parsed=%+v failure=%v", parsed, failure)
	}
}

func TestErrorConstructorsCarryTheirJSONRPCCodes(t *testing.T) {
	if failure := invalidParams("missing %s", "name"); failure.Code != codeInvalidParams || failure.Message != "missing name" {
		t.Fatalf("invalid params=%+v", failure)
	}
	if failure := internalError("store %s", "down"); failure.Code != codeInternalError || failure.Message != "store down" {
		t.Fatalf("internal error=%+v", failure)
	}
}
