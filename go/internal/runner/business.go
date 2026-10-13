package runner

import (
	"agent-kit/environment"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"
)

var BusinessMethods = []string{"environment.list", "filesystem.read", "filesystem.write", "filesystem.readDir", "filesystem.stat", "filesystem.mkdir", "process.exec"}

func (s *Server) business(ctx context.Context, request Request) (any, *RPCError) {
	known := false
	for _, method := range BusinessMethods {
		if request.Method == method {
			known = true
			break
		}
	}
	if !known {
		return nil, &RPCError{Code: "UNKNOWN_METHOD", Message: "Method not available"}
	}
	failure := func(err error) (any, *RPCError) {
		out := &RPCError{Code: environment.Code(err), Message: err.Error()}
		var detail *environment.Error
		if errors.As(err, &detail) {
			mutation := "not_started"
			if detail.MayHaveChanged {
				mutation = "may_have_changed"
			}
			out.Details = map[string]any{"reason": detail.Reason, "mutationState": mutation}
		}
		return nil, out
	}
	if request.Method == "environment.list" {
		if params(request, &struct{}{}) != nil {
			return nil, &RPCError{Code: "INVALID_PARAMS", Message: "Expected empty parameters"}
		}
		ids := s.directory.IDs()
		sort.Strings(ids)
		return map[string]any{"environments": ids}, nil
	}
	var in struct {
		EnvironmentID  string            `json:"environmentId"`
		Path           string            `json:"path,omitempty"`
		Offset         string            `json:"offset,omitempty"`
		Length         int64             `json:"length,omitempty"`
		Data           *string           `json:"data,omitempty"`
		Recursive      bool              `json:"recursive,omitempty"`
		Follow         bool              `json:"followSymlinks,omitempty"`
		Command        string            `json:"command,omitempty"`
		Cwd            string            `json:"cwd,omitempty"`
		Env            map[string]string `json:"env,omitempty"`
		TimeoutMs      int64             `json:"timeoutMs,omitempty"`
		MaxOutputBytes int64             `json:"maxOutputBytes,omitempty"`
	}
	if err := params(request, &in); err != nil {
		return nil, &RPCError{Code: "INVALID_PARAMS", Message: err.Error()}
	}
	target, err := s.directory.Get(in.EnvironmentID)
	if err != nil {
		return failure(err)
	}
	switch request.Method {
	case "filesystem.read":
		offset := int64(0)
		if in.Offset != "" {
			offset, err = strconv.ParseInt(in.Offset, 10, 64)
			if err != nil {
				return nil, &RPCError{Code: "INVALID_PARAMS", Message: "offset must be a decimal int64"}
			}
		}
		if in.Length < 0 || in.Length > 512<<10 {
			return failure(environment.Fail("RESOURCE_EXHAUSTED", "Agent read limit", nil))
		}
		length := in.Length
		if length == 0 {
			length = 512<<10 + 1
		}
		data, err := target.Filesystem().ReadFile(ctx, environment.ReadRequest{Path: in.Path, Offset: offset, Length: length})
		if err != nil {
			return failure(err)
		}
		if len(data) > 512<<10 {
			return failure(environment.Fail("RESOURCE_EXHAUSTED", "Agent read limit", nil))
		}
		return map[string]any{"data": data}, nil
	case "filesystem.write":
		if in.Data == nil {
			return nil, &RPCError{Code: "INVALID_PARAMS", Message: "base64 data required"}
		}
		if len(*in.Data) > base64.StdEncoding.EncodedLen(512<<10) {
			return failure(environment.Fail("RESOURCE_EXHAUSTED", "Agent write limit", nil))
		}
		data, err := base64.StdEncoding.Strict().DecodeString(*in.Data)
		if err != nil {
			return nil, &RPCError{Code: "INVALID_PARAMS", Message: "data must be base64"}
		}
		if data == nil {
			data = []byte{}
		}
		if err = target.Filesystem().WriteFile(ctx, in.Path, data); err != nil {
			return failure(err)
		}
		return map[string]any{"bytesWritten": strconv.Itoa(len(data))}, nil
	case "filesystem.readDir":
		entries, err := target.Filesystem().ReadDir(ctx, in.Path)
		if err != nil {
			return failure(err)
		}
		return map[string]any{"entries": entries}, nil
	case "filesystem.stat":
		info, err := target.Filesystem().Stat(ctx, in.Path, in.Follow)
		if err != nil {
			return failure(err)
		}
		return map[string]any{"type": info.Type, "size": strconv.FormatInt(info.Size, 10), "modifiedAt": info.ModifiedAt.UTC().Format(time.RFC3339Nano)}, nil
	case "filesystem.mkdir":
		if err := target.Filesystem().Mkdir(ctx, in.Path, in.Recursive); err != nil {
			return failure(err)
		}
		return map[string]any{"created": true}, nil
	case "process.exec":
		if in.TimeoutMs < 0 || in.TimeoutMs > 3600000 || in.MaxOutputBytes < 0 || in.MaxOutputBytes > 8<<20 {
			return nil, &RPCError{Code: "INVALID_PARAMS", Message: "invalid execution budget"}
		}
		result, execErr := target.Process().Exec(ctx, environment.ExecRequest{Command: in.Command, Cwd: in.Cwd, Env: in.Env, Timeout: time.Duration(in.TimeoutMs) * time.Millisecond, MaxOutputBytes: in.MaxOutputBytes}, func(_ context.Context, chunk environment.OutputChunk) error { return s.event(request.ID, chunk) })
		out := map[string]any{"completion": result.Completion, "exitCode": result.ExitCode, "signal": result.Signal, "durationMs": int64(result.Duration / time.Millisecond), "outputTruncated": result.OutputTruncated, "outputIncomplete": result.OutputIncomplete}
		if execErr != nil {
			out["executionError"] = &RPCError{Code: environment.Code(execErr), Message: execErr.Error()}
		}
		return out, nil
	default:
		return nil, &RPCError{Code: "UNKNOWN_METHOD", Message: "Method not available"}
	}
}
func (s *Server) event(id string, chunk environment.OutputChunk) error {
	limit := max(1, (s.config.MaxMessageBytes-256)*3/4)
	for len(chunk.Data) > limit {
		part := environment.OutputChunk{Stream: chunk.Stream, Data: chunk.Data[:limit]}
		if err := s.eventFrame(id, part); err != nil {
			return err
		}
		chunk.Data = chunk.Data[limit:]
	}
	return s.eventFrame(id, chunk)
}
func (s *Server) eventFrame(id string, chunk environment.OutputChunk) error {
	data, err := json.Marshal(Response{Version: ProtocolVersion, ID: id, Type: "event", Event: "process.output", Data: map[string]any{"stream": chunk.Stream, "data": chunk.Data}})
	if err != nil {
		return err
	}
	if len(data) > s.config.MaxMessageBytes {
		return fmt.Errorf("output event exceeds message limit")
	}
	s.outputMu.Lock()
	defer s.outputMu.Unlock()
	_, err = s.streams.Output.Write(append(data, '\n'))
	return err
}
