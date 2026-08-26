-- ============================================================
-- Devices — real Android phones on a Linux box, shown in the dashboard
--
-- The actual shape:
--
--   physical phone --USB--> Linux host --> Docker container (adb + scrcpy)
--                                                 |
--                                          streams the screen
--                                                 v
--                                             dashboard
--
-- A phone is never "provisioned". It is plugged in, and the host agent
-- reports it. The dashboard shows what the agent found, which is why there is
-- no create-device endpoint — only enrolment of a host, and heartbeats from it.
--
-- The serial is the phone's real identity: the same string `adb devices`
-- prints. A phone that moves to a different USB port, or is unplugged and
-- plugged back in, is still the same row.
--
-- Keyed by site_id like the rest of this API.
-- ============================================================

-- The Linux computer at the business, running Docker. One per location,
-- usually. It enrols once and then heartbeats.
CREATE TABLE IF NOT EXISTS device_host (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         text NOT NULL,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  status          text NOT NULL DEFAULT 'enrolling'
                    CHECK (status IN ('enrolling', 'online', 'offline', 'error')),
  -- Hash of the enrolment token. The plaintext is shown once, when the host
  -- is created, and pasted into the agent's config.
  token_hash      text NOT NULL,
  os              text,
  docker_version  text,
  agent_version   text,
  error_message   text,
  last_seen_at    timestamptz,
  enrolled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name),

  CONSTRAINT device_host_online_has_last_seen
    CHECK (status <> 'online' OR last_seen_at IS NOT NULL),
  CONSTRAINT device_host_error_has_message
    CHECK (status <> 'error' OR error_message IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS device_host_site_idx ON device_host (site_id);


-- A phone plugged into a host. Rows are created by the agent's heartbeat, not
-- by anyone clicking "add".
--
-- 'unauthorized' is a real adb state and the most common thing that goes
-- wrong: the cable is fine, the phone is listed, but nobody tapped "Allow USB
-- debugging" on its screen. Calling that offline sends people to reboot a
-- machine that is working.
CREATE TABLE IF NOT EXISTS device (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         text NOT NULL,
  host_id         uuid NOT NULL REFERENCES device_host (id) ON DELETE CASCADE,
  serial          text NOT NULL,
  label           text,
  model           text,
  manufacturer    text,
  android_version text,
  status          text NOT NULL DEFAULT 'detached'
                    CHECK (status IN ('attached', 'unauthorized', 'detached', 'error')),
  -- The scrcpy container on the host that is showing this phone, and where its
  -- screen is served from. Both are set by the agent once the container is up.
  container_ref   text,
  stream_url      text,
  error_message   text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,

  -- The same phone on the same host is one row, no matter how often it is
  -- unplugged.
  UNIQUE (host_id, serial),

  CONSTRAINT device_attached_has_last_seen
    CHECK (status <> 'attached' OR last_seen_at IS NOT NULL),
  CONSTRAINT device_error_has_message
    CHECK (status <> 'error' OR error_message IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS device_site_idx ON device (site_id);
CREATE INDEX IF NOT EXISTS device_host_idx ON device (host_id);


-- A time-boxed grant to watch or drive one phone. The dashboard opens one to
-- show the screen; it expires on its own so a forgotten tab does not hold a
-- phone open all night.
CREATE TABLE IF NOT EXISTS device_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  site_id      text NOT NULL,
  mode         text NOT NULL DEFAULT 'view' CHECK (mode IN ('view', 'control')),
  token_hash   text NOT NULL,
  started_by   text,
  expires_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_session_expires_after_start CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS device_session_device_idx ON device_session (device_id);

-- One live session per phone. A second viewer joins the one already open
-- rather than fighting it for the same screen.
CREATE UNIQUE INDEX IF NOT EXISTS device_session_one_live_per_device
  ON device_session (device_id)
  WHERE ended_at IS NULL;


-- What is installed on the phone and whether the business is signed in to it.
-- This is what makes "your Facebook is logged in, on your own phone, at your
-- own counter" something the owner can see.
CREATE TABLE IF NOT EXISTS device_app (
  device_id       uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  package_name    text NOT NULL,
  label           text,
  signed_in       boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  PRIMARY KEY (device_id, package_name)
);
