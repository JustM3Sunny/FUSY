export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
}

export const loadConfig = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info"
});
