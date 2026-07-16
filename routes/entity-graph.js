const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const db = createClient(
  process.env.GCR_SUPABASE_URL,
  process.env.GCR_SUPABASE_SERVICE_KEY
);

const PUBLIC_ENTITY_FIELDS = [
  'id', 'slug', 'name', 'subtitle', 'description',
  'entity_type', 'entity_subtype', 'parent_entity_slug',
  'icon', 'hero_image_url