#!/bin/sh
set -eu

agent_kit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$agent_kit_root"
npm run typecheck
npm run build:ts

agent_kit_wire_snapshot=$(mktemp)
agent_kit_proto_snapshot=$(mktemp -d)
trap 'rm -f "$agent_kit_wire_snapshot"; rm -rf "$agent_kit_proto_snapshot"' EXIT HUP INT TERM
cp go/internal/di/wire_gen.go "$agent_kit_wire_snapshot"
npm run generate:wire
if ! cmp -s "$agent_kit_wire_snapshot" go/internal/di/wire_gen.go; then
  echo "Wire output changed; review generated code and run the checks again." >&2
  exit 1
fi

cp go/internal/remoteproto/v1/*.pb.go "$agent_kit_proto_snapshot/"
npm run generate:protocol
for agent_kit_generated in go/internal/remoteproto/v1/*.pb.go; do
  if ! cmp -s "$agent_kit_generated" "$agent_kit_proto_snapshot/$(basename "$agent_kit_generated")"; then
    echo "Protobuf output changed; review generated code and run the checks again." >&2
    exit 1
  fi
done

cd go
agent_kit_unformatted=$(gofmt -l cmd internal environment remote)
if [ -n "$agent_kit_unformatted" ]; then
  echo "$agent_kit_unformatted" >&2
  echo "Go files need formatting." >&2
  exit 1
fi
go vet ./...
go test -race ./...
cd "$agent_kit_root"
npm test
node dist/main.js
