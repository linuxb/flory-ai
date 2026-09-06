package authn

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestOIDCVerifierIgnoresBusinessRoleClaims(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(map[string]string{"issuer": issuer, "jwks_uri": issuer + "/keys"})
		case "/keys":
			writer.Header().Set("Cache-Control", "max-age=60")
			_ = json.NewEncoder(writer).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &private.PublicKey, KeyID: "key-1", Algorithm: "RS256", Use: "sig"}}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	issuer = server.URL
	verifier, err := NewOIDCVerifier(context.Background(), OIDCConfig{Issuer: issuer, Audience: "flory-gateway", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: private, KeyID: "key-1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: issuer, Subject: "alice", Audience: jwt.Audience{"flory-gateway"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute))}).
		Claims(map[string]any{"roles": []string{"forged-admin"}, "groups": []string{"root"}}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	principal, err := verifier.Verify(context.Background(), encoded)
	if err != nil {
		t.Fatal(err)
	}
	if principal.Subject != "alice" || len(principal.Roles) != 0 {
		t.Fatalf("role claims leaked into principal: %+v", principal)
	}
}

func TestOIDCVerifierRefreshesOnceForUnknownKey(t *testing.T) {
	first, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	second, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	current := jose.JSONWebKey{Key: &first.PublicKey, KeyID: "key-1", Algorithm: "RS256", Use: "sig"}
	keyRequests := 0
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(map[string]string{"issuer": issuer, "jwks_uri": issuer + "/keys"})
		case "/keys":
			keyRequests++
			writer.Header().Set("Cache-Control", "max-age=60")
			_ = json.NewEncoder(writer).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{current}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	issuer = server.URL
	verifier, err := NewOIDCVerifier(context.Background(), OIDCConfig{Issuer: issuer, Audience: "flory-gateway", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	current = jose.JSONWebKey{Key: &second.PublicKey, KeyID: "key-2", Algorithm: "RS256", Use: "sig"}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: second, KeyID: "key-2"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: issuer, Subject: "alice", Audience: jwt.Audience{"flory-gateway"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute))}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(context.Background(), encoded); err != nil {
		t.Fatal(err)
	}
	if keyRequests != 2 {
		t.Fatalf("JWKS requests=%d, want initial load plus one refresh", keyRequests)
	}
}

func TestOIDCVerifierRejectsStaleKeysWhenRefreshFails(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	failRefresh := false
	var issuer string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(writer).Encode(map[string]string{"issuer": issuer, "jwks_uri": issuer + "/keys"})
		case "/keys":
			if failRefresh {
				http.Error(writer, "unavailable", http.StatusServiceUnavailable)
				return
			}
			writer.Header().Set("Cache-Control", "max-age=0")
			_ = json.NewEncoder(writer).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &private.PublicKey, KeyID: "key-1", Algorithm: "RS256", Use: "sig"}}})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	issuer = server.URL
	verifier, err := NewOIDCVerifier(context.Background(), OIDCConfig{Issuer: issuer, Audience: "flory-gateway", AllowInsecureHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	failRefresh = true
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: private, KeyID: "key-1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: issuer, Subject: "alice", Audience: jwt.Audience{"flory-gateway"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute))}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(context.Background(), encoded); err == nil {
		t.Fatal("stale JWKS was accepted after refresh failed")
	}
}
