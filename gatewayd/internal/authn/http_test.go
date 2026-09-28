package authn

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
)

const coordinatorSPIFFEID = "spiffe://flory.local/coordinator"

// withClientCertificate presents a verified client certificate carrying uris as its URI SANs, as
// the TLS layer would once the handshake has succeeded.
func withClientCertificate(request *http.Request, uris ...string) *http.Request {
	certificate := &x509.Certificate{}
	for _, raw := range uris {
		parsed, err := url.Parse(raw)
		if err != nil {
			panic(err)
		}
		certificate.URIs = append(certificate.URIs, parsed)
	}
	request.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}}
	return request
}

func TestSPIFFEIDRequiresExactlyOneSPIFFEURI(t *testing.T) {
	plain := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := SPIFFEID(plain); err == nil {
		t.Fatal("a request without a client certificate was given an identity")
	}
	for name, uris := range map[string][]string{
		"no URI SAN":        nil,
		"two URI SANs":      {coordinatorSPIFFEID, "spiffe://flory.local/other"},
		"a non-SPIFFE URI":  {"https://flory.local/coordinator"},
		"an empty identity": {},
	} {
		if identity, err := SPIFFEID(withClientCertificate(httptest.NewRequest(http.MethodGet, "/", nil), uris...)); err == nil {
			t.Fatalf("%s gave identity %q", name, identity)
		}
	}
	identity, err := SPIFFEID(withClientCertificate(httptest.NewRequest(http.MethodGet, "/", nil), coordinatorSPIFFEID))
	if err != nil || identity != coordinatorSPIFFEID {
		t.Fatalf("identity=%q err=%v", identity, err)
	}
}

func TestWorkflowIdentityRoundTripsThroughItsHeaderEncoding(t *testing.T) {
	identity := WorkflowIdentity{Version: "1", KeyID: "key", Issuer: "https://issuer.example", Subject: "alice", Roles: []string{"operator"}, RunID: "run-1"}
	encoded, err := EncodeWorkflowIdentity(identity)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(encoded, "+/=") {
		t.Fatalf("encoding %q is not header-safe base64url", encoded)
	}
	decoded, err := decodeWorkflowIdentity(encoded)
	if err != nil || decoded.Subject != "alice" || decoded.RunID != "run-1" || len(decoded.Roles) != 1 {
		t.Fatalf("decoded=%+v err=%v", decoded, err)
	}
	if _, err := decodeWorkflowIdentity("not base64!"); err == nil {
		t.Fatal("malformed base64 was decoded")
	}
	if _, err := decodeWorkflowIdentity("bm90IGpzb24"); err == nil {
		t.Fatal("base64 that is not JSON was decoded")
	}
}

type middlewareFixture struct {
	signer     *Signer
	middleware *Middleware
	reached    *Principal
	handler    http.Handler
}

func newMiddlewareFixture(t *testing.T) *middlewareFixture {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner("key-1", private, nil)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &middlewareFixture{signer: signer, middleware: &Middleware{Signer: signer, InternalSPIFFEIDs: map[string]bool{coordinatorSPIFFEID: true}}}
	fixture.handler = fixture.middleware.Handler(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		principal, ok := PrincipalFrom(request.Context())
		if !ok {
			t.Fatal("the protected handler was reached without a principal")
		}
		fixture.reached = &principal
		writer.WriteHeader(http.StatusNoContent)
	}))
	return fixture
}

func (fixture *middlewareFixture) issue(t *testing.T) string {
	t.Helper()
	identity, err := fixture.signer.Issue(Principal{Issuer: "https://issuer.example", Subject: "alice", Roles: []string{"operator"}, Revision: 3, Source: "bearer"}, "run-1")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeWorkflowIdentity(identity)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func (fixture *middlewareFixture) serve(request *http.Request) *httptest.ResponseRecorder {
	fixture.reached = nil
	recorder := httptest.NewRecorder()
	fixture.handler.ServeHTTP(recorder, request)
	return recorder
}

func TestMiddlewareAdmitsASignedWorkflowIdentityFromAnInternalService(t *testing.T) {
	fixture := newMiddlewareFixture(t)
	request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID)
	request.Header.Set(IdentityHeader, fixture.issue(t))
	if recorder := fixture.serve(request); recorder.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body)
	}
	// The roles come from the signed snapshot, frozen when the run started, and the caller is the
	// service that presented it.
	principal := fixture.reached
	if principal == nil || principal.Source != "workflow" || principal.Subject != "alice" || principal.RunID != "run-1" || principal.SPIFFEID != coordinatorSPIFFEID ||
		principal.Revision != 3 || !Allows(principal.Roles, []string{"operator"}) {
		t.Fatalf("principal=%+v", principal)
	}
}

