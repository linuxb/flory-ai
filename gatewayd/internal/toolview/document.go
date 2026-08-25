package toolview

import (
	"encoding/json"
	"fmt"
	"sort"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

// Version is the tool-view document format version, carried inside the digest
// so a format change cannot be mistaken for a contract change.
const Version = "1"

// Transaction is the declared transaction contract of one tool.
//
// It uses the event log's own vocabulary rather than protobuf enum names, so the
// engine reads one set of strings across the tool view, vertex payloads, and
// check-rules.
type Transaction struct {
	EffectClass         string `json:"effect_class"`
	Mode                string `json:"mode"`
	IdempotencyKeyPath  string `json:"idempotency_key_path,omitempty"`
	IdempotentRetryable bool   `json:"idempotent_retryable"`
	TryTimeoutS         uint32 `json:"try_timeout_s,omitempty"`
	ConfirmTool         string `json:"confirm_tool,omitempty"`
	CancelTool          string `json:"cancel_tool,omitempty"`
	CompensateTool      string `json:"compensate_tool,omitempty"`
	StatusTool          string `json:"status_tool,omitempty"`
}

// Retry is the envelope an executor may not exceed for this tool.
type Retry struct {
	MaxAttempts      uint32 `json:"max_attempts"`
	InitialBackoffMS uint32 `json:"initial_backoff_ms"`
	MultiplierMilli  uint32 `json:"multiplier_milli"`
	MaxBackoffMS     uint32 `json:"max_backoff_ms"`
}

// Adapter is the protocol contract for reaching a tool, without any address.
type Adapter struct {
	Protocol  string `json:"protocol"`
	Operation string `json:"operation,omitempty"`
}

// Tool is one immutable published contract.
//
// Every field here is inside the digest. Instance membership and health are
// deliberately absent: they may change so the gateway can route a pinned
// contract to a healthy instance, which must not alter that contract's identity.
type Tool struct {
	ToolID            string          `json:"tool_id"`
	ToolVersion       string          `json:"tool_version"`
	Description       string          `json:"description,omitempty"`
	InputSchema       json.RawMessage `json:"input_schema"`
	OutputSchema      json.RawMessage `json:"output_schema"`
	RouteID           string          `json:"route_id"`
	Adapter           Adapter         `json:"adapter"`
	Txn               Transaction     `json:"txn"`
	CompensationStyle string          `json:"compensation_style"`
	Footprint         []string        `json:"footprint"`
	Writes            []string        `json:"writes"`
	TimeoutMS         uint32          `json:"timeout_ms"`
	Retry             Retry           `json:"retry_constraints"`
	Owner             string          `json:"owner"`
}

// Document is one complete published tool view.
type Document struct {
	ToolViewVersion string `json:"tool_view_version"`
	Tools           []Tool `json:"tools"`
}

// Published is a document together with the identity readers pin it by.
type Published struct {
	Ref      string
	Digest   string
	Document Document
	// Canonical is the exact byte sequence the digest was taken over.
	Canonical []byte
}

var (
	effectClassNames = map[gatewayv1.EffectClass]string{
		gatewayv1.EffectClass_EFFECT_CLASS_NONE:         "none",
		gatewayv1.EffectClass_EFFECT_CLASS_BUFFERABLE:   "bufferable",
		gatewayv1.EffectClass_EFFECT_CLASS_REVERSIBLE:   "reversible",
		gatewayv1.EffectClass_EFFECT_CLASS_IRREVERSIBLE: "irreversible",
	}
	toolModeNames = map[gatewayv1.ToolMode]string{
		gatewayv1.ToolMode_TOOL_MODE_PLAIN: "plain",
		gatewayv1.ToolMode_TOOL_MODE_TCC:   "tcc",
		gatewayv1.ToolMode_TOOL_MODE_SAGA:  "saga",
	}
	compensationStyleNames = map[gatewayv1.CompensationStyle]string{
		gatewayv1.CompensationStyle_COMPENSATION_STYLE_NOT_COMPENSATING: "not-compensating",
		gatewayv1.CompensationStyle_COMPENSATION_STYLE_DELTA:            "delta",
		gatewayv1.CompensationStyle_COMPENSATION_STYLE_SNAPSHOT:         "snapshot",
	}
)

// EffectClassName maps a protobuf effect class onto the event log's vocabulary.
func EffectClassName(value gatewayv1.EffectClass) (string, error) {
	name, known := effectClassNames[value]
	if !known {
		return "", fmt.Errorf("toolview: unspecified effect_class")
	}
	return name, nil
}

// ToolModeName maps a protobuf transaction mode onto the event log's vocabulary.
func ToolModeName(value gatewayv1.ToolMode) (string, error) {
	name, known := toolModeNames[value]
	if !known {
		return "", fmt.Errorf("toolview: unspecified mode")
	}
	return name, nil
}

// CompensationStyleName maps a protobuf compensation style onto its view name.
func CompensationStyleName(value gatewayv1.CompensationStyle) (string, error) {
	name, known := compensationStyleNames[value]
	if !known {
		return "", fmt.Errorf("toolview: unspecified compensation_style")
	}
	return name, nil
}

// FromProto projects a registered contract onto its tool-view representation.
//
// It fails closed on an unset enum: a zero value that silently became "none"
// would mislabel an effect class, which is the one defect no downstream
// check-rule can infer (02 section 2.1).
func FromProto(contract *gatewayv1.ToolContract) (Tool, error) {
	if contract == nil {
		return Tool{}, fmt.Errorf("toolview: nil contract")
	}
	txn := contract.GetTxn()
	effectClass, err := EffectClassName(txn.GetEffectClass())
	if err != nil {
		return Tool{}, fmt.Errorf("%s: %w", contract.GetToolId(), err)
	}
	mode, err := ToolModeName(txn.GetMode())
	if err != nil {
		return Tool{}, fmt.Errorf("%s: %w", contract.GetToolId(), err)
	}
	compensation, err := CompensationStyleName(contract.GetCompensationStyle())
	if err != nil {
		return Tool{}, fmt.Errorf("%s: %w", contract.GetToolId(), err)
	}
	inputSchema, err := rawSchema(contract.GetInputSchema())
	if err != nil {
		return Tool{}, fmt.Errorf("%s: input_schema: %w", contract.GetToolId(), err)
	}
	outputSchema, err := rawSchema(contract.GetOutputSchema())
	if err != nil {
		return Tool{}, fmt.Errorf("%s: output_schema: %w", contract.GetToolId(), err)
	}
	retry := contract.GetRetryConstraints()
	return Tool{
		ToolID:       contract.GetToolId(),
		ToolVersion:  contract.GetToolVersion(),
		Description:  contract.GetDescription(),
		InputSchema:  inputSchema,
		OutputSchema: outputSchema,
		RouteID:      contract.GetRouteId(),
		Adapter:      Adapter{Protocol: contract.GetAdapter().GetProtocol(), Operation: contract.GetAdapter().GetOperation()},
		Txn: Transaction{
			EffectClass:         effectClass,
			Mode:                mode,
			IdempotencyKeyPath:  txn.GetIdempotencyKeyPath(),
			IdempotentRetryable: txn.GetIdempotentRetryable(),
			TryTimeoutS:         txn.GetTryTimeoutS(),
			ConfirmTool:         txn.GetConfirmTool(),
			CancelTool:          txn.GetCancelTool(),
			CompensateTool:      txn.GetCompensateTool(),
			StatusTool:          txn.GetStatusTool(),
		},
		CompensationStyle: compensation,
		Footprint:         sortedCopy(contract.GetFootprint()),
		Writes:            sortedCopy(contract.GetWrites()),
		TimeoutMS:         contract.GetTimeoutMs(),
		Retry: Retry{
			MaxAttempts:      retry.GetMaxAttempts(),
			InitialBackoffMS: retry.GetInitialBackoffMs(),
			MultiplierMilli:  retry.GetMultiplierMilli(),
			MaxBackoffMS:     retry.GetMaxBackoffMs(),
		},
		Owner: contract.GetOwner(),
	}, nil
}

// Build assembles a publishable view from admitted contracts.
//
// Tools and their set-like fields are sorted, so the digest depends on which
// contracts are admitted and never on the order services happened to start in.
func Build(tools []Tool) (Published, error) {
	ordered := make([]Tool, len(tools))
	copy(ordered, tools)
	for index := range ordered {
		ordered[index].Footprint = sortedCopy(ordered[index].Footprint)
		ordered[index].Writes = sortedCopy(ordered[index].Writes)
	}
	sort.Slice(ordered, func(first, second int) bool {
		if ordered[first].ToolID != ordered[second].ToolID {
			return ordered[first].ToolID < ordered[second].ToolID
		}
		return ordered[first].ToolVersion < ordered[second].ToolVersion
	})
	document := Document{ToolViewVersion: Version, Tools: ordered}
	canonical, err := Canonical(document)
	if err != nil {
		return Published{}, err
	}
	digest := Digest(canonical)
	return Published{Ref: Ref(digest), Digest: digest, Document: document, Canonical: canonical}, nil
}

// Parse verifies a stored view against the digest it was fetched by.
//
// Content addressing is only a guarantee if someone checks it, so every read
// path -- including a blob fetched for a historical digest -- goes through here.
func Parse(canonical []byte, expectedDigest string) (Published, error) {
	var document Document
	if err := json.Unmarshal(canonical, &document); err != nil {
		return Published{}, fmt.Errorf("toolview: malformed document: %w", err)
	}
	recanonical, err := Canonical(document)
	if err != nil {
		return Published{}, err
	}
	digest := Digest(recanonical)
	if expectedDigest != "" && digest != expectedDigest {
		return Published{}, fmt.Errorf("toolview: digest mismatch: document canonicalises to %s, not %s", digest, expectedDigest)
	}
	return Published{Ref: Ref(digest), Digest: digest, Document: document, Canonical: recanonical}, nil
}

// Lookup returns the exact pinned contract, never a newer version of it.
func (document Document) Lookup(toolID, toolVersion string) (Tool, bool) {
	for _, tool := range document.Tools {
		if tool.ToolID == toolID && (toolVersion == "" || tool.ToolVersion == toolVersion) {
			return tool, true
		}
	}
	return Tool{}, false
}

// Metadata is the flory_transaction extension carried in an MCP tool listing.
//
// is_pivot is absent because it is derived from effect_class, exactly as
// specified in design document 09 section 3.2.
func (tool Tool) Metadata() map[string]any {
	metadata := map[string]any{
		"effect_class":         tool.Txn.EffectClass,
		"mode":                 tool.Txn.Mode,
		"idempotent_retryable": tool.Txn.IdempotentRetryable,
		"tool_version":         tool.ToolVersion,
	}
	for key, value := range map[string]string{
		"idempotency_key_path": tool.Txn.IdempotencyKeyPath,
		"confirm_tool":         tool.Txn.ConfirmTool,
		"cancel_tool":          tool.Txn.CancelTool,
		"compensate_tool":      tool.Txn.CompensateTool,
		"status_tool":          tool.Txn.StatusTool,
	} {
		if value != "" {
			metadata[key] = value
		}
	}
	if tool.Txn.TryTimeoutS > 0 {
		metadata["try_timeout_s"] = tool.Txn.TryTimeoutS
	}
	if len(tool.Footprint) > 0 {
		metadata["footprint"] = tool.Footprint
	}
	if len(tool.Writes) > 0 {
		metadata["writes"] = tool.Writes
	}
	return metadata
}

func rawSchema(text string) (json.RawMessage, error) {
	if text == "" {
		return nil, fmt.Errorf("missing schema")
	}
	var probe any
	if err := json.Unmarshal([]byte(text), &probe); err != nil {
		return nil, fmt.Errorf("not JSON: %w", err)
	}
	if _, isObject := probe.(map[string]any); !isObject {
		return nil, fmt.Errorf("must be a JSON object")
	}
	return json.RawMessage(text), nil
}

func sortedCopy(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	copied := make([]string, len(values))
	copy(copied, values)
	sort.Strings(copied)
	return copied
}
