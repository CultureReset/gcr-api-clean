-- ============================================================
-- Devices — cloud Android, physical Android, browser, container
--
-- The one part of the platform that had no tables anywhere: a business's
-- own device, running in the cloud, visible from its dashboard.
--
-- Keyed by site_id like the rest of this API. A device belongs to exactly
-- one business and is never shared.
--
-- Nothing secret is stored here. container_ref points at the orchestrator's
-- resource, stream_url is where the screen is viewable, and a session token
-- is stored only as a hash — the plaintext is returned once and never again.
-- ============================================================

CREATE TABLE IF NOT EXISTS device (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        text NOT NULL,
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  kind           text NOT NULL
                   CHECK (kind IN ('android-cloud', 'android-physical', 'browser', 'container')),
  status         text NOT NULL DEFAULT 'provisioning'
                   CHECK (status IN ('provisioning', 'online', 'offline', 'error')),
  container_ref  text,
  stream_url     text,
  region         text,
  error_message  text,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name),

  -- A device that claims to be online must have checked in. Otherwise the
  -- dashboard shows a green dot for something that is not there.
  CONSTRAINT device_online_has_last_seen
    CHECK (status <> 'online' OR last_seen_at IS NOT NULL),

  -- A physical Android is attached to hardware somewhere; a cloud one is
  -- provisioned and must carry the orchestrator's reference.
  CONSTRAINT device_cloud_has_container_ref
    CHECK (kind <> 'android-cloud' OR status = 'provisioning' OR container_ref IS NOT NULL),

  -- An errored device has to say why.
  CONSTRAINT device_error_has_message
    CHECK (status <> 'error' OR error_message IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS device_site_idx ON device (site_id);
CREATE INDEX IF NOT EXISTS device_status_idx ON device (status);


-- A time-boxed grant to watch or drive one device. The dashboard opens one of
-- these to show the screen; it expires on its own so a forgotten tab does not
-- leave a device open forever.
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

-- One live session per device. A second viewer joins the existing session
-- rather than opening a competing one against the same screen.
CREATE UNIQUE INDEX IF NOT EXISTS device_session_one_live_per_device
  ON device_session (device_id)
  WHERE ended_at IS NULL;


-- What is installed on the device, and whether the business is signed in to it.
-- This is what makes "your Facebook is logged in on your own phone" visible.
CREATE TABLE IF NOT EXISTS device_app (
  device_id       uuid NOT NULL REFERENCES device (id) ON DELETE CASCADE,
  package_name    text NOT NULL,
  label           text,
  signed_in       boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  PRIMARY KEY (device_id, package_name)
);
