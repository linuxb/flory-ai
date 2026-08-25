package sdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/protobuf/types/known/timestamppb"

	gatewayv1 "github.com/linuxb/flory-ai/gatewayd/internal/pb/flory/gateway/v1"
)

// Outcome is what a handler reports about one attempt.
type Outcome string

// The outcome vocabulary, identical to the one the executors reason with.
const (
	// OutcomeSucceeded means the operation completed.
	OutcomeSucceeded Outcome = "succeeded"
	// OutcomeRetryableFailure means the same idempotent operation may be
	// attempted again -- by the executor that owns the retry decision.
	OutcomeRetryableFailure Outcome = "retryable-failure"
	// OutcomePermanentFailure means retry cannot resolve the failure.
	OutcomePermanentFailure Outcome = "permanent-failure"
	// OutcomeUnknown means the service cannot say whether its effect happened.
	OutcomeUnknown Outcome = "unknown"
)

// Call is one attempt delivered to a handler.
type Call struct {
	RunID          string
	VertexID       string
	ScopeID        string
	AttemptNo      uint32
	ToolID         string
	ToolVersion    string
	IdempotencyKey string
	Arguments      json.RawMessage
	Deadline       time.Time
}

// Arg decodes the call arguments into value.
func (call Call) Arg(value any) error {
	return json.Unmarshal(call.Arguments, value)
}

// Result is a handler's answer.
type Result struct {
	Outcome Outcome
	// Value is marshalled to JSON as the tool's result.
	Value any
	Error string
}

// Handler executes one attempt of one tool.
//
// It is called at most once per attempt: neither the SDK nor the gateway will
// call it again on its own. If the same idempotency key arrives twice, that is
// an executor's deliberate retry, and the handler is expected to be idempotent
// in exactly the way its contract declared.
type Handler func(ctx context.Context, call Call) Result

// Tool pairs a declared contract with the handler that serves it.
type Tool struct {
	Contract Contract
	Handler  Handler
}

// Config describes one tool-service instance.
type Config struct {
	// InstanceID must be unique per process. A restarted process may reuse it;
	// the gateway treats re-registration of an identical contract as idempotent.
	InstanceID string
	// RouteID is the logical route this service serves. Several instances of one
	// service share it, which is what lets the gateway spread attempts.
	RouteID string
	// Target is the dial address the gateway will reach this instance on. It must
	// be reachable from the gateway, which is not always the listen address.
	Target string
	// GatewayAddress is the gateway's registration surface, "host:port".
	GatewayAddress    string
	LeaseTTL          time.Duration
	HeartbeatInterval time.Duration
	Logger            *slog.Logger
}

// DefaultLeaseTTL and DefaultHeartbeatInterval keep several beats inside one
// lease, so a single lost heartbeat does not withdraw a healthy instance.
const (
	DefaultLeaseTTL          = 30 * time.Second
	DefaultHeartbeatInterval = 5 * time.Second
)

// Service is one registering, heartbeating tool service.
type Service struct {
	gatewayv1.UnimplementedToolExecutionServiceServer
	config    Config
	logger    *slog.Logger
	mutex     sync.RWMutex
	tools     map[string]Tool
	contracts map[string]*gatewayv1.ToolContract

	grpcServer   *grpc.Server
	healthServer *health.Server

	clientMutex sync.Mutex
	connection  *grpc.ClientConn
	client      gatewayv1.RegistryServiceClient
}

// NewService creates a tool service that has not yet declared any tools.
func NewService(config Config) (*Service, error) {
	if config.InstanceID == "" || config.RouteID == "" || config.Target == "" {
		return nil, errors.New("sdk: InstanceID, RouteID, and Target are all required")
	}
	if config.LeaseTTL <= 0 {
		config.LeaseTTL = DefaultLeaseTTL
	}
	if config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	service := &Service{
		config:       config,
		logger:       config.Logger,
		tools:        map[string]Tool{},
		contracts:    map[string]*gatewayv1.ToolContract{},
		grpcServer:   grpc.NewServer(),
		healthServer: health.NewServer(),
	}
	gatewayv1.RegisterToolExecutionServiceServer(service.grpcServer, service)
	grpc_health_v1.RegisterHealthServer(service.grpcServer, service.healthServer)
	service.SetServing(false)
	return service, nil
}

