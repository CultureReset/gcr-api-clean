-- Catalog rows for the industry tables.
--
-- Amenities are grouped the way Airbnb groups them, because that is the
-- grouping guests already recognise and the one a business is transcribing
-- from. Species and watersport activities are catalogs for the same reason
-- charter species is a join and not free text: "who targets red snapper"
-- should be an index lookup, not a LIKE over a comma-separated string.
--
-- Every insert is `on conflict do nothing`, so this is safe to re-run and
-- safe to run after someone has already added their own rows.
--
--   psql "$DATABASE_URL" -f sql/industry_seed.sql

/* ── amenity sections ────────────────────────────────────────────────── */

insert into public.amenity_sections (key, label, sort_order) values
  ('bathroom',       'Bathroom',                 10),
  ('bedroom',        'Bedroom & laundry',        20),
  ('entertainment',  'Entertainment',            30),
  ('family',         'Family',                   40),
  ('climate',        'Heating & cooling',        50),
  ('safety',         'Home safety',              60),
  ('internet',       'Internet & office',        70),
  ('kitchen',        'Kitchen & dining',         80),
  ('location',       'Location features',        90),
  ('outdoor',        'Outdoor',                 100),
  ('parking',        'Parking & facilities',    110),
  ('services',       'Services',                120),
  ('accessibility',  'Accessibility',           130),
  ('vessel',         'On the boat',             140),
  ('beach',          'Beach & water',           150)
on conflict (key) do nothing;

/* ── amenities ───────────────────────────────────────────────────────── */

insert into public.amenities (key, label, section_key, sort_order) values
  -- Bathroom
  ('hair_dryer','Hair dryer','bathroom',10),
  ('shampoo','Shampoo','bathroom',20),
  ('hot_water','Hot water','bathroom',30),
  ('bathtub','Bathtub','bathroom',40),
  ('walk_in_shower','Walk-in shower','bathroom',50),
  ('outdoor_shower','Outdoor shower','bathroom',60),
  ('beach_towels','Beach towels','bathroom',70),

  -- Bedroom & laundry
  ('washer','Washer','bedroom',10),
  ('dryer','Dryer','bedroom',20),
  ('linens','Linens provided','bedroom',30),
  ('extra_pillows','Extra pillows & blankets','bedroom',40),
  ('iron','Iron','bedroom',50),
  ('hangers','Hangers','bedroom',60),
  ('blackout_curtains','Blackout curtains','bedroom',70),
  ('safe','In-room safe','bedroom',80),

  -- Entertainment
  ('tv','TV','entertainment',10),
  ('smart_tv','Smart TV','entertainment',20),
  ('cable','Cable / satellite','entertainment',30),
  ('sound_system','Sound system','entertainment',40),
  ('game_console','Game console','entertainment',50),
  ('books_games','Books & board games','entertainment',60),
  ('pool_table','Pool table','entertainment',70),

  -- Family
  ('crib','Crib','family',10),
  ('pack_n_play','Pack ''n play','family',20),
  ('high_chair','High chair','family',30),
  ('baby_gates','Baby safety gates','family',40),
  ('outlet_covers','Outlet covers','family',50),
  ('kids_dinnerware','Children''s dinnerware','family',60),
  ('beach_toys','Beach toys','family',70),

  -- Heating & cooling
  ('air_conditioning','Air conditioning','climate',10),
  ('central_air','Central air','climate',20),
  ('heating','Heating','climate',30),
  ('ceiling_fan','Ceiling fan','climate',40),
  ('portable_fan','Portable fan','climate',50),

  -- Home safety
  ('smoke_alarm','Smoke alarm','safety',10),
  ('co_alarm','Carbon monoxide alarm','safety',20),
  ('fire_extinguisher','Fire extinguisher','safety',30),
  ('first_aid','First aid kit','safety',40),
  ('exterior_cameras','Exterior security cameras','safety',50),
  ('life_jackets','Life jackets','safety',60),

  -- Internet & office
  ('wifi','Wifi','internet',10),
  ('dedicated_workspace','Dedicated workspace','internet',20),
  ('ethernet','Ethernet','internet',30),
  ('printer','Printer','internet',40),

  -- Kitchen & dining
  ('full_kitchen','Full kitchen','kitchen',10),
  ('kitchenette','Kitchenette','kitchen',20),
  ('refrigerator','Refrigerator','kitchen',30),
  ('microwave','Microwave','kitchen',40),
  ('dishwasher','Dishwasher','kitchen',50),
  ('oven','Oven','kitchen',60),
  ('stove','Stove','kitchen',70),
  ('coffee_maker','Coffee maker','kitchen',80),
  ('toaster','Toaster','kitchen',90),
  ('blender','Blender','kitchen',100),
  ('dishes_utensils','Dishes & utensils','kitchen',110),
  ('cooking_basics','Cooking basics','kitchen',120),
  ('wine_glasses','Wine glasses','kitchen',130),
  ('dining_table','Dining table','kitchen',140),

  -- Location features
  ('gulf_front','Gulf front','location',10),
  ('beach_access','Private beach access','location',20),
  ('waterfront','Waterfront','location',30),
  ('boat_slip','Boat slip','location',40),
  ('lake_access','Lake access','location',50),
  ('golf_course_view','Golf course view','location',60),
  ('resort_access','Resort access','location',70),

  -- Outdoor
  ('outdoor_pool','Outdoor pool','outdoor',10),
  ('indoor_pool','Indoor pool','outdoor',20),
  ('heated_pool','Heated pool','outdoor',30),
  ('private_pool','Private pool','outdoor',40),
  ('lazy_river','Lazy river','outdoor',50),
  ('hot_tub','Hot tub','outdoor',60),
  ('grill','BBQ grill','outdoor',70),
  ('patio','Patio or balcony','outdoor',80),
  ('outdoor_furniture','Outdoor furniture','outdoor',90),
  ('fire_pit','Fire pit','outdoor',100),
  ('tennis','Tennis court','outdoor',110),
  ('pickleball','Pickleball court','outdoor',120),
  ('playground','Playground','outdoor',130),

  -- Parking & facilities
  ('free_parking','Free parking','parking',10),
  ('covered_parking','Covered parking','parking',20),
  ('garage','Garage','parking',30),
  ('ev_charger','EV charger','parking',40),
  ('elevator','Elevator','parking',50),
  ('gym','Fitness centre','parking',60),
  ('sauna','Sauna','parking',70),
  ('gated_entry','Gated entry','parking',80),
  ('conference_room','Conference room','parking',90),

  -- Services
  ('self_checkin','Self check-in','services',10),
  ('keypad','Keypad entry','services',20),
  ('front_desk','Front desk','services',30),
  ('housekeeping','Housekeeping','services',40),
  ('luggage_dropoff','Luggage drop-off','services',50),
  ('beach_service','Beach chair service','services',60),
  ('concierge','Concierge','services',70),
  ('onsite_restaurant','On-site restaurant','services',80),
  ('bar','Bar','services',90),
  ('long_term_stays','Long-term stays allowed','services',100),

  -- Accessibility
  ('step_free_entry','Step-free entrance','accessibility',10),
  ('wide_doorway','Wide doorway','accessibility',20),
  ('roll_in_shower','Roll-in shower','accessibility',30),
  ('grab_bars','Shower grab bars','accessibility',40),
  ('accessible_parking','Accessible parking','accessibility',50),

  -- On the boat
  ('boat_head','Head (toilet)','vessel',10),
  ('boat_ac','Air conditioning','vessel',20),
  ('boat_cabin','Enclosed cabin','vessel',30),
  ('boat_shade','Shade / T-top','vessel',40),
  ('boat_galley','Galley','vessel',50),
  ('boat_livewell','Livewell','vessel',60),
  ('boat_fishfinder','Fish finder / sonar','vessel',70),
  ('boat_radar','Radar','vessel',80),
  ('boat_outriggers','Outriggers','vessel',90),
  ('boat_fighting_chair','Fighting chair','vessel',100),
  ('boat_stereo','Stereo','vessel',110),
  ('boat_cooler','Cooler','vessel',120),
  ('boat_bimini','Bimini top','vessel',130),
  ('boat_ladder','Swim ladder','vessel',140),

  -- Beach & water
  ('beach_chairs','Beach chairs','beach',10),
  ('beach_umbrella','Beach umbrella','beach',20),
  ('kayaks','Kayaks','beach',30),
  ('paddleboards','Paddleboards','beach',40),
  ('snorkel_gear','Snorkel gear','beach',50),
  ('fishing_gear','Fishing gear','beach',60),
  ('bikes','Bicycles','beach',70)
