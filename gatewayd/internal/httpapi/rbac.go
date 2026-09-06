package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/linuxb/flory-ai/gatewayd/internal/authn"
	"github.com/linuxb/flory-ai/gatewayd/internal/rbac"
)

// RBACAdminConfig enables the mTLS-only RBAC administration routes.
type RBACAdminConfig struct {
	Store          *rbac.Store
	AdminSPIFFEIDs map[string]bool
}

type roleRequest struct {
	Description      string `json:"description"`
	Enabled          bool   `json:"enabled"`
	ExpectedRevision int64  `json:"expected_revision"`
}
type subjectRequest struct {
	Issuer           string   `json:"issuer"`
	Subject          string   `json:"subject"`
	Roles            []string `json:"roles"`
	Enabled          bool     `json:"enabled"`
	ExpectedRevision int64    `json:"expected_revision"`
}

func mutation(request *http.Request, actor string, expected int64) (rbac.Mutation, bool) {
	requestID, key := request.Header.Get("X-Request-ID"), request.Header.Get("Idempotency-Key")
	if requestID == "" || key == "" {
		return rbac.Mutation{}, false
	}
	return rbac.Mutation{ActorSPIFFEID: actor, RequestID: requestID, IdempotencyKey: key, ExpectedRevision: expected}, true
}

func adminActor(writer http.ResponseWriter, request *http.Request, allowed map[string]bool) (string, bool) {
	actor, err := authn.SPIFFEID(request)
	if err != nil || !allowed[actor] {
		writeJSON(writer, http.StatusUnauthorized, map[string]string{"error": "RBAC administrator mTLS identity is required"})
		return "", false
	}
	return actor, true
}

func mountRBACAdmin(mux *http.ServeMux, config RBACAdminConfig) {
	if config.Store == nil {
		return
	}
	mux.HandleFunc("PUT /admin/v1/roles/{role}", func(writer http.ResponseWriter, request *http.Request) {
		actor, ok := adminActor(writer, request, config.AdminSPIFFEIDs)
		if !ok {
			return
		}
		var input roleRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		change, ok := mutation(request, actor, input.ExpectedRevision)
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "X-Request-ID and Idempotency-Key are required"})
			return
		}
		result, err := config.Store.PutRole(request.Context(), change, rbac.Role{RoleID: request.PathValue("role"), Description: input.Description, Enabled: input.Enabled})
		if err != nil {
			writeRBACError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	})
	mux.HandleFunc("PUT /admin/v1/subjects/roles", func(writer http.ResponseWriter, request *http.Request) {
		actor, ok := adminActor(writer, request, config.AdminSPIFFEIDs)
		if !ok {
			return
		}
		var input subjectRequest
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		change, ok := mutation(request, actor, input.ExpectedRevision)
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "X-Request-ID and Idempotency-Key are required"})
			return
		}
		result, err := config.Store.ReplaceSubjectRoles(request.Context(), change, rbac.Subject{Issuer: input.Issuer, Subject: input.Subject, Roles: input.Roles, Enabled: input.Enabled})
		if err != nil {
			writeRBACError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	})
	mux.HandleFunc("GET /admin/v1/subjects/roles", func(writer http.ResponseWriter, request *http.Request) {
		if _, ok := adminActor(writer, request, config.AdminSPIFFEIDs); !ok {
			return
		}
		result, err := config.Store.Subject(request.Context(), request.URL.Query().Get("issuer"), request.URL.Query().Get("subject"))
		if err != nil {
			writeRBACError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, result)
	})
	mux.HandleFunc("GET /admin/v1/subjects/audit", func(writer http.ResponseWriter, request *http.Request) {
		if _, ok := adminActor(writer, request, config.AdminSPIFFEIDs); !ok {
			return
		}
		result, err := config.Store.Audit(request.Context(), request.URL.Query().Get("issuer"), request.URL.Query().Get("subject"))
		if err != nil {
			writeRBACError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"entries": result})
	})
}

func writeRBACError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	if strings.Contains(err.Error(), "revision conflict") {
		status = http.StatusConflict
	}
	writeJSON(writer, status, map[string]string{"error": err.Error()})
}
