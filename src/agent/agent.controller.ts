import {
  Body,
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth } from '../auth/auth.decorator';
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
  ) {}

  @Post('ask')
  async ask(@Body() dto: AskAgentDto): Promise<{ answer: string }> {
    const answer = await this.agentService.ask(dto.message);
    return { answer };
  }

  /** Assess an image already hosted somewhere — the upstream-service path. */
  @Post('assess-image')
  async assessImage(
    @Body() dto: AssessImageDto,
  ): Promise<ImageAssessmentResult> {
    return this.imageAgentService.assessImage({ imageUrl: dto.imageUrl });
  }

  /** Assess an image uploaded straight from the client. */
  @Post('assess-image/file')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async assessImageFile(
    @UploadedFile(imageFilePipe) file: Express.Multer.File,
  ): Promise<ImageAssessmentResult> {
    return this.imageAgentService.assessImage({
      buffer: file.buffer,
      mimeType: file.mimetype,
    });
  }
}
