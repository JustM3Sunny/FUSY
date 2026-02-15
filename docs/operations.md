# Operations

## CI/CD

- Run lint, typecheck, tests on every PR.
- Run cross-platform smoke matrix (Linux/macOS/Windows).

## Release strategy

- Follow semantic versioning.
- Use Changesets for version/changelog generation.
- Tag releases from `main` after CI passes.

## Changelog automation

```bash
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

## CLI binary distribution

Options:

1. `pkg`/`nexe` single-file binaries per platform.
2. npm package + `bin` entry (`fusy`).
3. GitHub Releases with platform tarballs.

Suggested steps:

- Build: `pnpm --filter @fusy/cli build`
- Package by target OS/arch
- Publish checksums and signed artifacts
- Document install commands per platform
