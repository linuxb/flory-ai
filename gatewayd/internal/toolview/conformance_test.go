package toolview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixturePath is the shared cross-language fixture. Both this test and
// test/conformance/tool-view.test.ts read it, which is what makes the two
// canonical encoders provably the same rather than merely intended to be.
const fixturePath = "../../../test/fixtures/tool-view-conformance.json"

type conformanceFixture struct {
	CanonicalCases []struct {
		Name      string          `json:"name"`
		Value     json.RawMessage `json:"value"`
		Canonical string          `json:"canonical"`
		Digest    string          `json:"digest"`
	} `json:"canonical_cases"`
	RejectedCases []struct {
		Name   string          `json:"name"`
		Value  json.RawMessage `json:"value"`
		Reason string          `json:"reason"`
	} `json:"rejected_cases"`
	ViewCases []struct {
		Name     string          `json:"name"`
		Document json.RawMessage `json:"document"`
		Digest   string          `json:"digest"`
		Ref      string          `json:"ref"`
	} `json:"view_cases"`
}

func loadFixture(t *testing.T) conformanceFixture {
	t.Helper()
	content, err := os.ReadFile(filepath.Clean(fixturePath))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture conformanceFixture
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fixture
}

func TestCanonicalConformance(t *testing.T) {
	fixture := loadFixture(t)
	if len(fixture.CanonicalCases) == 0 {
		t.Fatal("the fixture has no canonical cases")
	}
	for _, testCase := range fixture.CanonicalCases {
		t.Run(testCase.Name, func(t *testing.T) {
			encoded, err := Canonical(testCase.Value)
			if err != nil {
				t.Fatalf("canonical: %v", err)
			}
			if string(encoded) != testCase.Canonical {
				t.Fatalf("encoding = %s, want %s", encoded, testCase.Canonical)
			}
			if digest := Digest(encoded); digest != testCase.Digest {
				t.Fatalf("digest = %s, want %s", digest, testCase.Digest)
			}
		})
	}
}

func TestCanonicalRejectionConformance(t *testing.T) {
	fixture := loadFixture(t)
	for _, testCase := range fixture.RejectedCases {
		t.Run(testCase.Name, func(t *testing.T) {
			if _, err := Canonical(testCase.Value); err == nil {
				t.Fatalf("%s was accepted; both encoders must refuse it", testCase.Reason)
			}
		})
	}
}

func TestViewDigestConformance(t *testing.T) {
	fixture := loadFixture(t)
	for _, testCase := range fixture.ViewCases {
		t.Run(testCase.Name, func(t *testing.T) {
			published, err := Parse(testCase.Document, testCase.Digest)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if published.Ref != testCase.Ref {
				t.Fatalf("ref = %s, want %s", published.Ref, testCase.Ref)
			}
		})
	}
}
