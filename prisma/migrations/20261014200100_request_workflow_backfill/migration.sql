UPDATE requests SET author_member_id=created_by_member_id WHERE author_member_id IS NULL;
UPDATE requests SET status='REGISTERED' WHERE system_code_snapshot='SICK' AND status='APPROVED';
UPDATE request_types SET name='Освобождение от работы',description='Запрос на согласуемое освобождение от работы. Не является сообщением о невыходе или отпуском без оплаты.' WHERE system_code='ABSENCE' AND name='Отсутствие';
UPDATE work_shifts SET attendance='WORKED' WHERE actual_start_at IS NOT NULL AND actual_end_at IS NOT NULL;
-- Existing custom roles are unchanged. Extend standard administrators only where the old management action was enabled.
UPDATE access_roles SET permissions=ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['vacations.view','vacations.collect','vacations.resolve','vacations.change','requests.onBehalf'])) WHERE system_code='ADMIN' AND permissions @> ARRAY['requests.resolve','absences.edit','members.view'];
