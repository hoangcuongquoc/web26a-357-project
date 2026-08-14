import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { AppConfig } from '../config/configuration';
import { MailService } from '../mail/mail.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AttendeeDto, AttendeeRow, toAttendeeDto } from './attendee.mapper';
import { CheckConflictsDto } from './dto/check-conflicts.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { InviteAttendeeDto } from './dto/invite-attendee.dto';
import { RespondInviteDto } from './dto/respond-invite.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import {
  ConflictEventDto,
  EventDto,
  EventRow,
  toConflictEventDto,
  toEventDto,
  toEventInsertRow,
  toEventUpdateRow,
} from './event.mapper';

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECURRENCE_OCCURRENCES = 366;

interface InviteEventContext {
  title: string;
  location: string | null;
  start_at: string;
  end_at: string;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly realtimeGateway: RealtimeGateway,
    private readonly mailService: MailService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async findAll(
    supabase: SupabaseClient,
    calendarId?: string,
  ): Promise<EventDto[]> {
    let query = supabase
      .from('events')
      .select('*')
      .order('start_at', { ascending: true });
    if (calendarId) {
      query = query.eq('calendar_id', calendarId);
    }

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return (data as EventRow[]).map(toEventDto);
  }

  async create(
    supabase: SupabaseClient,
    dto: CreateEventDto,
    createdBy: string,
  ): Promise<EventDto[]> {
    const rows = dto.recurrence
      ? this.buildRecurringRows(dto, createdBy)
      : [toEventInsertRow(dto, createdBy)];

    const { data, error } = await supabase
      .from('events')
      .insert(rows)
      .select('*')
      .returns<EventRow[]>();

    if (error) throw new InternalServerErrorException(error.message);
    const eventDtos = data.map(toEventDto);
    for (const eventDto of eventDtos) {
      this.realtimeGateway.emitToCalendar(
        eventDto.calendarId,
        'event:created',
        eventDto,
      );
    }
    return eventDtos;
  }

  /**
   * Mỗi lần lặp lại được materialize thành 1 row events thật (không ảo hoá
   * lúc query) để reminders/comments/attendees vẫn hoạt động bình thường vì
   * chúng tham chiếu event_id thật. Các row cùng chuỗi share recurrence_id.
   */
  private buildRecurringRows(
    dto: CreateEventDto,
    createdBy: string,
  ): Record<string, unknown>[] {
    const rule = dto.recurrence!;
    const start = new Date(dto.start);
    const end = new Date(dto.end);
    const durationMs = end.getTime() - start.getTime();
    const until = new Date(rule.until);
    if (Number.isNaN(until.getTime()) || until.getTime() < start.getTime()) {
      throw new BadRequestException('Ngày kết thúc lặp lại không hợp lệ');
    }

    const byDay =
      rule.freq === 'weekly'
        ? new Set(rule.byDay && rule.byDay.length > 0 ? rule.byDay : [start.getDay()])
        : null;

    const recurrenceId = randomUUID();
    const recurrenceRule = { freq: rule.freq, byDay: rule.byDay, until: rule.until };

    const occurrenceStarts: Date[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= until.getTime()) {
      if (!byDay || byDay.has(cursor.getDay())) {
        if (occurrenceStarts.length >= MAX_RECURRENCE_OCCURRENCES) {
          throw new BadRequestException(
            'Chuỗi sự kiện lặp lại quá dài, vui lòng chọn khoảng ngắn hơn',
          );
        }
        occurrenceStarts.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (occurrenceStarts.length === 0) {
      throw new BadRequestException('Không có ngày nào khớp với quy tắc lặp lại đã chọn');
    }

    return occurrenceStarts.map((occStart) => ({
      calendar_id: dto.calendarId,
      title: dto.title,
      location: dto.location ?? null,
      description: dto.description ?? null,
      start_at: occStart.toISOString(),
      end_at: new Date(occStart.getTime() + durationMs).toISOString(),
      all_day: dto.allDay,
      created_by: createdBy,
      recurrence_id: recurrenceId,
      recurrence_rule: recurrenceRule,
    }));
  }

  async update(
    supabase: SupabaseClient,
    id: string,
    dto: UpdateEventDto,
  ): Promise<EventDto> {
    const { data, error } = await supabase
      .from('events')
      .update(toEventUpdateRow(dto))
      .eq('id', id)
      .select('*')
      .returns<EventRow[]>();

    if (error) throw new InternalServerErrorException(error.message);
    const rows = data;
    if (rows.length === 0) {
      throw new NotFoundException(
        'Event not found or you do not have permission to edit it',
      );
    }
    const eventDto = toEventDto(rows[0]);
    this.realtimeGateway.emitToCalendar(
      eventDto.calendarId,
      'event:updated',
      eventDto,
    );
    return eventDto;
  }

  async remove(
    supabase: SupabaseClient,
    id: string,
    wholeSeries = false,
  ): Promise<void> {
    let deleteQuery = supabase.from('events').delete();

    if (wholeSeries) {
      const { data: eventRow, error: lookupError } = await supabase
        .from('events')
        .select('id, recurrence_id')
        .eq('id', id)
        .maybeSingle<{ id: string; recurrence_id: string | null }>();
      if (lookupError) throw new InternalServerErrorException(lookupError.message);
      if (!eventRow) {
        throw new NotFoundException(
          'Event not found or you do not have permission to delete it',
        );
      }
      deleteQuery = eventRow.recurrence_id
        ? deleteQuery.eq('recurrence_id', eventRow.recurrence_id)
        : deleteQuery.eq('id', id);
    } else {
      deleteQuery = deleteQuery.eq('id', id);
    }

    const { data, error } = await deleteQuery
      .select('id, calendar_id')
      .returns<{ id: string; calendar_id: string }[]>();

    if (error) throw new InternalServerErrorException(error.message);
    if (data.length === 0) {
      throw new NotFoundException(
        'Event not found or you do not have permission to delete it',
      );
    }
    for (const row of data) {
      this.realtimeGateway.emitToCalendar(row.calendar_id, 'event:deleted', {
        id: row.id,
      });
    }
  }

  async checkConflicts(
    supabase: SupabaseClient,
    dto: CheckConflictsDto,
  ): Promise<ConflictEventDto[]> {
    let query = supabase
      .from('events')
      .select('*')
      .lt('start_at', dto.end)
      .gt('end_at', dto.start);
    if (dto.excludeEventId) {
      query = query.neq('id', dto.excludeEventId);
    }

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return (data as EventRow[]).map(toConflictEventDto);
  }

  async invite(
    supabase: SupabaseClient,
    eventId: string,
    dto: InviteAttendeeDto,
  ): Promise<AttendeeDto> {
    const { data: eventRow, error: eventError } = await supabase
      .from('events')
      .select('id, calendar_id, title, location, start_at, end_at')
      .eq('id', eventId)
      .maybeSingle<{ id: string; calendar_id: string } & InviteEventContext>();
    if (eventError) throw new InternalServerErrorException(eventError.message);
    if (!eventRow) throw new NotFoundException('Event not found');

    const { data: userId, error: lookupError } = await supabase.rpc(
      'find_user_id_by_email',
      { p_email: dto.email },
    );
    if (lookupError) throw new InternalServerErrorException(lookupError.message);
    if (!userId) {
      throw new NotFoundException('Không tìm thấy người dùng với email này');
    }

    const respondToken = randomUUID();
    const tokenExpiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString();

    const { data, error } = await supabase
      .from('event_attendees')
      .insert({
        event_id: eventId,
        user_id: userId,
        status: 'pending',
        respond_token: respondToken,
        token_expires_at: tokenExpiresAt,
      })
      .select('id, user_id, status')
      .single<{ id: string; user_id: string; status: AttendeeRow['status'] }>();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('Người này đã được mời tham gia sự kiện');
      }
      throw new InternalServerErrorException(error.message);
    }

    const attendeeDto = toAttendeeDto({
      id: data.id,
      user_id: data.user_id,
      email: dto.email,
      status: data.status,
    });

    this.realtimeGateway.emitToCalendar(eventRow.calendar_id, 'attendee:invited', {
      eventId,
      attendee: attendeeDto,
    });
    this.realtimeGateway.emitToUser(data.user_id, 'attendee:invited', {
      eventId,
      attendee: attendeeDto,
    });

    // Không chặn kết quả invite nếu gửi mail lỗi (VD thiếu GMAIL_* trong
    // .env) — lời mời trong app vẫn có giá trị dù email chưa gửi được.
    void this.sendInviteEmailSafely(eventRow, dto.email, respondToken, eventId);

    return attendeeDto;
  }

