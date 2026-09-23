UPDATE "organizations"
SET "timezone" = 'Europe/Moscow'
WHERE "timezone" NOT IN (
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara',
  'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok',
  'Asia/Magadan', 'Asia/Kamchatka'
);

ALTER TABLE "organizations"
ADD CONSTRAINT "organizations_russian_timezone_check"
CHECK ("timezone" IN (
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara',
  'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok',
  'Asia/Magadan', 'Asia/Kamchatka'
));
