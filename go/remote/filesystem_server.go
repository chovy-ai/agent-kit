package remote

import (
	"agent-kit/environment"
	v1 "agent-kit/internal/remoteproto/v1"
	"context"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func fileType(kind string) v1.FileType {
	switch kind {
	case "file":
		return v1.FileType_FILE_TYPE_FILE
	case "directory":
		return v1.FileType_FILE_TYPE_DIRECTORY
	case "symlink":
		return v1.FileType_FILE_TYPE_SYMLINK
	default:
		return v1.FileType_FILE_TYPE_OTHER
	}
}
func (s *session) handle(ctx context.Context, msg *v1.Envelope) (proto.Message, error) {
	req := msg.GetRequest()
	invalid := func() (proto.Message, error) {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid method body", nil)
	}
	switch req.Method {
	case "environment.getInfo":
		var in v1.GetInfoRequest
		if proto.Unmarshal(req.Body, &in) != nil {
			return invalid()
		}
		return s.getInfo(in.TargetId)
	case "request.cancel":
		var in v1.CancelRequest
		if proto.Unmarshal(req.Body, &in) != nil || in.RequestId == "" || in.RequestId == msg.RequestId {
			return invalid()
		}
		s.mu.Lock()
		cancel := s.active[in.RequestId]
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return &v1.CancelRequestResponse{Accepted: cancel != nil}, nil
	case "process.exec":
		return s.exec(ctx, msg)
	case "process.cancel":
		return s.cancelExecution(msg)
	case "process.getState":
		return s.getState(msg)
	}
	if !acquire(s.files) {
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "session file concurrency", nil)
	}
	defer func() { <-s.files }()
	if !acquire(s.s.files) {
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "global file concurrency", nil)
	}
	defer func() { <-s.s.files }()
	switch req.Method {
	case "filesystem.read":
		var in v1.ReadRequest
		if proto.Unmarshal(req.Body, &in) != nil || in.Length == 0 || in.Length > 65536 || in.Offset < 0 {
			return invalid()
		}
		target, err := s.target(in.TargetId)
		if err != nil {
			return nil, err
		}
		data, err := target.Filesystem().ReadFile(ctx, environment.ReadRequest{Path: in.Path, Offset: in.Offset, Length: int64(in.Length)})
		return &v1.ReadResponse{Data: data, Eof: len(data) < int(in.Length)}, err
	case "filesystem.write":
		var in v1.WriteRequest
		if proto.Unmarshal(req.Body, &in) != nil || in.Data == nil {
			return invalid()
		}
		target, err := s.target(in.TargetId)
		if err != nil {
			return nil, err
		}
		err = target.Filesystem().WriteFile(ctx, in.Path, in.Data)
		return &v1.WriteResponse{BytesWritten: uint64(len(in.Data))}, err
	case "filesystem.readDir":
		var in v1.ReadDirRequest
		if proto.Unmarshal(req.Body, &in) != nil {
			return invalid()
		}
		target, err := s.target(in.TargetId)
		if err != nil {
			return nil, err
		}
		entries, err := target.Filesystem().ReadDir(ctx, in.Path)
		if err != nil {
			return nil, err
		}
		out := &v1.ReadDirResponse{}
		for _, e := range entries {
			out.Entries = append(out.Entries, &v1.DirectoryEntry{Name: e.Name, Type: fileType(e.Type)})
		}
		if proto.Size(out) > 1<<20 {
			return nil, environment.Fail("RESOURCE_EXHAUSTED", "directory response limit", nil)
		}
		return out, nil
	case "filesystem.stat":
		var in v1.StatRequest
		if proto.Unmarshal(req.Body, &in) != nil {
			return invalid()
		}
		target, err := s.target(in.TargetId)
		if err != nil {
			return nil, err
		}
		info, err := target.Filesystem().Stat(ctx, in.Path, in.FollowSymlinks)
		return &v1.StatResponse{Info: &v1.FileInfo{Type: fileType(info.Type), Size: info.Size, ModifiedAt: timestamppb.New(info.ModifiedAt)}}, err
	case "filesystem.mkdir":
		var in v1.MkdirRequest
		if proto.Unmarshal(req.Body, &in) != nil {
			return invalid()
		}
		target, err := s.target(in.TargetId)
		if err != nil {
			return nil, err
		}
		return &v1.MkdirResponse{}, target.Filesystem().Mkdir(ctx, in.Path, in.Recursive)
	default:
		return nil, environment.Fail("UNKNOWN_METHOD", "unknown remote method", nil)
	}
}
