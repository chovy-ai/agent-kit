#!/bin/sh
set -eu
agent_kit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_kit_protoc=$(command -v protoc)
agent_kit_plugin=$(cd "$agent_kit_root/go" && go tool -n protoc-gen-go)
agent_kit_include=$(dirname "$agent_kit_protoc")/../include
protoc -I "$agent_kit_root/protocol/remote/v1" -I "$agent_kit_include" \
  --plugin="protoc-gen-go=$agent_kit_plugin" \
  --go_out="$agent_kit_root/go/internal/remoteproto/v1" --go_opt=paths=source_relative \
  --go_opt=Mchannel.proto=agent-kit/internal/remoteproto/v1 \
  --go_opt=Msystem.proto=agent-kit/internal/remoteproto/v1 \
  --go_opt=Mfilesystem.proto=agent-kit/internal/remoteproto/v1 \
  --go_opt=Mprocess.proto=agent-kit/internal/remoteproto/v1 \
  channel.proto system.proto filesystem.proto process.proto
