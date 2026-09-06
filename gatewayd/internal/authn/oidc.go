package authn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"golang.org/x/sync/singleflight"
)

// OIDCConfig configures identity-only OIDC verification.
type OIDCConfig struct {
	Issuer            string
	Audience          string
	AllowedAlgorithms []jose.SignatureAlgorithm
	AllowInsecureHTTP bool
	DefaultJWKSCache  time.Duration
	HTTPClient        *http.Client
}

type discoveryDocument struct {
	Issuer  string `json:"issuer"`
	JWKSURI string `json:"jwks_uri"`
}

// OIDCVerifier verifies only identity claims. Business-role claims are never decoded.
type OIDCVerifier struct {
	config  OIDCConfig
	jwksURI string
	mutex   sync.RWMutex
	keys    jose.JSONWebKeySet
	expires time.Time
	refresh singleflight.Group
}

// NewOIDCVerifier performs discovery and loads the initial JWKS.
func NewOIDCVerifier(ctx context.Context, config OIDCConfig) (*OIDCVerifier, error) {
	if config.Issuer == "" || config.Audience == "" {
		return nil, errors.New("authn: OIDC issuer and audience are required")
	}
	if len(config.AllowedAlgorithms) == 0 {
		config.AllowedAlgorithms = []jose.SignatureAlgorithm{jose.RS256}
	}
	if config.DefaultJWKSCache <= 0 {
		config.DefaultJWKSCache = 5 * time.Minute
	}
	if config.HTTPClient == nil {
		config.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	issuer, err := url.Parse(config.Issuer)
	if err != nil || issuer.Host == "" || (issuer.Scheme != "https" && !(config.AllowInsecureHTTP && issuer.Scheme == "http")) {
		return nil, errors.New("authn: OIDC issuer must be an allowed absolute URL")
	}
	discoveryURL := strings.TrimRight(config.Issuer, "/") + "/.well-known/openid-configuration"
	var document discoveryDocument
	if _, err := getJSON(ctx, config.HTTPClient, discoveryURL, &document); err != nil {
		return nil, fmt.Errorf("authn: OIDC discovery: %w", err)
	}
	if document.Issuer != config.Issuer {
		return nil, fmt.Errorf("authn: discovered issuer %q does not match %q", document.Issuer, config.Issuer)
	}
	jwksURL, err := url.Parse(document.JWKSURI)
	if err != nil || jwksURL.Host == "" || (jwksURL.Scheme != "https" && !(config.AllowInsecureHTTP && jwksURL.Scheme == "http")) {
		return nil, errors.New("authn: jwks_uri must be an allowed absolute URL")
	}
	verifier := &OIDCVerifier{config: config, jwksURI: document.JWKSURI}
	if err := verifier.loadKeys(ctx); err != nil {
		return nil, err
	}
	return verifier, nil
}

func getJSON(ctx context.Context, client *http.Client, endpoint string, destination any) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return response, fmt.Errorf("%s returned HTTP %d", endpoint, response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(destination); err != nil {
		return response, err
	}
	return response, nil
}

func cacheDuration(response *http.Response, fallback time.Duration) time.Duration {
	for _, directive := range strings.Split(response.Header.Get("Cache-Control"), ",") {
		directive = strings.TrimSpace(directive)
		if strings.HasPrefix(directive, "max-age=") {
			if duration, err := time.ParseDuration(strings.TrimPrefix(directive, "max-age=") + "s"); err == nil {
				return duration
			}
		}
	}
	if expires, err := http.ParseTime(response.Header.Get("Expires")); err == nil {
		if duration := time.Until(expires); duration > 0 {
			return duration
		}
	}
	return fallback
}

func (verifier *OIDCVerifier) loadKeys(ctx context.Context) error {
	var keys jose.JSONWebKeySet
	response, err := getJSON(ctx, verifier.config.HTTPClient, verifier.jwksURI, &keys)
	if err != nil {
		return fmt.Errorf("authn: load JWKS: %w", err)
	}
	if len(keys.Keys) == 0 {
		return errors.New("authn: JWKS contains no keys")
	}
	verifier.mutex.Lock()
	verifier.keys, verifier.expires = keys, time.Now().Add(cacheDuration(response, verifier.config.DefaultJWKSCache))
	verifier.mutex.Unlock()
	return nil
}

func (verifier *OIDCVerifier) key(ctx context.Context, kid string) (jose.JSONWebKey, error) {
	verifier.mutex.RLock()
	keys, fresh := verifier.keys.Key(kid), time.Now().Before(verifier.expires)
	verifier.mutex.RUnlock()
	if len(keys) == 1 && fresh {
		return keys[0], nil
	}
	_, err, _ := verifier.refresh.Do("jwks", func() (any, error) { return nil, verifier.loadKeys(ctx) })
	if err != nil {
		return jose.JSONWebKey{}, err
	}
	verifier.mutex.RLock()
	defer verifier.mutex.RUnlock()
	keys = verifier.keys.Key(kid)
	if len(keys) != 1 {
		return jose.JSONWebKey{}, fmt.Errorf("authn: no unique JWKS key for kid %q", kid)
	}
	return keys[0], nil
}

// Verify validates an OIDC JWT and returns only issuer and subject.
func (verifier *OIDCVerifier) Verify(ctx context.Context, encoded string) (Principal, error) {
	token, err := jwt.ParseSigned(encoded, verifier.config.AllowedAlgorithms)
	if err != nil || len(token.Headers) != 1 || token.Headers[0].KeyID == "" {
		return Principal{}, errors.New("authn: malformed signed JWT")
	}
	key, err := verifier.key(ctx, token.Headers[0].KeyID)
	if err != nil {
		return Principal{}, err
	}
	var claims jwt.Claims
	if err := token.Claims(key.Key, &claims); err != nil {
		return Principal{}, errors.New("authn: JWT signature verification failed")
	}
	if claims.Subject == "" || claims.Expiry == nil {
		return Principal{}, errors.New("authn: JWT requires sub and exp")
	}
	if err := claims.ValidateWithLeeway(jwt.Expected{Issuer: verifier.config.Issuer, AnyAudience: jwt.Audience{verifier.config.Audience}, Time: time.Now()}, 30*time.Second); err != nil {
		return Principal{}, fmt.Errorf("authn: invalid JWT claims: %w", err)
	}
	return Principal{Issuer: claims.Issuer, Subject: claims.Subject, Source: "bearer"}, nil
}
