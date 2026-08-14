-- Phase 2 — recurring events (lặp lại hằng ngày / hằng tuần theo ngày tuỳ chọn).
-- Chạy 1 lần trong Supabase SQL Editor, SAU khi đã chạy schema.sql + 0002 + 0003.
--
-- Cách tiếp cận: mỗi lần lặp lại là 1 row events thật (không "ảo hoá" khi
-- query), các row cùng 1 chuỗi share chung recurrence_id để có thể xoá/nhận
-- diện cả chuỗi. Nhờ vậy reminders/comments/attendees vẫn hoạt động bình
-- thường vì chúng đều tham chiếu tới 1 event_id thật.

alter table public.events
  add column if not exists recurrence_id   uuid,
  add column if not exists recurrence_rule jsonb;

create index if not exists events_recurrence_id_idx on public.events (recurrence_id);
