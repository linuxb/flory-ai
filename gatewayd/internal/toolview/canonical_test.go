package toolview

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestCanonicalSortsKeysRegardlessOfInputOrder(t *testing.T) {
	first := map[string]any{"beta": 1, "alpha": map[string]any{"z": true, "a": false}}
	second := map[string]any{"alpha": map[string]any{"a": false, "z": true}, "beta": 1}
	left, err := Canonical(first)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	right, err := Canonical(second)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if string(left) != string(right) {
		t.Fatalf("key order changed the encoding: %s vs %s", left, right)
	}
	if want := `{"alpha":{"a":false,"z":true},"beta":1}`; string(left) != want {
		t.Fatalf("encoding = %s, want %s", left, want)
	}
}

func TestCanonicalPreservesArrayOrder(t *testing.T) {
	encoded, err := Canonical([]any{"b", "a", "c"})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if want := `["b","a","c"]`; string(encoded) != want {
		t.Fatalf("encoding = %s, want %s", encoded, want)
	}
}

// Embedded JSON reaches the encoder as raw text -- a registered schema is stored
// verbatim -- so the rejection has to hold on the text, not on a Go float that
// has already lost the spelling it arrived with.
func TestCanonicalRejectsNonIntegerNumbers(t *testing.T) {
	for _, text := range []string{`{"multiplier":1.5}`, `{"multiplier":1e2}`, `{"multiplier":100.0}`} {
		if _, err := Canonical(json.RawMessage(text)); err == nil {
			t.Fatalf("%s was accepted; a float has no canonical text form", text)
		}
	}
}

func TestCanonicalDoesNotEscapeHTMLCharacters(t *testing.T) {
	encoded, err := Canonical(map[string]any{"description": "quantity < 10 & rising"})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if !strings.Contains(string(encoded), `<`) {
		t.Fatalf("encoding escaped an angle bracket, so the digest would depend on it: %s", encoded)
	}
	if want := `{"description":"quantity < 10 & rising"}`; string(encoded) != want {
		t.Fatalf("encoding = %s, want %s", encoded, want)
	}
}

func TestCanonicalEscapesControlCharacters(t *testing.T) {
	encoded, err := Canonical(map[string]any{"detail": "line\nnext"})
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if want := `{"detail":"line\nnext"}`; string(encoded) != want {
		t.Fatalf("encoding = %s, want %s", encoded, want)
	}
}

func TestDigestAndRefAreDerivedFromTheEncoding(t *testing.T) {
	digest := Digest([]byte(`{}`))
	if !DigestPattern.MatchString(digest) {
		t.Fatalf("digest %q does not match the event-log pattern", digest)
	}
	if want := "tool-views/sha256-" + strings.TrimPrefix(digest, "sha256:") + ".json"; Ref(digest) != want {
		t.Fatalf("ref = %s, want %s", Ref(digest), want)
	}
}

func TestCanonicalRefusesWhatHasNoCanonicalForm(t *testing.T) {
	if _, err := Canonical(map[string]any{"callback": func() {}}); err == nil {
		t.Fatal("a value JSON cannot represent was encoded")
	}
	// Both are unreachable through Canonical, which only ever walks what encoding/json decoded and
	// which has already replaced invalid UTF-8. They guard the encoder itself, so they are asserted
	// on it directly.
	if err := writeString(&bytes.Buffer{}, "\xff"); err == nil {
		t.Fatal("invalid UTF-8 was written")
	}
	if err := writeCanonical(&bytes.Buffer{}, 17); err == nil {
		t.Fatal("a Go int, which decoding never produces, was written")
	}
	for name, value := range map[string]any{
		"a non-integer inside an array": []any{json.Number("1"), json.Number("2.5")},
		"an invalid key":                map[string]any{"\xff": true},
	} {
		if err := writeCanonical(&bytes.Buffer{}, value); err == nil {
			t.Fatalf("%s was written", name)
		}
	}
}
