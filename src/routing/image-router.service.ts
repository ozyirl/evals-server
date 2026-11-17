import { Injectable, Logger } from '@nestjs/common';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';

export type RouteDestination = 'enhance' | 'keep';

/** Everything a downstream branch needs to act on an assessed image. */
export interface RoutedImage {
  buffer: Buffer;
  mimeType: string;
  /** Where the image came from, when it was not a direct upload. */
  imageUrl?: string;
  assessment: ImageQualityAssessment;
  /** True when the model was unsure — the graph holds these for a human. */
  needsReview: boolean;
}

/**
 * Decides which branch of the graph an assessed image takes. Plain dispatch on
 * the label the agent already decided — no model involved. The branches
 * themselves are graph nodes: enhancement, QA and publication for `enhance`,
 * publication as uploaded for `keep`.
 */
@Injectable()
export class ImageRouterService {
  private readonly logger = new Logger(ImageRouterService.name);

  async route(
    image: RoutedImage,
    label: 'ENHANCE' | 'KEEP',
  ): Promise<RouteDestination> {
    const destination: RouteDestination =
      label === 'ENHANCE' ? 'enhance' : 'keep';

    this.logger.log(
      `Routing to ${destination}${image.needsReview ? ' (needs review)' : ''}`,
    );

    return destination;
  }
}
