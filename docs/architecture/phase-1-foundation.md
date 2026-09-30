# Phase 1 Foundation Architecture

## Overview
Phase 1 establishes the production-quality technical foundation for PlayLens, supporting all future ML and product work. The architecture prioritizes a clean separation of concerns, reproducibility, and strong typing.

## Components

### Browser -> Next.js (apps/web)
The frontend is a Next.js application using the App Router, React, Tailwind CSS, and shadcn/ui. It acts as the interactive interface for PlayLens, currently providing a minimal shell with infrastructure health checks.

### Next.js -> FastAPI (services/api)
The backend is a Python FastAPI service. It provides strongly typed endpoints (using Pydantic) to serve data to the frontend. It connects to the database and caching layers.

### PostgreSQL + pgvector
The primary operational database. It will store play metadata and (future) learned embeddings using the `pgvector` extension for similarity search.

### Redis
Provides ephemeral state and caching capabilities.

### ML Package (ml)
A dedicated Python package for data processing, feature engineering, and model training. It is currently scaffolded to support PyTorch, PyTorch Geometric, Polars, and MLflow, but contains no actual models in Phase 1.

## Future Connection Points (NOT IMPLEMENTED YET)
- **ML Inference:** The FastAPI service will load trained models from the ML package or a model registry to provide predictions.
- **Embedding Generation:** Tracking data will be processed through the ML encoder to generate vector representations.
- **Vector Retrieval:** pgvector will be queried for similar play embeddings.
- **AI Analyst:** An LLM agent will use predefined tools to query the API and return structured evidence to the UI.
- **MLflow Tracking:** ML experiments and model artifacts will be tracked locally or centrally.
