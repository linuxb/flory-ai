//go:build tools

// Package tools pins the code generators `npm run generate` installs into
// gatewayd/bin, so the protobuf stubs are reproducible from this module alone.
package tools

import (
	_ "google.golang.org/grpc/cmd/protoc-gen-go-grpc"
	_ "google.golang.org/protobuf/cmd/protoc-gen-go"
)
