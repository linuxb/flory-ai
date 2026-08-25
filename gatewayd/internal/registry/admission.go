// Package registry admits tool registrations and publishes the immutable views
// built from them.
//
// It validates registrations and nothing else. It does not plan, retry, append
// events, or decide compensation, and it deliberately does not re-implement
// checkSubDag: proposal admission stays the TypeScript rule engine's authority.
// What lives here is the narrower obligation from design document 09 section 3 --
// that a contract is structurally fit to be planned against at all.
package registry

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

// supportedProtocols lists the upstream adapters gatewayd can route to.
var supportedProtocols = map[string]bool{"grpc": true}

// Violation is one registration rejection from the closed G1-G8 vocabulary.
type Violation struct {
	Code   gatewayv1.AdmissionCode
	Detail string
}

func (violation Violation) Error() string {
	return fmt.Sprintf("%s: %s", violation.Code, violation.Detail)
}

func reject(code gatewayv1.AdmissionCode, format string, arguments ...any) *Violation {
	return &Violation{Code: code, Detail: fmt.Sprintf(format, arguments...)}
}

// CompileSchema parses a registered JSON Schema.
//
// The gateway validates call arguments against this schema before dispatch, so a
// schema that does not compile would mean a tool whose inputs are never checked.
// It is exported so a historical view resolved from blob storage compiles its
// schemas exactly as the registry compiled them when it published that view.
func CompileSchema(name, text string) (*jsonschema.Schema, error) {
	var document any
	if err := json.Unmarshal([]byte(text), &document); err != nil {
		return nil, fmt.Errorf("%s is not JSON: %w", name, err)
	}
	compiler := jsonschema.NewCompiler()
	resource := "https://flory.dev/tool-schema/" + name + ".json"
	if err := compiler.AddResource(resource, document); err != nil {
		return nil, fmt.Errorf("%s is not a usable schema: %w", name, err)
	}
	compiled, err := compiler.Compile(resource)
	if err != nil {
		return nil, fmt.Errorf("%s does not compile: %w", name, err)
	}
	return compiled, nil
}

// validateStructure applies the registration rules decidable from one contract
// alone: G1, G4, G5, and the declared half of G2 and G3.
//
// Rules that depend on other registrations -- whether a named companion exists
// and is itself retry-safe -- are G6 and are resolved in resolve.go, because a
// tool service may legitimately start before the service hosting its compensator.
func validateStructure(tool toolview.Tool) *Violation {
	if violation := validateIdentity(tool); violation != nil {
		return violation
	}
	if violation := validateEffectClass(tool); violation != nil {
		return violation
	}
	if violation := validateCompensationStyle(tool); violation != nil {
		return violation
	}
	if violation := validateDeclaredCompanions(tool); violation != nil {
		return violation
	}
	return validateCompanionReferences(tool)
}

func validateIdentity(tool toolview.Tool) *Violation {
	for field, value := range map[string]string{"tool_id": tool.ToolID, "tool_version": tool.ToolVersion, "route_id": tool.RouteID, "owner": tool.Owner} {
		if strings.TrimSpace(value) == "" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "%s is required", field)
		}
	}
	if !supportedProtocols[tool.Adapter.Protocol] {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "adapter protocol %q is not supported", tool.Adapter.Protocol)
	}
	if tool.TimeoutMS == 0 {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "timeout_ms is required")
	}
	if tool.Retry.MaxAttempts == 0 {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "retry_constraints.max_attempts must be at least 1")
	}
	// A multiplier below 1.0 would shrink each successive backoff, turning a
	// retry policy into a tighter and tighter loop against a struggling service.
	if tool.Retry.MultiplierMilli < 1000 {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "retry_constraints.multiplier_milli must be at least 1000")
	}
	if _, err := CompileSchema(tool.ToolID+".input", string(tool.InputSchema)); err != nil {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "%v", err)
	}
	if _, err := CompileSchema(tool.ToolID+".output", string(tool.OutputSchema)); err != nil {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MALFORMED_CONTRACT, "%v", err)
	}
	return nil
}