// Every refusal is a 401 with a JSON reason, and the protected handler never runs.
func TestMiddlewareRefusesEveryRequestItCannotAuthenticate(t *testing.T) {
	fixture := newMiddlewareFixture(t)
	valid := fixture.issue(t)
	tampered := func() string {
		raw, err := decodeWorkflowIdentity(valid)
		if err != nil {
			t.Fatal(err)
		}
		raw.Subject = "mallory"
		encoded, err := EncodeWorkflowIdentity(raw)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}()
	cases := []struct {
		name    string
		request func() *http.Request
		reason  string
	}{
		{name: "no credentials", reason: "authentication is required", request: func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/mcp", nil)
		}},
		{name: "both a bearer token and a workflow identity", reason: "mutually exclusive", request: func() *http.Request {
			request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID)
			request.Header.Set("Authorization", "Bearer token")
			request.Header.Set(IdentityHeader, valid)
			return request
		}},
		{name: "a bearer token with no OIDC configured", reason: "OIDC authentication is unavailable", request: func() *http.Request {
			request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			request.Header.Set("Authorization", "Bearer token")
			return request
		}},
		{name: "a workflow identity without a client certificate", reason: "not authorised", request: func() *http.Request {
			request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			request.Header.Set(IdentityHeader, valid)
			return request
		}},
		{name: "a workflow identity from a service that may not present one", reason: "not authorised", request: func() *http.Request {
			request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), "spiffe://flory.local/tool-service")
			request.Header.Set(IdentityHeader, valid)
			return request
		}},
		{name: "a malformed workflow identity", reason: "malformed workflow identity", request: func() *http.Request {
			request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID)
			request.Header.Set(IdentityHeader, "%%%")
			return request
		}},
		{name: "a tampered workflow identity", reason: "invalid workflow identity", request: func() *http.Request {
			request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID)
			request.Header.Set(IdentityHeader, tampered)
			return request
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := fixture.serve(testCase.request())
			if recorder.Code != http.StatusUnauthorized || recorder.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("status=%d content-type=%q", recorder.Code, recorder.Header().Get("Content-Type"))
			}
			var body map[string]string
			if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil || !strings.Contains(body["error"], testCase.reason) {
				t.Fatalf("body=%v err=%v, want a reason containing %q", body, err, testCase.reason)
			}
			if fixture.reached != nil {
				t.Fatalf("the protected handler ran for %+v", fixture.reached)
			}
		})
	}
}

func TestMiddlewareRefusesAWorkflowIdentityWhenNoSignerIsConfigured(t *testing.T) {
	fixture := newMiddlewareFixture(t)
	valid := fixture.issue(t)
	fixture.middleware.Signer = nil
	request := withClientCertificate(httptest.NewRequest(http.MethodPost, "/mcp", nil), coordinatorSPIFFEID)
	request.Header.Set(IdentityHeader, valid)
	if recorder := fixture.serve(request); recorder.Code != http.StatusUnauthorized || !strings.Contains(recorder.Body.String(), "unavailable") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body)
	}
}

// A bearer token is verified before any role is looked up, so an invalid one is refused without
// the role store ever being consulted.
func TestMiddlewareRefusesAnInvalidBearerTokenBeforeLookingUpRoles(t *testing.T) {
	issuer := newTestIssuer(t)
	fixture := newMiddlewareFixture(t)
	fixture.middleware.OIDC = issuer.verifier(t)
	fixture.middleware.Roles = &rbac.Store{}
	for name, token := range map[string]string{
		"a malformed token": "not.a.jwt",
		"an expired token": issuer.token(t, "key-1", issuer.private, func(claims *jwt.Claims) {
			claims.Expiry = jwt.NewNumericDate(time.Now().Add(-time.Hour))
		}),
	} {
		request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		if recorder := fixture.serve(request); recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status=%d body=%s", name, recorder.Code, recorder.Body)
		}
	}
}
