// Code generated from idl/event-log.schema.json; DO NOT EDIT.
package generated

type FoldMode string
type EffectClass string
type TransactionMode string

const (
	FoldModeRecorded  FoldMode = "recorded"
	FoldModeModelLive FoldMode = "model-live"
	FoldModeReadsLive FoldMode = "reads-live"
)

const (
	EffectNone         EffectClass = "none"
	EffectBufferable   EffectClass = "bufferable"
	EffectReversible   EffectClass = "reversible"
	EffectIrreversible EffectClass = "irreversible"
)

const (
	ModePlain TransactionMode = "plain"
	ModeTCC   TransactionMode = "tcc"
	ModeSaga  TransactionMode = "saga"
)

type RetryPolicy struct {
	MaxAttempts      int     `json:"max_attempts"`
	InitialBackoffMS int64   `json:"initial_backoff_ms"`
	Multiplier       float64 `json:"multiplier"`
	MaxBackoffMS     int64   `json:"max_backoff_ms"`
}

type TransactionSpec struct {
	EffectClass    EffectClass     `json:"effect_class"`
	Mode           TransactionMode `json:"mode"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	TryTimeoutS    int64           `json:"try_timeout_s,omitempty"`
	ConfirmTool    string          `json:"confirm_tool,omitempty"`
	CancelTool     string          `json:"cancel_tool,omitempty"`
	CompensateTool string          `json:"compensate_tool,omitempty"`
	StatusTool     string          `json:"status_tool,omitempty"`
}

type ToolVertexPayload struct {
	Role        string                 `json:"role"`
	Tool        string                 `json:"tool"`
	Input       map[string]interface{} `json:"input"`
	RetryPolicy RetryPolicy            `json:"retry_policy"`
	Txn         TransactionSpec        `json:"txn"`
}

type ForkSubstitution struct {
	StreamSeq  int64  `json:"stream_seq"`
	PinVersion string `json:"pin_version"`
}

type ForkRequest struct {
	SourceRunID         string             `json:"source_run_id"`
	AtStreamSeq         int64              `json:"at_stream_seq"`
	Substitutions       []ForkSubstitution `json:"substitutions"`
	FoldMode            FoldMode           `json:"fold_mode"`
	EvaluatorPin        string             `json:"evaluator_pin"`
	ProjectorVersion    string             `json:"projector_version"`
	HarnessStateVersion string             `json:"harness_state_version"`
}
