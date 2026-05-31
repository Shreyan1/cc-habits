import { OpenAIProvider } from './openai';

// Groq is OpenAI-compatible, only the endpoint and model differ.
export class GroqProvider extends OpenAIProvider {
  name = 'groq';

  constructor(apiKey: string, model: string) {
    super(apiKey, model);
    this.endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  }
}
