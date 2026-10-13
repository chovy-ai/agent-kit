package runner

import (
	"encoding/json"
)

const ProtocolVersion = 1

var Methods = []string{"system.hello", "system.ping", "request.cancel", "system.shutdown"}

type Request struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type RPCError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type Response struct {
	Version int       `json:"version"`
	ID      string    `json:"id"`
	Type    string    `json:"type"`
	Result  any       `json:"result,omitempty"`
	Error   *RPCError `json:"error,omitempty"`
	Event   string    `json:"event,omitempty"`
	Data    any       `json:"data,omitempty"`
}
