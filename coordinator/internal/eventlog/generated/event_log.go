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
	Role           string                 `json:"role"`
	Tool           string                 `json:"tool"`
	ToolVersion    string                 `json:"tool_version"`
	ToolViewDigest string                 `json:"tool_view_digest"`
	Input          map[string]interface{} `json:"input"`
	RetryPolicy    RetryPolicy            `json:"retry_policy"`
	Txn            TransactionSpec        `json:"txn"`
}

type SubgraphProposedPayload struct {
	ToolViewRef    string `json:"tool_view_ref"`
	ToolViewDigest string `json:"tool_view_digest"`
}

type LLMUsage struct {
	InputTokens          int64 `json:"input_tokens"`
	OutputTokens         int64 `json:"output_tokens"`
	TotalTokens          int64 `json:"total_tokens"`
	ReasoningTokens      int64 `json:"reasoning_tokens"`
	CacheHitInputTokens  int64 `json:"cache_hit_input_tokens"`
	CacheMissInputTokens int64 `json:"cache_miss_input_tokens"`
}

type LLMRatesPerMillion struct {
	CacheHitInput  float64 `json:"cache_hit_input"`
	CacheMissInput float64 `json:"cache_miss_input"`
	Output         float64 `json:"output"`
}

type LLMCostEstimate struct {
	Currency        string             `json:"currency"`
	Amount          float64            `json:"amount"`
	PricingRef      string             `json:"pricing_ref"`
	PricingTier     string             `json:"pricing_tier,omitempty"`
	RatesPerMillion LLMRatesPerMillion `json:"rates_per_million"`
}

type BudgetChargedPayload struct {
	Category       string           `json:"category"`
	Provider       string           `json:"provider"`
	Protocol       string           `json:"protocol"`
	Endpoint       string           `json:"endpoint"`
	RequestedModel string           `json:"requested_model"`
	ResponseModel  string           `json:"response_model"`
	DurationMS     float64          `json:"duration_ms"`
	Usage          LLMUsage         `json:"usage"`
	EstimatedCost  *LLMCostEstimate `json:"estimated_cost,omitempty"`
}

type ForkSubstitution struct {
	StreamSeq  int64  `json:"stream_seq"`
	PinVersion string `json:"pin_version"`
}

type ForkRequest struct {
	SourceRunID         string             `json:"source_run_id"`
	AtVertexID          string             `json:"at_vertex_id"`
	Substitutions       []ForkSubstitution `json:"substitutions"`
	EvalUpToSeq         int64              `json:"eval_up_to_seq"`
	FoldMode            FoldMode           `json:"fold_mode"`
	EvaluatorPin        string             `json:"evaluator_pin"`
	ProjectorVersion    string             `json:"projector_version"`
	HarnessStateVersion string             `json:"harness_state_version"`
}
