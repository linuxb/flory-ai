// Package toolview builds and canonicalises the immutable tool views gatewayd
// publishes. A view's digest is its identity: planning records it, execution
// pins it, and replay resolves it, so the encoding must be reproducible byte
// for byte -- here, and independently in the TypeScript engine.
package toolview

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// DigestPattern matches a canonical tool-view digest, mirroring the event-log schema.
var DigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

var integerPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

// Canonical returns the canonical JSON encoding of value.
//
// Object keys are sorted lexicographically, no character is escaped beyond what
// JSON requires, and every number must be an integer. Floating point is rejected
// rather than formatted: "1e2", "100", and "100.0" are the same value with three
// spellings, and a digest cannot depend on which one a caller happened to write.
func Canonical(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("canonical: marshal: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var tree any
	if err := decoder.Decode(&tree); err != nil {
		return nil, fmt.Errorf("canonical: decode: %w", err)
	}
	buffer := &bytes.Buffer{}
	if err := writeCanonical(buffer, tree); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// Digest returns the content address of an already-canonical encoding.
func Digest(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Ref returns the blob object name that stores the view with this digest.
//
// The name is derived from the digest alone, so a fetched blob verifies itself:
// re-canonicalising it must reproduce the name it was fetched by.
func Ref(digest string) string {
	return "tool-views/" + strings.Replace(digest, ":", "-", 1) + ".json"
}

func writeCanonical(buffer *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		if typed {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case json.Number:
		if !integerPattern.MatchString(typed.String()) {
			return fmt.Errorf("canonical: %q is not an integer; tool views are integer-valued", typed.String())
		}
		buffer.WriteString(typed.String())
	case string:
		return writeString(buffer, typed)
	case []any:
		buffer.WriteByte('[')
		for index, element := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := writeCanonical(buffer, element); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		buffer.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if err := writeString(buffer, key); err != nil {
				return err
			}
			buffer.WriteByte(':')
			if err := writeCanonical(buffer, typed[key]); err != nil {
				return err
			}
		}
		buffer.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unsupported value of type %T", value)
	}
	return nil
}

// writeString emits the minimal JSON escaping every conforming parser accepts.
//
// Notably it does not escape <, >, or &, which Go's encoder does by default:
// that habit is an HTML-embedding workaround, and here it would make the digest
// depend on whether a description happened to contain an angle bracket.
func writeString(buffer *bytes.Buffer, value string) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("canonical: %q is not valid UTF-8", value)
	}
	buffer.WriteByte('"')
	for _, symbol := range value {
		switch symbol {
		case '"':
			buffer.WriteString(`\"`)
		case '\\':
			buffer.WriteString(`\\`)
		case '\b':
			buffer.WriteString(`\b`)
		case '\f':
			buffer.WriteString(`\f`)
		case '\n':
			buffer.WriteString(`\n`)
		case '\r':
			buffer.WriteString(`\r`)
		case '\t':
			buffer.WriteString(`\t`)
		default:
			if symbol < 0x20 {
				fmt.Fprintf(buffer, `\u%04x`, symbol)
				continue
			}
			buffer.WriteRune(symbol)
		}
	}
	buffer.WriteByte('"')
	return nil
}
