export type ProviderName = "gemini" | "groq";

export interface ProviderAdapter {
  readonly name: ProviderName;
  generate(prompt: string): Promise<string>;
}
