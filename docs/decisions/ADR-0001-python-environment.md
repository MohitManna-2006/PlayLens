# Architecture Decision Record: Python Environment

## Context
PlayLens has an API service and an ML package. We need a way to manage Python dependencies, coordinate cross-package dependencies, and ensure reproducibility across development machines and CI environments.

## Decision
We will use `uv` with a single workspace containing `services/api` and `ml`.

## Alternatives considered
- Standard `pip` and `requirements.txt`: Too slow, lacks lockfiles, and doesn't handle workspaces well.
- `Poetry`: Slower than `uv`, slightly more complex configuration for monorepos.
- `PDM`: Viable, but `uv` is faster and gaining more traction for simpler, robust builds.

## Why this choice
`uv` provides extremely fast resolution and installation. The workspace feature allows us to develop `playlens-api` and `playlens-ml` in tandem without publishing to a registry or managing complex PYTHONPATH hacks. It correctly handles CPU/MPS resolutions on macOS by default.

## Consequences
Developers must install `uv` to bootstrap the backend. We get a single `.venv` that powers both API and ML code, which simplifies editor setup.

## Revisit trigger
If `uv` fails to resolve complex PyTorch or PyTorch Geometric dependencies reliably across macOS and Linux, we may revert to explicit `requirements.txt` or a different tool.

## Date
2026-09-29
