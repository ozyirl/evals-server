import { IsIn, IsOptional, IsUrl, IsUUID } from 'class-validator';

/** Lets a client pick the run ID up front, so it can poll hop events mid-run. */
export class RunIdDto {
  @IsOptional()
  @IsUUID()
  runId?: string;
}

export class AssessImageDto extends RunIdDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl: string;
}

export class HumanLabelDto {
  /** Null clears a label set by mistake. */
  @IsIn(['ENHANCE', 'KEEP', null])
  label: 'ENHANCE' | 'KEEP' | null;
}
