module agent-kit

go 1.25.0

require (
	github.com/coder/websocket v1.8.15
	github.com/google/wire v0.7.0
	golang.org/x/sys v0.38.0
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/google/subcommands v1.2.0 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	golang.org/x/mod v0.20.0 // indirect
	golang.org/x/sync v0.8.0 // indirect
	golang.org/x/tools v0.24.1 // indirect
)

tool (
	github.com/google/wire/cmd/wire
	google.golang.org/protobuf/cmd/protoc-gen-go
)
