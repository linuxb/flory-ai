package authn

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// testIssuer is a local OIDC provider whose discovery document and key set a test can spoil one
// field at a time, so each refusal the verifier makes is reached by exactly one broken input.
type testIssuer struct {
	server     *httptest.Server
	private    *rsa.PrivateKey
	discovered func(issuer string) map[string]string
	keys       func() (int, jose.JSONWebKeySet)
	expires    string
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	issuer := &testIssuer{private: private}
	issuer.discovered = func(url string) map[string]string { return map[string]string{"issuer": url, "jwks_uri": url + "/keys"} }
	issuer.keys = func() (int, jose.JSONWebKeySet) {
		return http.StatusOK, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &private.PublicKey, KeyID: "key-1", Algorithm: "RS256", Use: "sig"}}}
	}
	issuer.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(issuer.discovered(issuer.server.URL))
		case "/keys":
			status, keys := issuer.keys()
			if issuer.expires != "" {
				writer.Header().Set("Expires", issuer.expires)
			}
			writer.WriteHeader(status)
			_ = json.NewEncoder(writer).Encode(keys)
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(issuer.server.Close)
	return issuer
}

func (issuer *testIssuer) verifier(t *testing.T) *OIDCVerifier {
	t.Helper()
	verifier, err := NewOIDCVerifier(context.Background(), OIDCConfig{Issuer: issuer.server.URL, Audience: "flory-gateway", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	return verifier
}

// token signs claims with the issuer's key under kid; the defaults are a valid token for alice.
func (issuer *testIssuer) token(t *testing.T, kid string, key *rsa.PrivateKey, edit func(*jwt.Claims)) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: kid}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	claims := jwt.Claims{Issuer: issuer.server.URL, Subject: "alice", Audience: jwt.Audience{"flory-gateway"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute))}
	if edit != nil {
		edit(&claims)
	}
	encoded, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestOIDCVerifierRefusesAConfigurationItCannotTrust(t *testing.T) {
	issuer := newTestIssuer(t)
	cases := map[string]OIDCConfig{
		"no issuer":                         {Audience: "flory-gateway"},
		"no audience":                       {Issuer: issuer.server.URL},
		"plain HTTP when it is not allowed": {Issuer: issuer.server.URL, Audience: "flory-gateway"},
		"a relative issuer":                 {Issuer: "/realms/flory", Audience: "flory-gateway", AllowInsecureHTTP: true},
		"an unreachable issuer":             {Issuer: "http://127.0.0.1:1", Audience: "flory-gateway", AllowInsecureHTTP: true},
	}
	for name, config := range cases {
		if _, err := NewOIDCVerifier(context.Background(), config); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestOIDCVerifierRefusesADiscoveryItCannotTrust(t *testing.T) {
	cases := map[string]func(*testIssuer){
		"a discovery document for another issuer": func(issuer *testIssuer) {
			issuer.discovered = func(url string) map[string]string {
				return map[string]string{"issuer": url + "/other", "jwks_uri": url + "/keys"}
			}
		},
		"a key set on a scheme that is not allowed": func(issuer *testIssuer) {
			issuer.discovered = func(url string) map[string]string {
				return map[string]string{"issuer": url, "jwks_uri": strings.Replace(url, "http://", "ftp://", 1) + "/keys"}
			}
		},
		"a relative key-set address": func(issuer *testIssuer) {
			issuer.discovered = func(url string) map[string]string { return map[string]string{"issuer": url, "jwks_uri": "/keys"} }
		},
		"a key set that fails to load": func(issuer *testIssuer) {
			issuer.keys = func() (int, jose.JSONWebKeySet) { return http.StatusInternalServerError, jose.JSONWebKeySet{} }
		},
		"an empty key set": func(issuer *testIssuer) {
			issuer.keys = func() (int, jose.JSONWebKeySet) { return http.StatusOK, jose.JSONWebKeySet{} }
		},
	}
	for name, spoil := range cases {
		issuer := newTestIssuer(t)
		spoil(issuer)
		config := OIDCConfig{Issuer: issuer.server.URL, Audience: "flory-gateway", AllowInsecureHTTP: true}
		if _, err := NewOIDCVerifier(context.Background(), config); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestOIDCVerifierRefusesATokenItCannotTrust(t *testing.T) {
	issuer := newTestIssuer(t)
	verifier := issuer.verifier(t)
	impostor, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"a malformed token":             "not.a.jwt",
		"a token under an unknown kid":  issuer.token(t, "key-2", issuer.private, nil),
		"a token signed by another key": issuer.token(t, "key-1", impostor, nil),
		"a token with no subject":       issuer.token(t, "key-1", issuer.private, func(claims *jwt.Claims) { claims.Subject = "" }),
		"a token with no expiry":        issuer.token(t, "key-1", issuer.private, func(claims *jwt.Claims) { claims.Expiry = nil }),
		"a token for another audience":  issuer.token(t, "key-1", issuer.private, func(claims *jwt.Claims) { claims.Audience = jwt.Audience{"someone-else"} }),
		"an expired token": issuer.token(t, "key-1", issuer.private, func(claims *jwt.Claims) {
			claims.Expiry = jwt.NewNumericDate(time.Now().Add(-time.Hour))
		}),
	}
	for name, token := range cases {
		if principal, err := verifier.Verify(context.Background(), token); err == nil {
			t.Fatalf("%s was accepted as %+v", name, principal)
		}
	}
	if principal, err := verifier.Verify(context.Background(), issuer.token(t, "key-1", issuer.private, nil)); err != nil || principal.Subject != "alice" {
		t.Fatalf("a valid token was refused: %+v %v", principal, err)
	}
}

// A key set that dies during a refresh leaves the verifier refusing, not trusting a stale answer.
func TestOIDCVerifierRefusesWhenTheKeySetRefreshFails(t *testing.T) {
	issuer := newTestIssuer(t)
	verifier := issuer.verifier(t)
	issuer.keys = func() (int, jose.JSONWebKeySet) { return http.StatusServiceUnavailable, jose.JSONWebKeySet{} }
	if _, err := verifier.Verify(context.Background(), issuer.token(t, "key-2", issuer.private, nil)); err == nil || !strings.Contains(err.Error(), "load JWKS") {
		t.Fatalf("a failed refresh was not reported: %v", err)
	}
}

func TestCacheDurationFollowsTheKeySetsOwnFreshness(t *testing.T) {
	header := func(name, value string) *http.Response {
		response := &http.Response{Header: http.Header{}}
		response.Header.Set(name, value)
		return response
	}
	if got := cacheDuration(header("Cache-Control", "public, max-age=90"), time.Minute); got != 90*time.Second {
		t.Fatalf("max-age gave %s", got)
	}
	expires := time.Now().Add(2 * time.Hour).UTC().Format(http.TimeFormat)
	if got := cacheDuration(header("Expires", expires), time.Minute); got < time.Hour || got > 2*time.Hour {
		t.Fatalf("Expires gave %s", got)
	}
	// A date already past is no freshness at all, so the configured default applies.
	if got := cacheDuration(header("Expires", "Mon, 01 Jan 2001 00:00:00 GMT"), time.Minute); got != time.Minute {
		t.Fatalf("a past Expires gave %s", got)
	}
	if got := cacheDuration(header("Cache-Control", "max-age=soon"), time.Minute); got != time.Minute {
		t.Fatalf("an unreadable max-age gave %s", got)
	}
}

func TestOIDCVerifierHonoursTheKeySetsExpiresHeader(t *testing.T) {
	issuer := newTestIssuer(t)
	issuer.expires = time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)
	verifier := issuer.verifier(t)
	if remaining := time.Until(verifier.expires); remaining < 50*time.Minute {
		t.Fatalf("the key set expires in %s, want about an hour", remaining)
	}
}
