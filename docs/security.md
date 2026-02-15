# Security

## Controls

- Command policy engine supports deny/allow lists.
- Optional command approval gate (`requireApproval`).
- Memory store supports encrypted sensitive values via AES-256-GCM (`FUSY_MEMORY_KEY`).

## Recommended practices

- Use least-privilege API keys and scoped secrets.
- Keep `denyList` populated for destructive commands.
- Enable audit trails with JSON logs and trace exports.
- Rotate provider keys regularly.