  private async sendInviteEmailSafely(
    eventRow: InviteEventContext,
    toEmail: string,
    token: string,
    eventId: string,
  ): Promise<void> {
    try {
      const baseUrl = this.configService.get('apiBaseUrl', { infer: true });
      await this.mailService.sendInviteEmail({
        to: toEmail,
        eventTitle: eventRow.title,
        startAt: eventRow.start_at,
        endAt: eventRow.end_at,
        location: eventRow.location ?? undefined,
        acceptUrl: `${baseUrl}/events/${eventId}/respond-via-email?token=${token}&action=accept`,
        declineUrl: `${baseUrl}/events/${eventId}/respond-via-email?token=${token}&action=decline`,
      });
    } catch (err) {
      this.logger.warn(`Failed to send invite email to ${toEmail}: ${(err as Error).message}`);
    }
  }

  async respond(
    supabase: SupabaseClient,
    eventId: string,
    userId: string,
    dto: RespondInviteDto,
  ): Promise<AttendeeDto> {
    const { data, error } = await supabase
      .from('event_attendees')
      .update({ status: dto.status })
      .eq('event_id', eventId)
      .eq('user_id', userId)
      .select('id, user_id, status')
      .returns<{ id: string; user_id: string; status: AttendeeRow['status'] }[]>();

    if (error) throw new InternalServerErrorException(error.message);
    if (data.length === 0) {
      throw new NotFoundException('Lời mời không tồn tại');
    }

    const { data: eventRow } = await supabase
      .from('events')
      .select('calendar_id')
      .eq('id', eventId)
      .maybeSingle<{ calendar_id: string }>();

    const attendeeDto = toAttendeeDto({ ...data[0], email: '' });
    if (eventRow) {
      this.realtimeGateway.emitToCalendar(
        eventRow.calendar_id,
        'attendee:statusChanged',
        { eventId, attendee: attendeeDto },
      );
    }
    return attendeeDto;
  }

  async listAttendees(
    supabase: SupabaseClient,
    eventId: string,
  ): Promise<AttendeeDto[]> {
    const { data, error } = await supabase.rpc('list_event_attendees', {
      p_event_id: eventId,
    });
    if (error) throw new InternalServerErrorException(error.message);
    return (data as AttendeeRow[]).map(toAttendeeDto);
  }
}
