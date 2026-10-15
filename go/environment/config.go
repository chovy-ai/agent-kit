package environment

import (
	"fmt"
	"regexp"
	"strings"
)

// Definition describes a named instance. Configuration currently supports local only.
type Definition struct {
	Type string `json:"type"`
	Cwd  string `json:"cwd,omitempty"`
	Bash string `json:"bash,omitempty"`
}

var environmentName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func ValidateDefinitions(definitions map[string]Definition) error {
	if len(definitions) == 0 || len(definitions) > 64 {
		return Fail("INVALID_ARGUMENT", "configure between 1 and 64 environments", nil)
	}
	for name, definition := range definitions {
		if !environmentName.MatchString(name) {
			return Fail("INVALID_ARGUMENT", fmt.Sprintf("invalid environment name %q", name), nil)
		}
		if definition.Type != "local" {
			return Fail("INVALID_ARGUMENT", fmt.Sprintf("environment %q: only type local is supported in configuration", name), nil)
		}
		if strings.ContainsRune(definition.Cwd, 0) || strings.ContainsRune(definition.Bash, 0) {
			return Fail("INVALID_ARGUMENT", fmt.Sprintf("environment %q: invalid path", name), nil)
		}
	}
	return nil
}
