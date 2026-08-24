import { Injectable } from '@nestjs/common';
import {
  ImageQualityAssessment,
  ImageQualityService,
} from '../image-quality/image-quality.service';
import {
  buildImageQualityGraph,
  ImageQualityLabel,
} from './image-quality.graph';

export type ImageSource =
  { imageUrl: string } | { buffer: Buffer; mimeType: string };

export type ImageAssessmentResult = ImageQualityLabel & {
  assessment: ImageQualityAssessment;
};

@Injectable()
export class ImageAgentService {
  private readonly graph: ReturnType<typeof buildImageQualityGraph>;

  constructor(private readonly imageQualityService: ImageQualityService) {
    this.graph = buildImageQualityGraph(this.imageQualityService);
  }

  async assessImage(source: ImageSource): Promise<ImageAssessmentResult> {
    const state = await this.graph.invoke(source);

    return { ...state.result, assessment: state.assessment };
  }
}
