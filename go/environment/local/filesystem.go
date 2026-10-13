package local

import (
	"agent-kit/environment"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"
)

const MaxFileBytes = 8 << 20
const MaxWriteBytes = 1 << 20

type filesystem struct{ env *Environment }

func (f *filesystem) path(ctx context.Context, name string) (string, error) {
	if err := f.env.check(ctx); err != nil {
		return "", err
	}
	if name == "" || len(name) > 65536 || !utf8.ValidString(name) || strings.ContainsRune(name, 0) {
		return "", environment.Fail("INVALID_ARGUMENT", "invalid path", nil)
	}
	if !filepath.IsAbs(name) {
		name = filepath.Join(f.env.DefaultCwd(), name)
	}
	return name, nil
}
func fileError(err error, mutated bool) error {
	if err == nil {
		return nil
	}
	code, reason := "UNKNOWN", "IO_ERROR"
	switch {
	case errors.Is(err, os.ErrNotExist):
		code, reason = "NOT_FOUND", "PATH_NOT_FOUND"
	case errors.Is(err, os.ErrExist):
		code, reason = "ALREADY_EXISTS", "ALREADY_EXISTS"
	case errors.Is(err, os.ErrPermission):
		code, reason = "PERMISSION_DENIED", "ACCESS_DENIED"
	case errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.EISDIR):
		code, reason = "FAILED_PRECONDITION", "TYPE_MISMATCH"
	case errors.Is(err, context.Canceled):
		code, reason = "CANCELLED", "CANCELLED"
	case errors.Is(err, context.DeadlineExceeded):
		code, reason = "DEADLINE_EXCEEDED", "DEADLINE_EXCEEDED"
	}
	return &environment.Error{Code: code, Reason: reason, Cause: err, MayHaveChanged: mutated}
}
func (f *filesystem) ReadFile(ctx context.Context, req environment.ReadRequest) ([]byte, error) {
	ctx, done, err := f.env.operation(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	path, err := f.path(ctx, req.Path)
	if err != nil {
		return nil, err
	}
	if req.Offset < 0 || req.Length < 0 || req.Length > MaxFileBytes {
		return nil, environment.Fail("INVALID_ARGUMENT", "invalid byte range", nil)
	}
	h, err := os.Open(path)
	if err != nil {
		return nil, fileError(err, false)
	}
	defer h.Close()
	if _, err = h.Seek(req.Offset, io.SeekStart); err != nil {
		return nil, fileError(err, false)
	}
	limit := req.Length
	if limit == 0 {
		limit = MaxFileBytes + 1
	}
	data := make([]byte, 0)
	buf := make([]byte, 65536)
	for int64(len(data)) < limit {
		if err := ctx.Err(); err != nil {
			return nil, fileError(err, false)
		}
		n, err := h.Read(buf[:min(int64(len(buf)), limit-int64(len(data)))])
		data = append(data, buf[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fileError(err, false)
		}
	}
	if len(data) > MaxFileBytes {
		return nil, environment.Fail("RESOURCE_EXHAUSTED", "file read limit", nil)
	}
	return data, nil
}
func (f *filesystem) WriteFile(ctx context.Context, path string, data []byte) error {
	ctx, done, err := f.env.operation(ctx)
	if err != nil {
		return err
	}
	defer done()
	path, err = f.path(ctx, path)
	if err != nil {
		return err
	}
	if data == nil {
		return environment.Fail("INVALID_ARGUMENT", "data required", nil)
	}
	if len(data) > MaxWriteBytes {
		return environment.Fail("RESOURCE_EXHAUSTED", "write limit", nil)
	}
	data = append([]byte{}, data...)
	if err := ctx.Err(); err != nil {
		return fileError(err, false)
	}
	h, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0666)
	if err != nil {
		return fileError(err, false)
	}
	n, writeErr := h.Write(data)
	if writeErr == nil && n != len(data) {
		writeErr = io.ErrShortWrite
	}
	return fileError(errors.Join(writeErr, h.Close()), true)
}
func kind(mode os.FileMode) string {
	switch {
	case mode&os.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "directory"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}
func (f *filesystem) ReadDir(ctx context.Context, path string) ([]environment.DirectoryEntry, error) {
	ctx, done, err := f.env.operation(ctx)
	if err != nil {
		return nil, err
	}
	defer done()
	path, err = f.path(ctx, path)
	if err != nil {
		return nil, err
	}
	h, err := os.Open(path)
	if err != nil {
		return nil, fileError(err, false)
	}
	defer h.Close()
	items := []environment.DirectoryEntry{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, fileError(err, false)
		}
		entries, err := h.ReadDir(256)
		for _, e := range entries {
			if !utf8.ValidString(e.Name()) {
				return nil, environment.Fail("FAILED_PRECONDITION", "PATH_ENCODING_UNSUPPORTED", nil)
			}
			items = append(items, environment.DirectoryEntry{Name: e.Name(), Type: kind(e.Type())})
		}
		if len(items) > 10000 {
			return nil, environment.Fail("RESOURCE_EXHAUSTED", "directory limit", nil)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fileError(err, false)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}
func (f *filesystem) Stat(ctx context.Context, path string, follow bool) (environment.FileInfo, error) {
	ctx, done, err := f.env.operation(ctx)
	if err != nil {
		return environment.FileInfo{}, err
	}
	defer done()
	path, err = f.path(ctx, path)
	if err != nil {
		return environment.FileInfo{}, err
	}
	var info os.FileInfo
	if follow {
		info, err = os.Stat(path)
	} else {
		info, err = os.Lstat(path)
	}
	if err != nil {
		return environment.FileInfo{}, fileError(err, false)
	}
	return environment.FileInfo{Type: kind(info.Mode()), Size: info.Size(), ModifiedAt: info.ModTime()}, nil
}
func (f *filesystem) Mkdir(ctx context.Context, path string, recursive bool) error {
	ctx, done, err := f.env.operation(ctx)
	if err != nil {
		return err
	}
	defer done()
	path, err = f.path(ctx, path)
	if err != nil {
		return err
	}
	if recursive {
		err = os.MkdirAll(path, 0777)
	} else {
		err = os.Mkdir(path, 0777)
	}
	return fileError(err, recursive)
}