// Declare adds a tool this service offers.
//
// The contract is validated here, at startup, against the gateway's own rules --
// before any network call. A service that declares snapshot compensation or a
// saga with no compensator should fail while someone is watching it start, not
// on a rejection it has to go read a log to find.
func (service *Service) Declare(tools ...Tool) error {
	service.mutex.Lock()
	defer service.mutex.Unlock()
	for _, tool := range tools {
		contract, err := tool.Contract.Build(service.config.RouteID)
		if err != nil {
			return err
		}
		if err := validateContract(contract); err != nil {
			return fmt.Errorf("sdk: %s is not registrable: %w", tool.Contract.ToolID, err)
		}
		if _, declared := service.tools[tool.Contract.ToolID]; declared {
			return fmt.Errorf("sdk: %s is declared twice", tool.Contract.ToolID)
		}
		service.tools[tool.Contract.ToolID] = tool
		service.contracts[tool.Contract.ToolID] = contract
	}
	return nil
}

// Serve starts the gRPC surface on listener and returns when it stops.
func (service *Service) Serve(listener net.Listener) error {
	return service.grpcServer.Serve(listener)
}

// SetServing publishes this instance's own readiness.
//
// It drives both health signals the gateway consults: the gRPC health check it
// probes, and the report carried on each heartbeat. A service that knows it
// cannot work says so here and stops receiving attempts, without deregistering.
func (service *Service) SetServing(serving bool) {
	status := grpc_health_v1.HealthCheckResponse_NOT_SERVING
	if serving {
		status = grpc_health_v1.HealthCheckResponse_SERVING
	}
	service.healthServer.SetServingStatus("", status)
	service.healthServer.SetServingStatus(gatewayv1.ToolExecutionService_ServiceDesc.ServiceName, status)
}

func (service *Service) serving() bool {
	response, err := service.healthServer.Check(context.Background(), &grpc_health_v1.HealthCheckRequest{})
	return err == nil && response.GetStatus() == grpc_health_v1.HealthCheckResponse_SERVING
}

// Execute dispatches one attempt to its handler.
func (service *Service) Execute(ctx context.Context, request *gatewayv1.ExecuteRequest) (*gatewayv1.ExecuteResponse, error) {
	service.mutex.RLock()
	tool, known := service.tools[request.GetToolId()]
	service.mutex.RUnlock()
	if !known {
		return &gatewayv1.ExecuteResponse{
			Outcome: gatewayv1.Outcome_OUTCOME_PERMANENT_FAILURE,
			Error:   fmt.Sprintf("%s does not serve %s", service.config.InstanceID, request.GetToolId()),
		}, nil
	}
	arguments := json.RawMessage(request.GetArguments())
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if deadline := request.GetDeadline(); deadline != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline.AsTime())
		defer cancel()
	}
	result := tool.Handler(ctx, Call{
		RunID:          request.GetRunId(),
		VertexID:       request.GetVertexId(),
		ScopeID:        request.GetScopeId(),
		AttemptNo:      request.GetAttemptNo(),
		ToolID:         request.GetToolId(),
		ToolVersion:    request.GetToolVersion(),
		IdempotencyKey: request.GetIdempotencyKey(),
		Arguments:      arguments,
		Deadline:       request.GetDeadline().AsTime(),
	})
	return renderResult(result)
}

var outcomeCodes = map[Outcome]gatewayv1.Outcome{
	OutcomeSucceeded:        gatewayv1.Outcome_OUTCOME_SUCCEEDED,
	OutcomeRetryableFailure: gatewayv1.Outcome_OUTCOME_RETRYABLE_FAILURE,
	OutcomePermanentFailure: gatewayv1.Outcome_OUTCOME_PERMANENT_FAILURE,
	OutcomeUnknown:          gatewayv1.Outcome_OUTCOME_UNKNOWN,
}

func renderResult(result Result) (*gatewayv1.ExecuteResponse, error) {
	code, known := outcomeCodes[result.Outcome]
	if !known {
		// A handler that returned no outcome has told us nothing about whether its
		// effect happened, and unknown is exactly that statement.
		return &gatewayv1.ExecuteResponse{Outcome: gatewayv1.Outcome_OUTCOME_UNKNOWN, Error: fmt.Sprintf("handler returned an unknown outcome %q", result.Outcome)}, nil
	}
	encoded := ""
	if result.Value != nil {
		payload, err := json.Marshal(result.Value)
		if err != nil {
			return &gatewayv1.ExecuteResponse{Outcome: gatewayv1.Outcome_OUTCOME_UNKNOWN, Error: fmt.Sprintf("result is not encodable: %v", err)}, nil
		}
		encoded = string(payload)
	}
	return &gatewayv1.ExecuteResponse{Outcome: code, Result: encoded, Error: result.Error}, nil
}

