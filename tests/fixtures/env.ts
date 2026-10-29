export const baseEnv: Record<string, string> = {
  APP_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:3001",
  MONGODB_URI: "mongodb://127.0.0.1:27017/real_time_chat_dev",
  MONGODB_DB: "real_time_chat_dev",
  BETTER_AUTH_SECRET: "local-dev-only-change-me-32-characters-minimum",
};

export const productionEnv: Record<string, string> = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://app.example.com",
  API_ORIGIN: "https://api.example.com",
  MONGODB_URI: "mongodb+srv://cluster.example.mongodb.net/?retryWrites=true&w=majority",
  MONGODB_DB: "real_time_chat_prod",
  BETTER_AUTH_SECRET: "test-only-production-secret-32-characters-minimum",
  AI_PROVIDER: "groq",
  AI_MODEL: "openai/gpt-oss-120b",
  AI_API_KEY: "synthetic-test-key",
  AI_CONSENT_REQUIRED: "true",
  TURN_URLS: "turns:turn.example.com:5349?transport=tcp",
  TURN_USERNAME: "production-user",
  TURN_CREDENTIAL: "test-only-production-credential",
  TURN_REALM: "chat.example.com",
};
