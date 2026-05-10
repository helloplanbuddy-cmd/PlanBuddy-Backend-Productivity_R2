# Monorepo Workspace Skills

## Overview

This is an NX-powered monorepo using npm workspaces. All applications live in `apps/` and shared libraries in `libs/`.

## Tech Stack

- **Package Manager**: npm with workspaces
- **Monorepo Tool**: NX for task orchestration and caching
- **Node Version**: Managed via `.nvmrc` (auto-switch with nvm)
- **Language**: TypeScript (shared `tsconfig.json` at root)

## Directory Structure

```
planbuddy-backend/
  apps/              # Application projects (backends, frontends)
  libs/              # Shared TypeScript libraries
  deployments/
    local/           # Docker Compose for local services
  scripts/           # Utility scripts (encrypt-env, decrypt-env, copy-files)
  services/          # External service configs
  .hubai/            # HubAI workspace metadata and skills
  .husky/            # Git hooks (pre-commit, commit-msg)
  .vscode/           # Editor settings and recommended extensions
```

## NX Commands

```bash
# Run a target for a specific app
npx nx run <app-name>:<target>

# Run targets across all projects
npx nx run-many --target=build
npx nx run-many --target=test
npx nx run-many --target=lint

# Visualize project graph
npx nx graph
```

## Commit Conventions

This workspace uses **Conventional Commits** with **gitmoji** via Commitizen and Commitlint.

### Commit Format

```
<type>(<scope>): <subject>
```

### Commit Flow

```bash
# Use commitizen for guided commits
npx cz

# Or commit manually following the format
git commit -m "feat(app-name): add user authentication"
```

### Allowed Types

- `feat` -- New feature
- `fix` -- Bug fix
- `docs` -- Documentation only
- `style` -- Code style (formatting, semicolons)
- `refactor` -- Code change that neither fixes a bug nor adds a feature
- `perf` -- Performance improvement
- `test` -- Adding or updating tests
- `build` -- Build system or external dependencies
- `ci` -- CI configuration
- `chore` -- Maintenance tasks
- `revert` -- Revert a previous commit

### Scopes

Each app and lib name is a valid scope. Scopes are registered in `.cz-config.js` and `commitlint.config.js`.

## Git Hooks (Husky)

- **pre-commit**: Runs linting on staged files
- **commit-msg**: Validates commit message format via commitlint

## Environment Management

Environment files use encryption for secure storage in git.

```bash
# Encrypt environment files
./scripts/encrypt-env.sh <environment>

# Decrypt environment files
./scripts/decrypt-env.sh <environment>
```

Passphrases are stored in `.envrc` (not committed). Environments: `local`, `dev`, `stag`, `prod`.

## Docker (Local Development)

```bash
# Start local services (MongoDB, Redis, etc.)
docker compose -f deployments/local/docker-compose-local.yaml up -d

# Stop local services
docker compose -f deployments/local/docker-compose-local.yaml down
```

## Code Quality

- **ESLint**: Configured at root (`.eslintrc.json`) with per-app overrides
- **Prettier**: Configured at root (`.prettierrc.json`)
- **TypeScript**: Strict mode, shared base config

## Adding New Projects

- **New app**: Use HubAI extension to scaffold into `apps/`
- **New library**: Use HubAI extension to scaffold into `libs/`
- Both auto-register in commit config scopes and workspace config
