import { Injectable } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { buildAgentGraph } from './agent.graph';

@Injectable()
export class AgentService {
  private readonly graph: ReturnType<typeof buildAgentGraph>;

  constructor() {
    const model = new ChatOpenAI({
      apiKey: process.env.KIMI_API_KEY,
      model: process.env.KIMI_MODEL ?? 'kimi-k2.6',
      // Kimi models only accept the default temperature (1) — omit the override.
      configuration: {
        baseURL: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1',
      },
    });

    this.graph = buildAgentGraph(model);
  }

  async ask(message: string, threadId = 'default'): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      { configurable: { thread_id: threadId } },
    );

    const last = result.messages[result.messages.length - 1];
    return typeof last.content === 'string'
      ? last.content
      : JSON.stringify(last.content);
  }
}
