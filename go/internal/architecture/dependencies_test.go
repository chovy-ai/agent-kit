package architecture

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Project imports are explicit so a new cross-domain dependency needs review.
// The execution kernel and protobuf codec are private implementation details
// of the local and remote adapters respectively, not application dependencies.
func TestProductionDependenciesFollowModuleBoundaries(t *testing.T) {
	allowed := map[string][]string{
		"environment":             {},
		"environment/local":       {"environment", "internal/execution"},
		"internal/execution":      {"environment"},
		"internal/runner":         {"environment"},
		"remote":                  {"environment", "internal/remoteproto/v1"},
		"internal/remoteproto/v1": {},
		"internal/di":             {"environment", "environment/local", "internal/runner", "remote"},
		"cmd/runtime-runner":      {"internal/di", "internal/runner"},
		"cmd/remote-server":       {"environment/local", "internal/di"},
	}
	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		name, err := filepath.Rel(root, filepath.Dir(path))
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		dependencies, ok := allowed[name]
		if !ok {
			t.Errorf("%s has no declared dependency policy", name)
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if !strings.HasPrefix(imported, "agent-kit/") {
				if imported == "github.com/google/wire" && name != "internal/di" {
					t.Errorf("%s imports Wire outside startup", path)
				}
				continue
			}
			imported = strings.TrimPrefix(imported, "agent-kit/")
			permitted := false
			for _, candidate := range dependencies {
				permitted = permitted || imported == candidate
			}
			if !permitted {
				t.Errorf("%s imports %s across its declared boundary", path, imported)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
