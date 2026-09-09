import {
  Body,
  Controller,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  ParseFilePipe,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth } from '../auth/auth.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import { ImageAssessmentRow } from '../db/schema';
import { AgentService } from './agent.service';
import {
  ImageAgentService,
  ImageAssessmentResult,
} from './image-agent.service';
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../image-quality/image-quality.constants';
import { AskAgentDto } from './dto/ask-agent.dto';
import { AssessImageDto } from './dto/assess-image.dto';
import { PipelineLogService } from '../assessments/pipeline-log.service';

const imageFilePipe = new ParseFilePipe({
  validators: [
    new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
    new FileTypeValidator({ fileType: SUPPORTED_IMAGE_TYPES }),
  ],
});

@Auth()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly imageAgentService: ImageAgentService,
    private readonly assessmentLog: AssessmentLogService,
    private readonly pipelineLog: PipelineLogService,
  ) {}

  @Post('ask')
  async ask(
    @Body() dto: AskAgentDto,
    @CurrentUser('sub') userId: string,
  ): Promise<{ answer: string }> {
    const answer = await this.agentService.ask(dto.message, userId);
    return { answer };
  }

  /** Assess an image already hosted somewhere — the upstream-service path. */
  @Post('assess-image')
  async assessImage(
    @Body() dto: AssessImageDto,
    @CurrentUser('sub') userId: string,
  ): Promise<ImageAssessmentResult> {
    return this.imageAgentService.assessImage(
      { imageUrl: dto.imageUrl },
      { userId },
    );
  }

  /** Assess an image uploaded straight from the client. */
  @Post('assess-image/file')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async assessImageFile(
    @UploadedFile(imageFilePipe) file: Express.Multer.File,
    @CurrentUser('sub') userId: string,
  ): Promise<ImageAssessmentResult> {
    return this.imageAgentService.assessImage(
      { buffer: file.buffer, mimeType: file.mimetype },
      { userId, fileName: file.originalname },
    );
  }

  /** Recent assessments for the signed-in user, newest first. */
  @Get('assessments')
  async assessments(
    @CurrentUser('sub') userId: string,
  ): Promise<ImageAssessmentRow[]> {
    return this.assessmentLog.listForUser(userId);
  }

  @Get('assessments/:runId/events')
  async events(
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.pipelineLog.listForRun(userId, runId);
  }
}
