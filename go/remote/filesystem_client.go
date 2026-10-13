package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"context"
	"errors"
	"google.golang.org/protobuf/proto"
	"time"
)

func (e *Environment) file(ctx context.Context, method string, in, out proto.Message) error {
	ctx, done, err := e.operation(ctx, 10*time.Second)
	if err != nil {
		return err
	}
	defer done()
	err = e.client.call(ctx, method, in, out, nil)
	var detail *environment.Error
	if errors.As(err, &detail) && detail.Reason == "NOT_SENT" {
		return err
	}
	if err != nil && (method == "filesystem.write" || method == "filesystem.mkdir") && (environment.Code(err) == "CONNECTION_CLOSED" || environment.Code(err) == "PROTOCOL_ERROR" || ctx.Err() != nil) {
		return &environment.Error{Code: "OUTCOME_UNKNOWN", Reason: "file mutation result not confirmed", MayHaveChanged: true, Cause: err}
	}
	return err
}
func (e *Environment) ReadFile(ctx context.Context, req environment.ReadRequest) ([]byte, error) {
	if req.Offset < 0 || req.Length < 0 || req.Length > 8<<20 {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid byte range", nil)
	}
	ctx, done, err := e.operation(ctx, 10*time.Second)
	if err != nil {
		return nil, err
	}
	defer done()
	limit := req.Length
	if limit == 0 {
		limit = 8<<20 + 1
	}
	result := []byte{}
	for int64(len(result)) < limit {
		length := min(limit-int64(len(result)), 65536)
		out := new(v1.ReadResponse)
		if err = e.client.call(ctx, "filesystem.read", &v1.ReadRequest{TargetId: e.target, Path: req.Path, Offset: req.Offset + int64(len(result)), Length: uint32(length)}, out, nil); err != nil {
			return nil, err
		}
		if len(out.Data) > int(length) || len(out.Data) == 0 && !out.Eof {
			return nil, environment.Fail("PROTOCOL_ERROR", "invalid read result", nil)
		}
		result = append(result, out.Data...)
		if out.Eof {
			break
		}
	}
	if len(result) > 8<<20 {
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "SDK file return limit", nil)
	}
	return result, nil
}
func (e *Environment) WriteFile(ctx context.Context, path string, data []byte) error {
	if data == nil {
		return environment.Fail("INVALID_ARGUMENT", "data required", nil)
	}
	if len(data) > 1<<20 {
		return environment.Fail("RESOURCE_EXHAUSTED", "file write limit", nil)
	}
	out := new(v1.WriteResponse)
	err := e.file(ctx, "filesystem.write", &v1.WriteRequest{TargetId: e.target, Path: path, Data: append([]byte{}, data...)}, out)
	if err == nil && out.BytesWritten != uint64(len(data)) {
		return environment.Fail("PROTOCOL_ERROR", "incomplete write result", nil)
	}
	return err
}
func kindFromProto(kind v1.FileType) string {
	switch kind {
	case v1.FileType_FILE_TYPE_FILE:
		return "file"
	case v1.FileType_FILE_TYPE_DIRECTORY:
		return "directory"
	case v1.FileType_FILE_TYPE_SYMLINK:
		return "symlink"
	case v1.FileType_FILE_TYPE_OTHER:
		return "other"
	default:
		return ""
	}
}
func (e *Environment) ReadDir(ctx context.Context, path string) ([]environment.DirectoryEntry, error) {
	out := new(v1.ReadDirResponse)
	if err := e.file(ctx, "filesystem.readDir", &v1.ReadDirRequest{TargetId: e.target, Path: path}, out); err != nil {
		return nil, err
	}
	if len(out.Entries) > 10000 || proto.Size(out) > 1<<20 {
		return nil, environment.Fail("PROTOCOL_ERROR", "directory response limit", nil)
	}
	entries := make([]environment.DirectoryEntry, 0, len(out.Entries))
	previous := ""
	for i, item := range out.Entries {
		kind := kindFromProto(item.Type)
		if kind == "" || item.Name == "" || i > 0 && item.Name <= previous {
			return nil, environment.Fail("PROTOCOL_ERROR", "invalid directory entry", nil)
		}
		previous = item.Name
		entries = append(entries, environment.DirectoryEntry{Name: item.Name, Type: kind})
	}
	return entries, nil
}
func (e *Environment) Stat(ctx context.Context, path string, follow bool) (environment.FileInfo, error) {
	out := new(v1.StatResponse)
	if err := e.file(ctx, "filesystem.stat", &v1.StatRequest{TargetId: e.target, Path: path, FollowSymlinks: follow}, out); err != nil {
		return environment.FileInfo{}, err
	}
	if out.Info == nil || kindFromProto(out.Info.Type) == "" || out.Info.ModifiedAt == nil || out.Info.ModifiedAt.CheckValid() != nil {
		return environment.FileInfo{}, environment.Fail("PROTOCOL_ERROR", "invalid stat result", nil)
	}
	return environment.FileInfo{Type: kindFromProto(out.Info.Type), Size: out.Info.Size, ModifiedAt: out.Info.ModifiedAt.AsTime()}, nil
}
func (e *Environment) Mkdir(ctx context.Context, path string, recursive bool) error {
	return e.file(ctx, "filesystem.mkdir", &v1.MkdirRequest{TargetId: e.target, Path: path, Recursive: recursive}, new(v1.MkdirResponse))
}
