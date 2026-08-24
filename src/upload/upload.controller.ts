import {
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
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../image-quality/image-quality.constants';
import { UploadService } from './upload.service';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';

@Auth()
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadImage(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: SUPPORTED_IMAGE_TYPES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ): Promise<{
    uuid: string;
    cdnUrl: string;
    assessment: ImageQualityAssessment;
  }> {
    return this.uploadService.storeImage(file);
  }
}
