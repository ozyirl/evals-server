import {
  ImageQualityAnnotation,
  LOW_CONFIDENCE_THRESHOLD,
  routeByConfidence,
} from './image-quality.graph';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';

function assessment(
  overrides: Partial<ImageQualityAssessment> = {},
): ImageQualityAssessment {
  return {
    decision: 'KEEP',
    confidence: 0.9,
    scores: {
      lighting: 8,
      sharpness: 8,
      composition: 8,
      background: 8,
      color: 8,
      overall: 8,
    },
    issues: [],
    reason: 'looks fine',
    ...overrides,
  };
}

const state = (a: ImageQualityAssessment) =>
  ({ assessment: a }) as typeof ImageQualityAnnotation.State;

describe('routeByConfidence', () => {
  it('labels confident assessments', () => {
    expect(routeByConfidence(state(assessment({ confidence: 0.95 })))).toBe(
      'label',
    );
  });

  it('flags low-confidence assessments for review', () => {
    expect(routeByConfidence(state(assessment({ confidence: 0.2 })))).toBe(
      'flagForReview',
    );
  });

  it('treats the threshold itself as confident', () => {
    expect(
      routeByConfidence(
        state(assessment({ confidence: LOW_CONFIDENCE_THRESHOLD })),
      ),
    ).toBe('label');
  });
});