on conflict (key) do nothing;

/* ── fish species ────────────────────────────────────────────────────── */
-- Seasons are months. Red snapper's federal season moves every year, so the
-- months here are the usual window and not a legal reference.

insert into public.fish_species (key, label, category, season_start, season_end, sort_order) values
  ('red_snapper','Red snapper','reef',6,8,10),
  ('vermilion_snapper','Vermilion snapper','reef',1,12,20),
  ('grouper','Grouper','reef',6,12,30),
  ('amberjack','Amberjack','reef',5,10,40),
  ('triggerfish','Triggerfish','reef',3,12,50),
  ('king_mackerel','King mackerel','pelagic',4,11,60),
  ('spanish_mackerel','Spanish mackerel','pelagic',4,10,70),
  ('cobia','Cobia','pelagic',3,6,80),
  ('tuna','Tuna','pelagic',1,12,90),
  ('mahi','Mahi mahi','pelagic',4,9,100),
  ('wahoo','Wahoo','pelagic',5,10,110),
  ('marlin','Marlin','pelagic',5,9,120),
  ('sailfish','Sailfish','pelagic',5,9,130),
  ('shark','Shark','pelagic',1,12,140),
  ('redfish','Redfish','inshore',1,12,150),
  ('speckled_trout','Speckled trout','inshore',1,12,160),
  ('flounder','Flounder','inshore',3,11,170),
  ('sheepshead','Sheepshead','inshore',1,4,180),
  ('tarpon','Tarpon','inshore',6,9,190),
  ('pompano','Pompano','inshore',3,10,200)
on conflict (key) do nothing;

/* ── watersport activities ───────────────────────────────────────────── */

insert into public.watersport_activities (key, label, sort_order) values
  ('parasailing','Parasailing',10),
  ('jet_ski','Jet ski',20),
  ('wave_runner','Wave runner',30),
  ('banana_boat','Banana boat',40),
  ('tubing','Tubing',50),
  ('kayak','Kayaking',60),
  ('paddleboard','Paddleboarding',70),
  ('snorkel','Snorkelling',80),
  ('scuba','Scuba diving',90),
  ('wakeboard','Wakeboarding',100),
  ('water_ski','Water skiing',110),
  ('flyboard','Flyboarding',120),
  ('kiteboard','Kiteboarding',130),
  ('surf_lesson','Surf lessons',140)
on conflict (key) do nothing;

do $$
declare a int; s int; w int;
begin
  select count(*) into a from public.amenities;
  select count(*) into s from public.fish_species;
  select count(*) into w from public.watersport_activities;
  raise notice 'seeded: % amenities in % sections, % species, % activities',
    a, (select count(*) from public.amenity_sections), s, w;
end $$;
