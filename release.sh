#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")"

echo "🔍 Pre-flight checks..."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit changes first."
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "❌ Not on main."
  exit 1
fi
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "❌ Local main differs from origin/main."
  exit 1
fi

echo "🧪 Running tests..."
npm test

echo "📦 Bumping version: $BUMP"
npm version "$BUMP" --message "v%s"
NEW_VERSION=$(node -p "require('./package.json').version")

echo "📤 Pushing main and v${NEW_VERSION} tag..."
git push origin main --follow-tags

echo "✅ Release v${NEW_VERSION} triggered"
echo "   Actions: https://github.com/jo-inc/pi-reflect/actions"
echo "   Package: https://www.npmjs.com/package/@askjo/pi-reflect"
