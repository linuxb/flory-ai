// Code generated from idl/event-log.schema.json; DO NOT EDIT.
package generated

type FoldMode string

const (
	FoldModeRecorded  FoldMode = "recorded"
	FoldModeModelLive FoldMode = "model-live"
	FoldModeReadsLive FoldMode = "reads-live"
)

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
