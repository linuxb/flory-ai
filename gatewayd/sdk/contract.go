// Package sdk is what a tool service embeds to join a Flory deployment.
//
// It is the only implementation of the gateway protocol on the service side: no
// tool service hand-writes registration, heartbeat, or health. That matters
// because those three are what make a stateless gateway recoverable, and a
// service that got any of them subtly wrong would look registered while being
// unroutable, or keep heartbeating at a gateway that has forgotten it.
//
// The SDK is domain-neutral. It knows about contracts, not about inventory.
package sdk

import (
	"errors"
	"fmt"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
	"github.com/linuxb/flory-ai/gatewayd/internal/registry"
	"github.com/linuxb/flory-ai/gatewayd/internal/toolview"
)

// Contract describes one tool a service offers, in the terms a service author
// thinks in. It is projected onto the wire ToolContract by Build.
//
// There is deliberately no field for IsPivot or Compensable: both are derived
// from EffectClass and the declared undo path (02 section 2.1), so there is
// nothing here that could disagree with what they are derived from.
type Contract struct {
	ToolID      string
	ToolVersion string
	Description string
	// InputSchema and OutputSchema are JSON Schema documents as text. Tool
	// payloads stay JSON Schema because that is what MCP inputSchema and the
	// planner consume.
	InputSchema  string
	OutputSchema string
	// RouteID is the stable logical route, not an address. It is part of the
	// contract's identity; which instances serve it is not.
	EffectClass         EffectClass
	Mode                Mode
	IdempotencyKeyPath  string
	IdempotentRetryable bool
	TryTimeoutSeconds   uint32
	ConfirmTool         string
	CancelTool          string
	CompensateTool      string
	StatusTool          string
	// Compensating marks a tool that reverses another's effect. It always
	// registers as delta-based: releasing exactly what the matching try added is
	// the only form that commutes with another branch's committed change, and the
	// gateway refuses snapshot restore outright.
	Compensating bool
	Footprint    []string
	Writes       []string
	TimeoutMS    uint32
	Retry        Retry
	Owner        string
}

// EffectClass is a tool's side-effect classification.
type EffectClass string

// The effect classes from design document 02.
const (
	EffectNone         EffectClass = "none"
	EffectBufferable   EffectClass = "bufferable"
	EffectReversible   EffectClass = "reversible"
	EffectIrreversible EffectClass = "irreversible"
)

// Mode is a tool's transaction integration.
type Mode string

// The transaction modes from design document 02.
const (
	ModePlain Mode = "plain"
	ModeTCC   Mode = "tcc"
	ModeSaga  Mode = "saga"
)

// Retry is the envelope an executor may not exceed for this tool.
type Retry struct {
	MaxAttempts      uint32
	InitialBackoffMS uint32
	// Multiplier is expressed in thousandths, so the whole contract stays
	// integer-valued and the tool-view digest has a canonical text form.
	MultiplierMilli uint32
	MaxBackoffMS    uint32
}

// DefaultRetry is a conservative envelope for a service that has no opinion.
func DefaultRetry() Retry {
	return Retry{MaxAttempts: 3, InitialBackoffMS: 100, MultiplierMilli: 2000, MaxBackoffMS: 5000}
}

var effectClasses = map[EffectClass]gatewayv1.EffectClass{
	EffectNone:         gatewayv1.EffectClass_EFFECT_CLASS_NONE,
	EffectBufferable:   gatewayv1.EffectClass_EFFECT_CLASS_BUFFERABLE,
	EffectReversible:   gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE,
	EffectIrreversible: gatewayv1.EffectClass_EFFECT_CLASS_IRREVERSIBLE,
}

var modes = map[Mode]gatewayv1.ToolMode{
	ModePlain: gatewayv1.ToolMode_TOOL_MODE_PLAIN,
	ModeTCC:   gatewayv1.ToolMode_TOOL_MODE_TCC,
	ModeSaga:  gatewayv1.ToolMode_TOOL_MODE_SAGA,
}

// Build projects a declared contract onto the wire form, for one route.
func (contract Contract) Build(routeID string) (*gatewayv1.ToolContract, error) {
	effectClass, known := effectClasses[contract.EffectClass]
	if !known {
		return nil, fmt.Errorf("sdk: %s declares an unknown effect class %q", contract.ToolID, contract.EffectClass)
	}
	mode, known := modes[contract.Mode]
	if !known {
		return nil, fmt.Errorf("sdk: %s declares an unknown mode %q", contract.ToolID, contract.Mode)
	}
	compensation := gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING
	if contract.Compensating {
		compensation = gatewayv1.CompensationStyle_COMPENSATION_STYLE_DELTA
	}
	retry := contract.Retry
	if retry.MaxAttempts == 0 {
		retry = DefaultRetry()
	}
	idempotent := contract.IdempotentRetryable
	return &gatewayv1.ToolContract{
		ToolId:       contract.ToolID,
		ToolVersion:  contract.ToolVersion,
		Description:  contract.Description,
		InputSchema:  contract.InputSchema,
		OutputSchema: contract.OutputSchema,
		RouteId:      routeID,
		Adapter:      &gatewayv1.AdapterSpec{Protocol: "grpc", Operation: "flory.gateway.v1.ToolExecutionService/Execute"},
		Txn: &gatewayv1.TransactionSpec{
			EffectClass:         effectClass,
			Mode:                mode,
			IdempotencyKeyPath:  contract.IdempotencyKeyPath,
			IdempotentRetryable: &idempotent,
			TryTimeoutS:         contract.TryTimeoutSeconds,
			ConfirmTool:         contract.ConfirmTool,
			CancelTool:          contract.CancelTool,
			CompensateTool:      contract.CompensateTool,
			StatusTool:          contract.StatusTool,
		},
		CompensationStyle: compensation,
		Footprint:         contract.Footprint,
		Writes:            contract.Writes,
		TimeoutMs:         contract.TimeoutMS,
		RetryConstraints: &gatewayv1.RetryConstraints{
			MaxAttempts:      retry.MaxAttempts,
			InitialBackoffMs: retry.InitialBackoffMS,
			MultiplierMilli:  retry.MultiplierMilli,
			MaxBackoffMs:     retry.MaxBackoffMS,
		},
		Owner: contract.Owner,
	}, nil
}

// Metadata returns the flory_transaction extension a listing carries for this
// contract, which is what the planner reads to derive transaction structure.
func Metadata(contract *gatewayv1.ToolContract) (map[string]any, error) {
	tool, err := toolview.FromProto(contract)
	if err != nil {
		return nil, err
	}
	return tool.Metadata(), nil
}

// validateContract runs the gateway's own structural rules against one contract.
//
// It calls the gateway's implementation rather than restating it. A second copy
// of these rules would eventually disagree with the first, and a service would
// discover its contract was bad at the worst possible moment: after deploying,
// from a rejection it had already convinced itself could not happen.
func validateContract(contract *gatewayv1.ToolContract) error {
	tool, err := toolview.FromProto(contract)
	if err != nil {
		return err
	}
	if violation := registry.ValidateStructure(tool); violation != nil {
		return errors.New(violation.Error())
	}
	return nil
}