// Register declares this instance and its contracts to the gateway.
func (service *Service) Register(ctx context.Context) ([]*gatewayv1.ToolStatus, error) {
	client, err := service.registryClient()
	if err != nil {
		return nil, err
	}
	response, err := client.Register(ctx, &gatewayv1.RegisterRequest{
		Instance: service.instanceInfo(),
		Tools:    service.declaredContracts(),
		Health:   service.healthReport(),
	})
	if err != nil {
		return nil, fmt.Errorf("sdk: register: %w", err)
	}
	for _, status := range response.GetStatuses() {
		if status.GetState() == gatewayv1.ToolState_TOOL_STATE_REJECTED {
			service.logger.Error("tool registration rejected", "tool", status.GetToolId(), "code", status.GetCode().String(), "detail", status.GetDetail())
		}
	}
	return response.GetStatuses(), nil
}

// Run keeps the registration alive until the context is cancelled.
//
// Heartbeats are retried on transport failure, unlike a tool call: a heartbeat
// is idempotent control-plane traffic with no side effect, so repeating one is
// free, while repeating a tool call could duplicate a business effect.
//
// When the gateway reports the instance unknown, this re-registers. That is the
// whole recovery path for a gateway that deliberately keeps no durable registry:
// it restarts empty, and every live service tells it what it serves again.
func (service *Service) Run(ctx context.Context) error {
	ticker := time.NewTicker(service.config.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			client, err := service.registryClient()
			if err != nil {
				service.logger.Warn("gateway unreachable", "error", err)
				continue
			}
			response, err := client.Heartbeat(ctx, &gatewayv1.HeartbeatRequest{InstanceId: service.config.InstanceID, Health: service.healthReport()})
			if err != nil {
				service.logger.Warn("heartbeat failed", "error", err)
				continue
			}
			if !response.GetKnownInstance() {
				service.logger.Info("gateway does not know this instance; registering again")
				if _, err := service.Register(ctx); err != nil {
					service.logger.Warn("re-registration failed", "error", err)
				}
			}
		}
	}
}

// Shutdown deregisters and stops serving.
//
// Deregistration withdraws this instance's route. It does not withdraw the
// contracts: the published view and its digest are unchanged, so a subgraph
// frozen against them still resolves, and calls fail as unroutable rather than
// as unknown.
func (service *Service) Shutdown(ctx context.Context) error {
	service.SetServing(false)
	var failure error
	if client, err := service.registryClient(); err == nil {
		if _, err := client.Deregister(ctx, &gatewayv1.DeregisterRequest{InstanceId: service.config.InstanceID}); err != nil {
			failure = fmt.Errorf("sdk: deregister: %w", err)
		}
	}
	service.clientMutex.Lock()
	if service.connection != nil {
		_ = service.connection.Close()
		service.connection, service.client = nil, nil
	}
	service.clientMutex.Unlock()
	service.grpcServer.GracefulStop()
	return failure
}

func (service *Service) instanceInfo() *gatewayv1.InstanceInfo {
	return &gatewayv1.InstanceInfo{
		InstanceId: service.config.InstanceID,
		RouteId:    service.config.RouteID,
		Target:     service.config.Target,
		LeaseTtlMs: uint32(service.config.LeaseTTL.Milliseconds()),
	}
}

func (service *Service) healthReport() *gatewayv1.HealthReport {
	status := gatewayv1.ServingStatus_SERVING_STATUS_NOT_SERVING
	if service.serving() {
		status = gatewayv1.ServingStatus_SERVING_STATUS_SERVING
	}
	return &gatewayv1.HealthReport{Status: status}
}

// declaredContracts returns the contracts in a stable order, so two runs of the
// same service send byte-identical registrations.
func (service *Service) declaredContracts() []*gatewayv1.ToolContract {
	service.mutex.RLock()
	defer service.mutex.RUnlock()
	names := make([]string, 0, len(service.contracts))
	for name := range service.contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	contracts := make([]*gatewayv1.ToolContract, 0, len(names))
	for _, name := range names {
		contracts = append(contracts, service.contracts[name])
	}
	return contracts
}

func (service *Service) registryClient() (gatewayv1.RegistryServiceClient, error) {
	service.clientMutex.Lock()
	defer service.clientMutex.Unlock()
	if service.client != nil {
		return service.client, nil
	}
	connection, err := grpc.NewClient(service.config.GatewayAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("sdk: dial gateway %s: %w", service.config.GatewayAddress, err)
	}
	service.connection = connection
	service.client = gatewayv1.NewRegistryServiceClient(connection)
	return service.client, nil
}

// Deadline is a convenience for handlers that want the attempt's deadline as a
// protobuf timestamp, for example to forward it to a downstream system.
func Deadline(instant time.Time) *timestamppb.Timestamp {
	return timestamppb.New(instant)
}
