#!/bin/sh
set -eu

PROJECT_REF="qxlfnscmrhwfcpattqxa"
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if command -v supabase >/dev/null 2>&1; then
  SUPABASE_BIN=$(command -v supabase)
elif [ -x "$HOME/.local/bin/supabase" ]; then
  SUPABASE_BIN="$HOME/.local/bin/supabase"
else
  echo "Supabase CLI is not installed or executable." >&2
  exit 1
fi

cd "$ROOT_DIR"

if [ ! -f supabase/config.toml ]; then
  echo "Run this command from the Lucre repository with supabase/config.toml present." >&2
  exit 1
fi

if [ ! -f supabase/.temp/project-ref ]; then
  echo "Project is not linked. Run: supabase link --project-ref $PROJECT_REF" >&2
  exit 1
fi

LINKED_REF=$(tr -d '\r\n' < supabase/.temp/project-ref)
if [ "$LINKED_REF" != "$PROJECT_REF" ]; then
  echo "Refusing to continue: linked project is $LINKED_REF, expected $PROJECT_REF." >&2
  exit 1
fi

MODE=${1:-check}

case "$MODE" in
  check)
    "$SUPABASE_BIN" migration list --linked --agent no --output-format text
    "$SUPABASE_BIN" functions list --project-ref "$PROJECT_REF" --agent no --output-format text
    ;;
  plan)
    "$SUPABASE_BIN" db push --linked --dry-run --agent no --output-format text
    ;;
  apply)
    if [ "${SUPABASE_DEPLOY_CONFIRM:-}" != "$PROJECT_REF" ]; then
      echo "Production deployment blocked." >&2
      echo "Set SUPABASE_DEPLOY_CONFIRM=$PROJECT_REF to apply migrations and deploy functions." >&2
      exit 1
    fi
    "$SUPABASE_BIN" db push --linked --agent no --output-format text
    "$SUPABASE_BIN" functions deploy --project-ref "$PROJECT_REF" --use-api --jobs 4 --agent no --output-format text
    "$SUPABASE_BIN" functions list --project-ref "$PROJECT_REF" --agent no --output-format text
    ;;
  *)
    echo "Usage: $0 [check|plan|apply]" >&2
    exit 1
    ;;
esac
