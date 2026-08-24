/** Gemini bills per image — refuse anything oversized before it reaches the model. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
