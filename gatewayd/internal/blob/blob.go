// Package blob stores published tool views by content address.
//
// Views are immutable and named by their own digest, so a write is idempotent
// and a read verifies itself. That is what lets a frozen subgraph resolve its
// exact recorded contract long after the registry that produced it has changed.
package blob

import (
	"context"
	"errors"
	"sync"
)

// ErrNotFound reports that no object exists under the requested name.
var ErrNotFound = errors.New("blob: object not found")

// Store persists canonical documents under content-addressed names.
type Store interface {
	// Put writes content under name. Writing the same name twice is a no-op
	// rather than an error, because the name is derived from the content.
	Put(ctx context.Context, name string, content []byte) error
	// Get returns the stored content, or ErrNotFound.
	Get(ctx context.Context, name string) ([]byte, error)
}

// Memory is an in-process Store for unit tests and dependency-free local runs.
type Memory struct {
	mutex   sync.RWMutex
	objects map[string][]byte
}

// NewMemory creates an empty in-process store.
func NewMemory() *Memory {
	return &Memory{objects: map[string][]byte{}}
}

// Put stores a copy of content, so a later mutation of the caller's slice cannot
// change what a content-addressed name resolves to.
func (store *Memory) Put(_ context.Context, name string, content []byte) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	stored := make([]byte, len(content))
	copy(stored, content)
	store.objects[name] = stored
	return nil
}

// Get returns a copy of the stored content, or ErrNotFound.
func (store *Memory) Get(_ context.Context, name string) ([]byte, error) {
	store.mutex.RLock()
	defer store.mutex.RUnlock()
	stored, found := store.objects[name]
	if !found {
		return nil, ErrNotFound
	}
	content := make([]byte, len(stored))
	copy(content, stored)
	return content, nil
}
