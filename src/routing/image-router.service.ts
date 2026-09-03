import { Injectable, Logger } from '@nestjs/common';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';

export type RouteDestination = 'enhance' | 'keep';

/** Everything a downstream handler needs to act on an assessed image. */
export interface RoutedImage {
  buffer: Buffer;
  mimeType: string;
  /** Where the image came from, when it was not a direct upload. */
  imageUrl?: string;
  assessment: ImageQualityAssessment;
  /** True when the model was unsure — handlers may want a human in the loop. */
  needsReview: boolean;
}

/**
 * Sends an assessed image to its downstream handler. Plain dispatch on the
 * label the agent already decided — no model involved.
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

    if (destination === 'enhance') {
      await this.sendToEnhancement(image);
    } else {
      await this.sendToCatalogue(image);
    }

    return destination;
  }

  /** TODO: hand the image to the enhancement pipeline. */
  private async sendToEnhancement(_image: RoutedImage): Promise<void> {}

  /** TODO: publish the image as-is to the merchant catalogue. */
  private async sendToCatalogue(_image: RoutedImage): Promise<void> {}
}
