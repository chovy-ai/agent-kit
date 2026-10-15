package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNamedConfigurationResolvesAgainstFileDirectory(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "environments.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"environments":{"workspace":{"type":"local","cwd":"project","bash":"./tools/bash"},"scratch":{"type":"local","bash":"bash"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	definitions, err := LoadEnvironmentConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if definitions["workspace"].Cwd != filepath.Join(base, "project") || definitions["workspace"].Bash != filepath.Join(base, "tools", "bash") || definitions["scratch"].Cwd != base || definitions["scratch"].Bash != "bash" {
		t.Fatalf("unexpected definitions: %#v", definitions)
	}
}

func TestNamedConfigurationRejectsAmbiguousOrUnsupportedTargets(t *testing.T) {
	for _, document := range []string{
		`{"version":1,"environments":{"same":{"type":"local"},"same":{"type":"local"}}}`,
		`{"version":1,"environments":{"x":{"type":"remote"}}}`,
		`{"version":1,"environments":{"x":{"type":"local","cwwd":"."}}}`,
		`{"version":1,"environments":{"../x":{"type":"local"}}}`,
		`{"version":1,"environments":{}}`, `{"version":1,"environments":null}`,
		`{"version":2,"environments":{"x":{"type":"local"}}}`,
		`{"version":1,"environments":{"x":null}}`, `null`,
		`{"version":1,"environments":{"x":{"type":"local"}}} {}`,
		strings.Repeat(" ", MaxConfigBytes+1),
	} {
		if _, err := ParseEnvironmentConfig([]byte(document), t.TempDir()); err == nil {
			t.Fatalf("accepted invalid configuration: %.160s", document)
		}
	}
}
