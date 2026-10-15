package runner

import (
	"agent-kit/environment"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxConfigBytes = 64 * 1024

// namedDefinitions rejects duplicate names instead of silently selecting a target.
type namedDefinitions map[string]environment.Definition

func (definitions *namedDefinitions) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fmt.Errorf("environments must be an object")
	}
	result := namedDefinitions{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		name := token.(string)
		if _, exists := result[name]; exists {
			return fmt.Errorf("duplicate environment name %q", name)
		}
		var definition environment.Definition
		if err := decoder.Decode(&definition); err != nil {
			return err
		}
		result[name] = definition
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	*definitions = result
	return nil
}

// ParseEnvironmentConfig resolves relative paths against the configuration's location.
func ParseEnvironmentConfig(data []byte, baseDir string) (map[string]environment.Definition, error) {
	if len(data) > MaxConfigBytes {
		return nil, fmt.Errorf("environment config exceeds %d bytes", MaxConfigBytes)
	}
	var document struct {
		Version      int              `json:"version"`
		Environments namedDefinitions `json:"environments"`
	}
	if err := decode(data, &document); err != nil {
		return nil, fmt.Errorf("environment config: %w", err)
	}
	if document.Version != 1 {
		return nil, fmt.Errorf("unsupported environment config version %d", document.Version)
	}
	if err := environment.ValidateDefinitions(document.Environments); err != nil {
		return nil, err
	}
	baseDir, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, err
	}
	for name, definition := range document.Environments {
		if !filepath.IsAbs(definition.Cwd) {
			definition.Cwd = filepath.Join(baseDir, definition.Cwd)
		}
		// Bare executable names retain PATH lookup; relative paths use the config directory.
		if !filepath.IsAbs(definition.Bash) && strings.ContainsAny(definition.Bash, `/\`) {
			definition.Bash = filepath.Join(baseDir, definition.Bash)
		}
		document.Environments[name] = definition
	}
	return document.Environments, nil
}

func LoadEnvironmentConfig(path string) (map[string]environment.Definition, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxConfigBytes+1))
	if err != nil {
		return nil, err
	}
	return ParseEnvironmentConfig(data, filepath.Dir(path))
}