// validateEffectClass enforces G4: the declared effect class must agree with the
// declared undo path.
//
// This is the registry-time obligation from 02 section 2.1. Nothing downstream
// can recover from getting it wrong, because every later rule reasons from the
// effect class rather than re-deriving it.
func validateEffectClass(tool toolview.Tool) *Violation {
	switch tool.Txn.EffectClass {
	case "none":
		if tool.Txn.Mode != "plain" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MISLABELLED_EFFECT_CLASS,
				"effect_class none has no side effect to bracket, so mode must be plain, not %s", tool.Txn.Mode)
		}
	case "irreversible":
		if tool.Txn.Mode != "plain" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MISLABELLED_EFFECT_CLASS,
				"effect_class irreversible has no undo path, so mode must be plain, not %s", tool.Txn.Mode)
		}
		if tool.Txn.CompensateTool != "" || tool.Txn.ConfirmTool != "" || tool.Txn.CancelTool != "" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MISLABELLED_EFFECT_CLASS,
				"effect_class irreversible declares an undo path; a compensable effect is not irreversible")
		}
	case "reversible":
		if tool.Txn.Mode == "plain" && tool.Txn.CompensateTool == "" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_MISLABELLED_EFFECT_CLASS,
				"effect_class reversible declares no undo path; a tool with no undo path must be registered irreversible")
		}
	}
	return nil
}

// validateCompensationStyle enforces G5.
//
// Snapshot restore is rejected outright rather than at first use: only a
// delta-based release commutes with another branch's committed change, and the
// defect is invisible until two branches actually interleave (discipline 17).
func validateCompensationStyle(tool toolview.Tool) *Violation {
	if tool.CompensationStyle == "snapshot" {
		return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_NON_DELTA_COMPENSATION,
			"compensation must release the delta this try added, never restore an absolute snapshot")
	}
	return nil
}

// validateDeclaredCompanions enforces the half of G2 and G3 that one contract
// can answer by itself: whether it named the companions its mode requires.
func validateDeclaredCompanions(tool toolview.Tool) *Violation {
	switch tool.Txn.Mode {
	case "tcc":
		if tool.Txn.ConfirmTool == "" || tool.Txn.CancelTool == "" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE, "mode tcc requires both confirm_tool and cancel_tool")
		}
		// Without a positive timeout a try can hold a resource forever, which is
		// the frozen-resource failure R6 exists to prevent.
		if tool.Txn.TryTimeoutS == 0 {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_TCC_TRIPLE, "mode tcc requires a positive try_timeout_s")
		}
	case "saga":
		if tool.Txn.CompensateTool == "" {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_INCOMPLETE_SAGA_COMPENSATION, "mode saga requires a compensate_tool")
		}
	}
	return nil
}

// validateCompanionReferences enforces G8: a tool may not be its own companion.
//
// A self-referential undo path looks complete to every structural check and
// deadlocks the first time it is walked.
func validateCompanionReferences(tool toolview.Tool) *Violation {
	for field, companion := range map[string]string{
		"confirm_tool":    tool.Txn.ConfirmTool,
		"cancel_tool":     tool.Txn.CancelTool,
		"compensate_tool": tool.Txn.CompensateTool,
		"status_tool":     tool.Txn.StatusTool,
	} {
		if companion != "" && companion == tool.ToolID {
			return reject(gatewayv1.AdmissionCode_ADMISSION_CODE_INVALID_COMPANION_REFERENCE, "%s refers to the tool itself", field)
		}
	}
	return nil
}

// companions lists the tools this contract's transaction integration depends on.
func companions(tool toolview.Tool) []string {
	named := []string{}
	for _, companion := range []string{tool.Txn.ConfirmTool, tool.Txn.CancelTool, tool.Txn.CompensateTool, tool.Txn.StatusTool} {
		if companion != "" {
			named = append(named, companion)
		}
	}
	return named
}

// mustBeRetrySafe reports whether a companion has to be idempotent-retryable.
//
// R4 and R6 require it of confirm, cancel, and compensate, because those run on
// the recovery path where a duplicate delivery is expected. A status query is
// read-only and carries no such obligation.
func mustBeRetrySafe(tool toolview.Tool, companion string) bool {
	return companion == tool.Txn.ConfirmTool || companion == tool.Txn.CancelTool || companion == tool.Txn.CompensateTool
}

// isCompensating reports whether a companion reverses the named tool's effect,
// which is what obliges it to be delta-based rather than snapshot-based.
func isCompensating(tool toolview.Tool, companion string) bool {
	return companion == tool.Txn.CancelTool || companion == tool.Txn.CompensateTool
}
