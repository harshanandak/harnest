# Codex plugin validator

This is the unchanged OpenAI validator from [Codex commit 1883ded](https://github.com/openai/codex/blob/1883dedc0e3499c8f42e08835540319ad7131d77/codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py), retained because current Codex installations no longer include the README's former machine-local script path.

Run `npm run validate:plugin` with Python 3 and PyYAML installed (`python -m pip install PyYAML` if needed). The upstream Apache 2.0 license is included alongside the script.

Provenance: Git blob `5c6fae8e6332baa5810da5751acd68e508d461b4`; SHA-256 `f6d90a9925d8b8583d61a857c0cb4c6f64926349e55ea1119e6ece7e5cfc787f`. Update from an explicit upstream commit and run validation before replacing the pinned file.
