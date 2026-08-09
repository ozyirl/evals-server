import { Body, Controller, Post } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AskAgentDto } from './dto/ask-agent.dto';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('ask')
  async ask(@Body() dto: AskAgentDto): Promise<{ answer: string }> {
    const answer = await this.agentService.ask(dto.message);
    return { answer };
  }
}
