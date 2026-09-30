from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "postgresql+psycopg://playlens_dev:playlens_dev@localhost:5432/playlens"
    redis_url: str = "redis://localhost:6379/0"
    
    class Config:
        env_file = ".env"

settings = Settings()
