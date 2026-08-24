import { IsUrl } from 'class-validator';

export class AssessImageDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl: string;
}
