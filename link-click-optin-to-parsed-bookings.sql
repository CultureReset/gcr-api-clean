-- ============================================================================
-- link-click-optin-to-parsed-bookings.sql  (EXECUTED)
-- ----------------------------------------------------------------------------
-- Closes the loop the click/opt-in system was built for but never finished:
--   tourist_click_events  (who clicked "Book Now", when, on which business —
--                          BusinessDetail.jsx's trackAndOpen/trackAndNavigate,
--                          POST /api/tourist/track-click)
--     -> booking_opt_ins  (name/phone/email captured before checkout —
--                          Reserve.jsx, POST /api/gcr/opt-in, click_id FK)
--       -> email_parser_log / business_availability (the actual booking
--          confirmation, either typed in via POST /api/email-parser/manual
--          — which already receives opt_in_id from Reserve.jsx but was
--          discarding it after sending the confirmation SMS/email — or a
--          real forwarded confirmation email via POST /api/email-parser/inbound,
--          which has no opt_in_id at all and needs heuristic matching).
--
-- Without these columns there was no way to answer "who clicked, when, and
-- did it actually turn into a booking" — exactly what was asked for.
-- ============================================================================

ALTER TABLE public.email_parser_log ADD COLUMN IF NOT EXISTS opt_in_id uuid REFERENCES public.booking_opt_ins(id);
ALTER TABLE public.email_parser_log ADD COLUMN IF NOT EXISTS click_id uuid REFERENCES public.tourist_click_events(id);

ALTER TABLE public.tourist_click_events ADD COLUMN IF NOT EXISTS converted boolean NOT NULL DEFAULT false;
ALTER TABLE public.tourist_click_events ADD COLUMN IF NOT EXISTS converted_at timestamptz;
ALTER TABLE public.tourist_click_events ADD COLUMN IF NOT EXISTS email_log_id uuid REFERENCES public.email_parser_log(id);

CREATE INDEX IF NOT EXISTS idx_email_parser_log_opt_in ON public.email_parser_log(opt_in_id);
CREATE INDEX IF NOT EXISTS idx_email_parser_log_click ON public.email_parser_log(click_id);
CREATE INDEX IF NOT EXISTS idx_booking_opt_ins_entity_created ON public.booking_opt_ins(entity_slug, created_at);
