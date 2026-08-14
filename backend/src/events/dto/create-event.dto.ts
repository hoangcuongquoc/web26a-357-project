import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecurrenceRuleDto {
  @IsIn(['daily', 'weekly'])
  freq!: 'daily' | 'weekly';

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  byDay?: number[];

  @IsISO8601()
  until!: string;
}

export class CreateEventDto {
  @IsUUID()
  calendarId!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;

  @IsBoolean()
  allDay!: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceRuleDto)
  recurrence?: RecurrenceRuleDto;
}
