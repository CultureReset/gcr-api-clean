-- ============================================================
-- Atomic booking for the LIVE engine (routes/platform.js)
-- ============================================================
-- routes/platform.js takes a booking in two steps:
--
--   1. getAvailability()  reads booking_calendar and decides there is room
--   2. insertRecord()     inserts into bookings
--   3. calendarSyncBooking() writes the booking_calendar claim
--
-- Nothing holds a lock between 1 and 3, so two people checking out for the
-- last seat at the same moment both pass step 1 and both get booked.
--
-- This function collapses all three into one transaction behind a
-- per-(entity, date) advisory lock, re-checking availability *inside* the
-- lock. Callers that lose the race get a structured failure instead of a
-- silent overbooking.
--
-- NOTE: this deliberately does NOT implement create_booking_hold /
-- create_booking_if_available. Those belong to the legacy /api/public
-- rental path (fleet_types, rental_time_slots, booking_holds) — fleet_types
-- and rental_time_slots are empty, booking_holds does not exist, and that
-- path is superseded by /api/platform. Reviving it would be dead work.
--
-- Availability rules mirror getAvailability() in routes/platform.js:
--   • kind='block'      closes the date (and its end_date span)
--   • same offering_id  already claimed on that date  -> resource taken
--   • slot capacity     sum(party) per date+start_time
--   • day capacity      count of non-block claims per date
-- ============================================================

create or replace function public.platform_create_booking(
    p_entity_slug text,
    p_booking     jsonb,                 -- toBookingRow() shape
    p_calendar    jsonb,                 -- calendarSyncBooking() entry shape
    p_mode        text    default 'none',-- 'slots' | 'range' | 'day' | 'none'
    p_capacity    integer default null,  -- max claims per day (null = unlimited)
    p_slot_cap    integer default null,  -- max seats per slot (null = unlimited)
    p_resource_id uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_start      date;
    v_end        date;
    v_time       time;
    v_party      integer;
    v_booking_id uuid;
    v_day        date;
    v_used       integer;
    v_count      integer;
begin
    v_start := nullif(p_booking->>'date', '')::date;
    if v_start is null then
        return jsonb_build_object('success', false, 'reason', 'no_date',
                                  'error', 'A date is required.');
    end if;

    v_end   := coalesce(nullif(p_booking->>'end_date', '')::date, v_start);
    v_time  := nullif(p_booking->>'start_time', '')::time;
    v_party := greatest(coalesce(nullif(p_booking->>'party_size', '')::int, 1), 1);

    if v_end < v_start then
        return jsonb_build_object('success', false, 'reason', 'bad_range',
                                  'error', 'End date is before the start date.');
    end if;

    -- Serialize everyone touching this business on this start date. Transaction
    -- scoped, so it releases on commit or rollback without any cleanup path.
    perform pg_advisory_xact_lock(hashtext(p_entity_slug || ':' || v_start::text));

    if p_mode is distinct from 'none' then
        -- Walk every day the booking occupies. For a single-day booking this
        -- loops once; for a range it covers the whole stay.
        for v_day in select generate_series(v_start, v_end, interval '1 day')::date loop

            -- 1. Owner block covering this day
            select count(*) into v_count
            from booking_calendar
            where entity_slug = p_entity_slug
              and kind   = 'block'
              and status = 'active'
              and v_day between date and coalesce(end_date, date);

            if v_count > 0 then
                return jsonb_build_object('success', false, 'reason', 'blocked',
                    'date', v_day,
                    'error', 'That date is not available.');
            end if;

            -- 2. This specific resource already claimed that day
            if p_resource_id is not null then
                select count(*) into v_count
                from booking_calendar
                where entity_slug = p_entity_slug
                  and kind   <> 'block'
                  and status  = 'active'
                  and offering_id = p_resource_id
                  and v_day between date and coalesce(end_date, date);

                if v_count > 0 then
                    return jsonb_build_object('success', false, 'reason', 'resource_taken',
                        'date', v_day,
                        'error', 'That one is already booked for this date.');
                end if;
            end if;

            -- 3. Seats left in this time slot
            if p_slot_cap is not null and v_time is not null then
                select coalesce(sum(coalesce(party, 1)), 0) into v_used
                from booking_calendar
                where entity_slug = p_entity_slug
                  and kind   <> 'block'
                  and status  = 'active'
                  and date        = v_day
                  and start_time  = v_time;

                if v_used + v_party > p_slot_cap then
                    return jsonb_build_object('success', false, 'reason', 'slot_full',
                        'date', v_day,
                        'remaining', greatest(p_slot_cap - v_used, 0),
                        'error', case
                            when p_slot_cap - v_used <= 0 then 'That time is fully booked.'
                            else 'Only ' || (p_slot_cap - v_used) || ' spot(s) left at that time.'
                        end);
                end if;
            end if;

            -- 4. Bookings left in the day
            if p_capacity is not null then
                select count(*) into v_count
                from booking_calendar
                where entity_slug = p_entity_slug
                  and kind   <> 'block'
                  and status  = 'active'
                  and v_day between date and coalesce(end_date, date);

                if v_count >= p_capacity then
                    return jsonb_build_object('success', false, 'reason', 'day_full',
                        'date', v_day,
                        'error', 'That date is fully booked.');
                end if;
            end if;

        end loop;
    end if;

    -- Still available under the lock: take it.
    --
    -- jsonb_populate_record fills absent keys with NULL, and an explicit NULL
    -- bypasses a column DEFAULT — so id/created_at/status/details have to be
    -- supplied here rather than left to the table defaults.
    v_booking_id := gen_random_uuid();

    insert into bookings
    select * from jsonb_populate_record(
        null::bookings,
        jsonb_build_object(
            'id',         v_booking_id,
            'created_at', now(),
            'status',     'pending',
            'details',    '{}'::jsonb
        ) || p_booking || jsonb_build_object('id', v_booking_id)
    );

    insert into booking_calendar
    select * from jsonb_populate_record(
        null::booking_calendar,
        jsonb_build_object(
            'kind',    'booking',
            'source',  'direct',
            'status',  'active',
            'details', '{}'::jsonb
        )
        || p_calendar
        || jsonb_build_object(
            'id',         gen_random_uuid(),
            'booking_id', v_booking_id,
            'created_at', now(),
            'updated_at', now()
        )
    );

    return jsonb_build_object('success', true, 'booking_id', v_booking_id);
end;
$$;

comment on function public.platform_create_booking is
'Atomic booking for routes/platform.js. Re-checks blocks, resource conflicts, slot
capacity and day capacity inside a per-(entity,date) advisory lock, then writes both
the bookings row and its booking_calendar claim in one transaction. Returns
{success, booking_id} or {success:false, reason, error}. Mirrors getAvailability().';

revoke all on function public.platform_create_booking(text, jsonb, jsonb, text, integer, integer, uuid) from public, anon;
grant execute on function public.platform_create_booking(text, jsonb, jsonb, text, integer, integer, uuid) to service_role;
